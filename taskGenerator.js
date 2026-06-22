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

async function generateTaskDates(plan, device, dateStr) {
  const existing = await db.get(
    'SELECT id FROM inspection_tasks WHERE plan_id = ? AND device_id = ? AND task_date = ?',
    plan.id, device.id, dateStr
  );
  if (existing) return null;

  let inspectorId = null;
  if (plan.inspector_ids) {
    try {
      const ids = JSON.parse(plan.inspector_ids);
      if (ids && ids.length > 0) {
        let minIdx = 0;
        const firstCnt = await db.get(`
          SELECT COUNT(*) as cnt FROM inspection_tasks WHERE inspector_id = ? AND task_date = ?
        `, ids[0], dateStr);
        let minCnt = firstCnt.cnt;
        for (let i = 1; i < ids.length; i++) {
          const c = await db.get(`
            SELECT COUNT(*) as cnt FROM inspection_tasks WHERE inspector_id = ? AND task_date = ?
          `, ids[i], dateStr);
          if (c.cnt < minCnt) { minCnt = c.cnt; minIdx = i; }
        }
        inspectorId = ids[minIdx];
      }
    } catch (e) {}
  }

  const info = await prepareAndRun(`
    INSERT INTO inspection_tasks (plan_id, device_id, task_date, inspector_id, status, skipped, skip_reason)
    VALUES (?, ?, ?, ?, 'pending', ?, ?)
  `, [plan.id, device.id, dateStr, inspectorId, 0, null]);
  return info.lastID;
}

async function generateTasksForPlan(planId, fromDate, toDate) {
  const plan = await db.get('SELECT * FROM inspection_plans WHERE id = ?', planId);
  if (!plan) return { created: 0, skipped: 0, reason: '计划不存在' };
  if (plan.paused) return { created: 0, skipped: 0, reason: '计划已暂停' };

  const start = fromDate || plan.start_date;
  const end = toDate || plan.end_date || addDays(formatDate(new Date()), 30);

  let cursor = start;
  const planDevices = await db.all(`
    SELECT d.* FROM devices d
    JOIN plan_devices pd ON pd.device_id = d.id
    WHERE pd.plan_id = ?
  `, planId);

  if (planDevices.length === 0) return { created: 0, skipped: 0, reason: '计划未关联设备' };

  let created = 0;
  let skipped = 0;

  while (cursor <= end) {
    let shouldSkip = false;
    let skipReason = null;

    const holidayFlag = await isHoliday(cursor);
    if (holidayFlag) {
      shouldSkip = true;
      skipReason = '节假日';
    } else if (plan.cycle === 'weekly') {
      const wd = getWeekday(cursor);
      const startWd = getWeekday(plan.start_date);
      if (wd !== startWd) shouldSkip = true;
    } else if (plan.cycle === 'monthly') {
      const sd = parseDate(plan.start_date);
      const cd = parseDate(cursor);
      if (cd.getDate() !== sd.getDate()) shouldSkip = true;
    }

    if (shouldSkip) {
      for (const dev of planDevices) {
        const existing = await db.get(
          'SELECT id FROM inspection_tasks WHERE plan_id = ? AND device_id = ? AND task_date = ?',
          plan.id, dev.id, cursor
        );
        if (!existing && skipReason) {
          await prepareAndRun(`
            INSERT INTO inspection_tasks (plan_id, device_id, task_date, inspector_id, status, skipped, skip_reason)
            VALUES (?, ?, ?, ?, 'skipped', 1, ?)
          `, [plan.id, dev.id, cursor, null, skipReason]);
          skipped++;
        }
      }
    } else {
      for (const dev of planDevices) {
        const id = await generateTaskDates(plan, dev, cursor);
        if (id) created++;
      }
    }

    const step = plan.cycle === 'daily' ? 1 : (plan.cycle === 'weekly' ? 7 : 30);
    cursor = addDays(cursor, step);
  }

  return { created, skipped, plan: plan.name };
}

async function generateAllTasks(fromDate, toDate) {
  const plans = await db.all('SELECT * FROM inspection_plans WHERE paused = 0');
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

async function togglePlan(planId, paused) {
  await db.run('UPDATE inspection_plans SET paused = ? WHERE id = ?', paused ? 1 : 0, planId);
  return db.get('SELECT * FROM inspection_plans WHERE id = ?', planId);
}

module.exports = {
  formatDate, parseDate, addDays, isHoliday,
  generateTasksForPlan, generateAllTasks, togglePlan,
  generateTaskDates
};
