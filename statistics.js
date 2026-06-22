const { db } = require('./db');
const { formatDate } = require('./taskGenerator');

async function getPlanCompletionRate(fromDate, toDate) {
  const from = fromDate || formatDate(new Date(Date.now() - 30 * 86400000));
  const to = toDate || formatDate(new Date());

  const total = await db.get(`
    SELECT COUNT(*) as cnt FROM inspection_tasks
    WHERE task_date BETWEEN ? AND ? AND skipped = 0
  `, from, to);

  const completed = await db.get(`
    SELECT COUNT(*) as cnt FROM inspection_tasks
    WHERE task_date BETWEEN ? AND ? AND status = 'submitted' AND skipped = 0
  `, from, to);

  return {
    from, to, total: total.cnt, completed: completed.cnt,
    rate: total.cnt > 0 ? Math.round((completed.cnt / total.cnt) * 100) : 0
  };
}

async function getAnomalyRate(fromDate, toDate) {
  const from = fromDate || formatDate(new Date(Date.now() - 30 * 86400000));
  const to = toDate || formatDate(new Date());

  const submittedTasks = await db.get(`
    SELECT COUNT(DISTINCT t.id) as cnt FROM inspection_tasks t
    WHERE t.task_date BETWEEN ? AND ? AND t.status = 'submitted'
  `, from, to);

  const anomalyTasks = await db.get(`
    SELECT COUNT(DISTINCT t.id) as cnt FROM inspection_tasks t
    JOIN anomalies a ON a.task_id = t.id
    WHERE t.task_date BETWEEN ? AND ?
  `, from, to);

  return {
    from, to,
    submittedTasks: submittedTasks.cnt,
    anomalyTasks: anomalyTasks.cnt,
    rate: submittedTasks.cnt > 0 ? Math.round(anomalyTasks.cnt / submittedTasks.cnt * 100) : 0
  };
}

async function getOverdueRectificationCount() {
  const today = formatDate(new Date());
  const row = await db.get(`
    SELECT COUNT(*) as cnt FROM anomalies
    WHERE status NOT IN ('closed') AND deadline < ?
  `, today);
  return row.cnt;
}

async function getRepeatAnomalyDevices() {
  return db.all(`
    SELECT d.id, d.code, d.name, d.area, d.type, COUNT(a.id) as anomaly_count
    FROM devices d
    JOIN anomalies a ON a.device_id = d.id
    GROUP BY d.id
    HAVING anomaly_count >= 2
    ORDER BY anomaly_count DESC
    LIMIT 10
  `);
}

async function getAreaRiskRanking() {
  return db.all(`
    SELECT d.area,
      COUNT(DISTINCT d.id) as device_count,
      COUNT(DISTINCT a.id) as anomaly_count,
      CASE WHEN COUNT(DISTINCT d.id) > 0 THEN
        ROUND(COUNT(DISTINCT a.id) * 1.0 / COUNT(DISTINCT d.id) * 100, 1) ELSE 0 END as risk_rate
    FROM devices d
    LEFT JOIN anomalies a ON a.device_id = d.id
    GROUP BY d.area
    ORDER BY risk_rate DESC
  `);
}

async function getInspectorWorkload(fromDate, toDate) {
  const from = fromDate || formatDate(new Date(Date.now() - 30 * 86400000));
  const to = toDate || formatDate(new Date());
  return db.all(`
    SELECT u.id, u.name,
      COUNT(t.id) as total_tasks,
      SUM(CASE WHEN t.status = 'submitted' THEN 1 ELSE 0 END) as completed_tasks,
      SUM(CASE WHEN t.status = 'pending' AND t.skipped = 0 THEN 1 ELSE 0 END) as pending_tasks
    FROM users u
    LEFT JOIN inspection_tasks t ON t.inspector_id = u.id AND t.task_date BETWEEN ? AND ?
    WHERE u.role = 'inspector' OR u.role = 'admin'
    GROUP BY u.id
    ORDER BY total_tasks DESC
  `, from, to);
}

async function getDashboardStats() {
  return {
    planCompletion: await getPlanCompletionRate(),
    anomalyRate: await getAnomalyRate(),
    overdueCount: await getOverdueRectificationCount(),
    repeatDevices: await getRepeatAnomalyDevices(),
    areaRanking: await getAreaRiskRanking(),
    workload: await getInspectorWorkload()
  };
}

module.exports = {
  getPlanCompletionRate,
  getAnomalyRate,
  getOverdueRectificationCount,
  getRepeatAnomalyDevices,
  getAreaRiskRanking,
  getInspectorWorkload,
  getDashboardStats
};
