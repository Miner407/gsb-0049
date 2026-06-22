const { db, prepareAndRun } = require('./db');
const { formatDate, addDays } = require('./taskGenerator');

async function submitInspection(taskId, userId, results, remark) {
  const task = await db.get('SELECT * FROM inspection_tasks WHERE id = ?', taskId);
  if (!task) throw new Error('任务不存在');
  if (task.status === 'submitted') throw new Error('任务已提交');
  if (task.skipped) throw new Error('任务已跳过');

  await db.run('BEGIN');
  try {
    await db.run(
      `UPDATE inspection_tasks SET status = 'submitted', submitted_at = CURRENT_TIMESTAMP, submitted_by = ?, remark = ? WHERE id = ?`,
      userId, remark || null, taskId
    );

    const anomalyIds = [];
    for (const r of results) {
      await prepareAndRun(
        'INSERT INTO task_results (task_id, point_id, point_name, result, evidence, remark) VALUES (?, ?, ?, ?, ?, ?)',
        [taskId, r.point_id || null, r.point_name, r.result, r.evidence || null, r.remark || null]
      );
      if (r.is_anomaly) {
        const level = r.anomaly_level || '一般';
        const deadlineDays = level === '严重' ? 3 : (level === '紧急' ? 1 : 7);
        const info = await prepareAndRun(
          `INSERT INTO anomalies (task_id, device_id, point_id, point_name, level, description, evidence, status, reporter_id, deadline)
           VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?)`,
          [taskId, task.device_id, r.point_id || null, r.point_name, level,
           r.anomaly_description || r.point_name + '巡检异常', r.evidence || null,
           userId, addDays(formatDate(new Date()), deadlineDays)]
        );
        anomalyIds.push(info.lastID);
      }
    }
    await db.run('COMMIT');
    return { taskId, anomalyIds };
  } catch (e) {
    await db.run('ROLLBACK');
    throw e;
  }
}

async function assignAnomaly(anomalyId, responsibleId) {
  const anomaly = await db.get('SELECT * FROM anomalies WHERE id = ?', anomalyId);
  if (!anomaly) throw new Error('异常不存在');

  await db.run("UPDATE anomalies SET status = 'assigned', responsible_id = ? WHERE id = ?", responsibleId, anomalyId);
  await prepareAndRun("INSERT INTO rectifications (anomaly_id, status, measure) VALUES (?, 'processing', '')", [anomalyId]);
  return db.get('SELECT * FROM anomalies WHERE id = ?', anomalyId);
}

async function submitRectification(anomalyId, handlerId, measure, evidence) {
  const anomaly = await db.get('SELECT * FROM anomalies WHERE id = ?', anomalyId);
  if (!anomaly) throw new Error('异常不存在');

  const rect = await db.get('SELECT * FROM rectifications WHERE anomaly_id = ? ORDER BY id DESC LIMIT 1', anomalyId);
  if (!rect) throw new Error('整改记录不存在');

  await db.run(
    `UPDATE rectifications SET handler_id = ?, measure = ?, evidence = ?, status = 'submitted', handled_at = CURRENT_TIMESTAMP WHERE id = ?`,
    handlerId, measure, evidence || null, rect.id
  );
  await db.run("UPDATE anomalies SET status = 'rechecking' WHERE id = ?", anomalyId);

  return {
    anomaly: await db.get('SELECT * FROM anomalies WHERE id = ?', anomalyId),
    rectification: await db.get('SELECT * FROM rectifications WHERE id = ?', rect.id)
  };
}

async function requestExtension(anomalyId, reason, days) {
  const anomaly = await db.get('SELECT * FROM anomalies WHERE id = ?', anomalyId);
  if (!anomaly) throw new Error('异常不存在');

  const rect = await db.get('SELECT * FROM rectifications WHERE anomaly_id = ? ORDER BY id DESC LIMIT 1', anomalyId);
  if (!rect) throw new Error('整改记录不存在');

  await db.run(
    'UPDATE rectifications SET extension_request = 1, extension_reason = ?, extension_days = ?, extension_approved = NULL WHERE id = ?',
    reason, days, rect.id
  );
  return db.get('SELECT * FROM rectifications WHERE id = ?', rect.id);
}

async function approveExtension(rectificationId, approved) {
  const rect = await db.get('SELECT * FROM rectifications WHERE id = ?', rectificationId);
  if (!rect) throw new Error('整改记录不存在');
  if (!rect.extension_request) throw new Error('未申请延期');

  await db.run('UPDATE rectifications SET extension_approved = ? WHERE id = ?', approved ? 1 : 0, rectificationId);

  if (approved) {
    const anomaly = await db.get('SELECT * FROM anomalies WHERE id = ?', rect.anomaly_id);
    if (anomaly && anomaly.deadline) {
      const newDeadline = addDays(anomaly.deadline, rect.extension_days || 0);
      await db.run('UPDATE anomalies SET deadline = ? WHERE id = ?', newDeadline, rect.anomaly_id);
    }
  }
  return db.get('SELECT * FROM rectifications WHERE id = ?', rectificationId);
}

async function recheckAnomaly(anomalyId, recheckerId, result, remark, evidence) {
  const anomaly = await db.get('SELECT * FROM anomalies WHERE id = ?', anomalyId);
  if (!anomaly) throw new Error('异常不存在');
  if (anomaly.status !== 'rechecking') throw new Error('异常不在复查阶段');

  const rect = await db.get('SELECT * FROM rectifications WHERE anomaly_id = ? ORDER BY id DESC LIMIT 1', anomalyId);
  if (!rect) throw new Error('整改记录不存在');

  const recheckInfo = await prepareAndRun(
    'INSERT INTO rechecks (anomaly_id, rectification_id, rechecker_id, result, remark, evidence) VALUES (?, ?, ?, ?, ?, ?)',
    [anomalyId, rect.id, recheckerId, result, remark || null, evidence || null]
  );

  if (result === 'pass') {
    await db.run("UPDATE anomalies SET status = 'closed' WHERE id = ?", anomalyId);
    await db.run("UPDATE rectifications SET status = 'closed' WHERE id = ?", rect.id);
  } else if (result === 'fail') {
    await db.run("UPDATE anomalies SET status = 'reject' WHERE id = ?", anomalyId);
    await db.run("UPDATE rectifications SET status = 'reject' WHERE id = ?", rect.id);
    await prepareAndRun("INSERT INTO rectifications (anomaly_id, status, measure) VALUES (?, 'processing', '')", [anomalyId]);
  }

  return {
    recheck: await db.get('SELECT * FROM rechecks WHERE id = ?', recheckInfo.lastID),
    anomaly: await db.get('SELECT * FROM anomalies WHERE id = ?', anomalyId)
  };
}

async function getOverdueAnomalies() {
  const today = formatDate(new Date());
  return db.all(`
    SELECT a.*, d.name as device_name, d.area, u.name as responsible_name
    FROM anomalies a
    JOIN devices d ON d.id = a.device_id
    LEFT JOIN users u ON u.id = a.responsible_id
    WHERE a.status NOT IN ('closed') AND a.deadline < ?
    ORDER BY a.deadline ASC
  `, today);
}

module.exports = {
  submitInspection,
  assignAnomaly,
  submitRectification,
  requestExtension,
  approveExtension,
  recheckAnomaly,
  getOverdueAnomalies
};
