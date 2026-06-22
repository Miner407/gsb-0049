const { db, prepareAndRun } = require('./db');

function formatDate(d) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function parseDate(s) {
  const [y, m, d] = s.split('-').map(Number);
  return new Date(y, m - 1, d);
}

function addDays(dateStr, days) {
  const d = parseDate(dateStr);
  d.setDate(d.getDate() + days);
  return formatDate(d);
}

async function isHoliday(dateStr) {
  const row = await db.get('SELECT COUNT(*) as cnt FROM holidays WHERE date = ?', dateStr);
  return row.cnt > 0;
}

function getWeekday(dateStr) {
  return parseDate(dateStr).getDay();
}

function getDayOfMonth(dateStr) {
  return parseDate(dateStr).getDate();
}

function isSameDayOfMonth(dateStr, referenceDateStr) {
  return getDayOfMonth(dateStr) === getDayOfMonth(referenceDateStr);
}

function isSameWeekday(dateStr, referenceDateStr) {
  return getWeekday(dateStr) === getWeekday(referenceDateStr);
}

async function getLeastBusyInspector(inspectorIds, dateStr) {
  if (!inspectorIds || inspectorIds.length === 0) return null;

  let minIdx = 0;
  const firstCnt = await db.get(
    'SELECT COUNT(*) as cnt FROM inspection_tasks WHERE inspector_id = ? AND task_date = ?',
    inspectorIds[0], dateStr
  );
  let minCnt = firstCnt.cnt;

  for (let i = 1; i < inspectorIds.length; i++) {
    const c = await db.get(
      'SELECT COUNT(*) as cnt FROM inspection_tasks WHERE inspector_id = ? AND task_date = ?',
      inspectorIds[i], dateStr
    );
    if (c.cnt < minCnt) {
      minCnt = c.cnt;
      minIdx = i;
    }
  }
  return inspectorIds[minIdx];
}

function shouldGenerateOnDate(plan, dateStr) {
  if (plan.cycle === 'daily') {
    return true;
  } else if (plan.cycle === 'weekly') {
    return isSameWeekday(dateStr, plan.start_date);
  } else if (plan.cycle === 'monthly') {
    return isSameDayOfMonth(dateStr, plan.start_date);
  }
  return false;
}

async function generateTaskDates(plan, device, dateStr, skipType = null, skipReason = null) {
  const existing = await db.get(
    'SELECT id FROM inspection_tasks WHERE plan_id = ? AND device_id = ? AND task_date = ?',
    plan.id, device.id, dateStr
  );
  if (existing) return null;

  let inspectorId = null;
  if (plan.inspector_ids && !skipType) {
    try {
      const ids = JSON.parse(plan.inspector_ids);
      if (ids && ids.length > 0) {
        inspectorId = await getLeastBusyInspector(ids, dateStr);
      }
    } catch (e) {}
  }

  const skipped = skipType ? 1 : 0;
  const status = skipType ? 'skipped' : 'pending';

  const info = await prepareAndRun(`
    INSERT INTO inspection_tasks (plan_id, device_id, task_date, inspector_id, status, skipped, skip_reason, skip_type)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `, [plan.id, device.id, dateStr, inspectorId, status, skipped, skipReason, skipType]);

  return info.lastID;
}

async function computePlanTasks(planId, fromDate, toDate) {
  const plan = await db.get('SELECT * FROM inspection_plans WHERE id = ?', planId);
  if (!plan) return { plan: null, tasks: [], created: 0, skipped: 0 };

  const start = fromDate || plan.start_date;
  const end = toDate || plan.end_date || addDays(formatDate(new Date()), 30);

  const planDevices = await db.all(`
    SELECT d.* FROM devices d
    JOIN plan_devices pd ON pd.device_id = d.id
    WHERE pd.plan_id = ?
  `, planId);

  if (planDevices.length === 0) {
    return { plan, tasks: [], created: 0, skipped: 0, reason: '计划未关联设备' };
  }

  let inspectorIds = [];
  try {
    inspectorIds = JSON.parse(plan.inspector_ids || '[]');
  } catch (e) {}

  const tasks = [];
  let cursor = start;

  while (cursor <= end) {
    if (cursor < plan.start_date) {
      cursor = addDays(cursor, 1);
      continue;
    }
    if (plan.end_date && cursor > plan.end_date) {
      break;
    }

    if (plan.paused) {
      if (shouldGenerateOnDate(plan, cursor)) {
        for (const dev of planDevices) {
          tasks.push({
            plan_id: plan.id,
            plan_name: plan.name,
            device_id: dev.id,
            device_name: dev.name,
            device_code: dev.code,
            area: dev.area,
            device_type: dev.type,
            task_date: cursor,
            status: 'skipped',
            skipped: 1,
            skip_reason: plan.pause_reason || '计划暂停',
            skip_type: 'paused'
          });
        }
      }
      cursor = addDays(cursor, 1);
      continue;
    }

    if (!shouldGenerateOnDate(plan, cursor)) {
      cursor = addDays(cursor, 1);
      continue;
    }

    const holidayFlag = await isHoliday(cursor);
    const holidayStrategy = plan.holiday_strategy || 'skip';

    if (holidayFlag && holidayStrategy === 'skip') {
      for (const dev of planDevices) {
        tasks.push({
          plan_id: plan.id,
          plan_name: plan.name,
          device_id: dev.id,
          device_name: dev.name,
          device_code: dev.code,
          area: dev.area,
          device_type: dev.type,
          task_date: cursor,
          status: 'skipped',
          skipped: 1,
          skip_reason: '节假日',
          skip_type: 'holiday'
        });
      }
    } else {
      for (const dev of planDevices) {
        tasks.push({
          plan_id: plan.id,
          plan_name: plan.name,
          device_id: dev.id,
          device_name: dev.name,
          device_code: dev.code,
          area: dev.area,
          device_type: dev.type,
          task_date: cursor,
          status: 'pending',
          skipped: 0,
          skip_reason: null,
          skip_type: null
        });
      }
    }

    cursor = addDays(cursor, 1);
  }

  const created = tasks.filter(t => !t.skipped).length;
  const skipped = tasks.filter(t => t.skipped).length;

  return { plan, tasks, created, skipped };
}

async function previewTasksForPlan(planId, fromDate, toDate) {
  const result = await computePlanTasks(planId, fromDate, toDate);
  return {
    plan: result.plan ? {
      id: result.plan.id,
      name: result.plan.name,
      cycle: result.plan.cycle,
      paused: result.plan.paused,
      holiday_strategy: result.plan.holiday_strategy
    } : null,
    from: fromDate,
    to: toDate,
    total: result.tasks.length,
    created: result.created,
    skipped: result.skipped,
    tasks: result.tasks,
    reason: result.reason || null
  };
}

async function generateTasksForPlan(planId, fromDate, toDate) {
  const plan = await db.get('SELECT * FROM inspection_plans WHERE id = ?', planId);
  if (!plan) return { created: 0, skipped: 0, reason: '计划不存在' };

  const start = fromDate || plan.start_date;
  const end = toDate || plan.end_date || addDays(formatDate(new Date()), 30);

  const planDevices = await db.all(`
    SELECT d.* FROM devices d
    JOIN plan_devices pd ON pd.device_id = d.id
    WHERE pd.plan_id = ?
  `, planId);

  if (planDevices.length === 0) return { created: 0, skipped: 0, reason: '计划未关联设备' };

  let created = 0;
  let skipped = 0;
  let cursor = start;

  while (cursor <= end) {
    if (cursor < plan.start_date) {
      cursor = addDays(cursor, 1);
      continue;
    }
    if (plan.end_date && cursor > plan.end_date) {
      break;
    }

    if (plan.paused) {
      if (shouldGenerateOnDate(plan, cursor)) {
        for (const dev of planDevices) {
          const id = await generateTaskDates(plan, dev, cursor, 'paused', plan.pause_reason || '计划暂停');
          if (id) skipped++;
        }
      }
      cursor = addDays(cursor, 1);
      continue;
    }

    if (!shouldGenerateOnDate(plan, cursor)) {
      cursor = addDays(cursor, 1);
      continue;
    }

    const holidayFlag = await isHoliday(cursor);
    const holidayStrategy = plan.holiday_strategy || 'skip';

    if (holidayFlag && holidayStrategy === 'skip') {
      for (const dev of planDevices) {
        const id = await generateTaskDates(plan, dev, cursor, 'holiday', '节假日');
        if (id) skipped++;
      }
    } else {
      for (const dev of planDevices) {
        const id = await generateTaskDates(plan, dev, cursor);
        if (id) created++;
      }
    }

    cursor = addDays(cursor, 1);
  }

  return { created, skipped, plan: plan.name };
}

async function generateAllTasks(fromDate, toDate) {
  const plans = await db.all('SELECT * FROM inspection_plans');
  let totalCreated = 0;
  let totalSkipped = 0;
  const results = [];

  for (const p of plans) {
    const r = await generateTasksForPlan(p.id, fromDate, toDate);
    totalCreated += r.created;
    totalSkipped += r.skipped;
    results.push(r);
  }

  return { totalCreated, totalSkipped, details: results };
}

async function togglePlan(planId, paused, reason = null) {
  if (paused) {
    await db.run('UPDATE inspection_plans SET paused = 1, pause_reason = ? WHERE id = ?', reason || null, planId);
  } else {
    await db.run('UPDATE inspection_plans SET paused = 0, pause_reason = NULL WHERE id = ?', planId);
  }
  return db.get('SELECT * FROM inspection_plans WHERE id = ?', planId);
}

module.exports = {
  formatDate,
  parseDate,
  addDays,
  isHoliday,
  getWeekday,
  shouldGenerateOnDate,
  generateTasksForPlan,
  generateAllTasks,
  togglePlan,
  previewTasksForPlan,
  computePlanTasks
};
