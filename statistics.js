const { db } = require('./db');
const { formatDate } = require('./taskGenerator');

function buildFilterSql(filters = {}) {
  const sql = [];
  const params = [];
  if (filters.area) {
    sql.push('d.area = ?');
    params.push(filters.area);
  }
  if (filters.device_type) {
    sql.push('d.type = ?');
    params.push(filters.device_type);
  }
  if (filters.plan_id) {
    sql.push('t.plan_id = ?');
    params.push(parseInt(filters.plan_id));
  }
  if (filters.inspector_id) {
    sql.push('t.inspector_id = ?');
    params.push(parseInt(filters.inspector_id));
  }
  return { where: sql.length ? ' AND ' + sql.join(' AND ') : '', params };
}

async function getPlanCompletionRate(fromDate, toDate, filters = {}) {
  const from = fromDate || formatDate(new Date(Date.now() - 30 * 86400000));
  const to = toDate || formatDate(new Date());
  const { where, params } = buildFilterSql(filters);

  const total = await db.get(`
    SELECT COUNT(*) as cnt FROM inspection_tasks t
    JOIN devices d ON d.id = t.device_id
    WHERE t.task_date BETWEEN ? AND ? AND t.skipped = 0${where}
  `, from, to, ...params);

  const completed = await db.get(`
    SELECT COUNT(*) as cnt FROM inspection_tasks t
    JOIN devices d ON d.id = t.device_id
    WHERE t.task_date BETWEEN ? AND ? AND t.status = 'submitted' AND t.skipped = 0${where}
  `, from, to, ...params);

  return {
    from, to, total: total.cnt, completed: completed.cnt,
    rate: total.cnt > 0 ? Math.round((completed.cnt / total.cnt) * 100) : 0
  };
}

async function getAnomalyRate(fromDate, toDate, filters = {}) {
  const from = fromDate || formatDate(new Date(Date.now() - 30 * 86400000));
  const to = toDate || formatDate(new Date());
  const { where, params } = buildFilterSql(filters);

  const submittedTasks = await db.get(`
    SELECT COUNT(DISTINCT t.id) as cnt FROM inspection_tasks t
    JOIN devices d ON d.id = t.device_id
    WHERE t.task_date BETWEEN ? AND ? AND t.status = 'submitted'${where}
  `, from, to, ...params);

  const anomalyTasks = await db.get(`
    SELECT COUNT(DISTINCT t.id) as cnt FROM inspection_tasks t
    JOIN devices d ON d.id = t.device_id
    JOIN anomalies a ON a.task_id = t.id
    WHERE t.task_date BETWEEN ? AND ?${where}
  `, from, to, ...params);

  return {
    from, to,
    submittedTasks: submittedTasks.cnt,
    anomalyTasks: anomalyTasks.cnt,
    rate: submittedTasks.cnt > 0 ? Math.round(anomalyTasks.cnt / submittedTasks.cnt * 100) : 0
  };
}

async function getOverdueRectificationCount(filters = {}) {
  const today = formatDate(new Date());
  const { where, params } = buildFilterSql(filters);

  const row = await db.get(`
    SELECT COUNT(*) as cnt FROM anomalies a
    JOIN devices d ON d.id = a.device_id
    WHERE a.status NOT IN ('closed') AND a.deadline < ?${where}
  `, today, ...params);
  return row.cnt;
}

async function getRepeatAnomalyDevices(filters = {}) {
  const { where, params } = buildFilterSql(filters);
  const limit = filters.limit ? parseInt(filters.limit) : 10;

  return db.all(`
    SELECT d.id, d.code, d.name, d.area, d.type, COUNT(a.id) as anomaly_count
    FROM devices d
    JOIN anomalies a ON a.device_id = d.id
    WHERE 1=1${where}
    GROUP BY d.id
    HAVING anomaly_count >= 2
    ORDER BY anomaly_count DESC
    LIMIT ?
  `, ...params, limit);
}

async function getAreaRiskRanking(filters = {}) {
  const { where, params } = buildFilterSql(filters);

  return db.all(`
    SELECT d.area,
      COUNT(DISTINCT d.id) as device_count,
      COUNT(DISTINCT a.id) as anomaly_count,
      CASE WHEN COUNT(DISTINCT d.id) > 0 THEN
        ROUND(COUNT(DISTINCT a.id) * 1.0 / COUNT(DISTINCT d.id) * 100, 1) ELSE 0 END as risk_rate
    FROM devices d
    LEFT JOIN anomalies a ON a.device_id = d.id
    WHERE 1=1${where}
    GROUP BY d.area
    ORDER BY risk_rate DESC
  `, ...params);
}

async function getInspectorWorkload(fromDate, toDate, filters = {}) {
  const from = fromDate || formatDate(new Date(Date.now() - 30 * 86400000));
  const to = toDate || formatDate(new Date());
  const roleFilter = filters.role ? ' AND u.role = ?' : '';
  const params = [from, to];
  if (filters.role) params.push(filters.role);

  return db.all(`
    SELECT u.id, u.name, u.role,
      COUNT(t.id) as total_tasks,
      SUM(CASE WHEN t.status = 'submitted' THEN 1 ELSE 0 END) as completed_tasks,
      SUM(CASE WHEN t.status = 'pending' AND t.skipped = 0 THEN 1 ELSE 0 END) as pending_tasks,
      SUM(CASE WHEN t.skipped = 1 THEN 1 ELSE 0 END) as skipped_tasks
    FROM users u
    LEFT JOIN inspection_tasks t ON t.inspector_id = u.id AND t.task_date BETWEEN ? AND ?
    WHERE (u.role = 'inspector' OR u.role = 'admin' OR u.role = 'manager')${roleFilter}
    GROUP BY u.id
    ORDER BY total_tasks DESC
  `, ...params);
}

async function getTrendData(fromDate, toDate, filters = {}) {
  const from = fromDate || formatDate(new Date(Date.now() - 30 * 86400000));
  const to = toDate || formatDate(new Date());
  const type = filters.type || 'completion';
  const { where, params } = buildFilterSql(filters);

  const dailyData = [];
  const start = new Date(from);
  const end = new Date(to);

  for (let d = new Date(start); d <= end; d.setDate(d.getDate() + 1)) {
    const dateStr = formatDate(d);
    dailyData.push({ date: dateStr });
  }

  if (type === 'completion') {
    const tasks = await db.all(`
      SELECT t.task_date,
        COUNT(*) as total,
        SUM(CASE WHEN t.status = 'submitted' THEN 1 ELSE 0 END) as completed
      FROM inspection_tasks t
      JOIN devices d ON d.id = t.device_id
      WHERE t.task_date BETWEEN ? AND ? AND t.skipped = 0${where}
      GROUP BY t.task_date
      ORDER BY t.task_date
    `, from, to, ...params);

    const taskMap = {};
    tasks.forEach(t => { taskMap[t.task_date] = t; });

    dailyData.forEach(d => {
      const t = taskMap[d.date] || { total: 0, completed: 0 };
      d.total_tasks = t.total;
      d.completed_tasks = t.completed;
      d.rate = t.total > 0 ? Math.round(t.completed / t.total * 100) : 0;
    });
  } else if (type === 'anomaly') {
    const anomalies = await db.all(`
      SELECT DATE(a.reported_at) as report_date, COUNT(*) as count
      FROM anomalies a
      JOIN devices d ON d.id = a.device_id
      WHERE DATE(a.reported_at) BETWEEN ? AND ?${where}
      GROUP BY DATE(a.reported_at)
      ORDER BY report_date
    `, from, to, ...params);

    const anomalyMap = {};
    anomalies.forEach(a => { anomalyMap[a.report_date] = a.count; });

    dailyData.forEach(d => {
      d.anomaly_count = anomalyMap[d.date] || 0;
    });
  } else if (type === 'overdue') {
    const today = new Date();
    dailyData.forEach(d => {
      const dDate = new Date(d.date);
      if (dDate <= today) {
        dailyData.forEach(async () => {});
      }
    });

    const overdueByDate = await db.all(`
      SELECT DATE(a.deadline) as deadline_date, COUNT(*) as count
      FROM anomalies a
      JOIN devices d ON d.id = a.device_id
      WHERE a.status NOT IN ('closed') AND DATE(a.deadline) BETWEEN ? AND ?${where}
      GROUP BY DATE(a.deadline)
      ORDER BY deadline_date
    `, from, to, ...params);

    const overdueMap = {};
    overdueByDate.forEach(o => { overdueMap[o.deadline_date] = o.count; });

    dailyData.forEach(d => {
      d.overdue_count = overdueMap[d.date] || 0;
    });
  }

  return { from, to, type, data: dailyData };
}

async function getLevelDistribution(fromDate, toDate, filters = {}) {
  const from = fromDate || formatDate(new Date(Date.now() - 30 * 86400000));
  const to = toDate || formatDate(new Date());
  const { where, params } = buildFilterSql(filters);

  const result = await db.all(`
    SELECT a.level, COUNT(*) as count
    FROM anomalies a
    JOIN devices d ON d.id = a.device_id
    WHERE DATE(a.reported_at) BETWEEN ? AND ?${where}
    GROUP BY a.level
    ORDER BY count DESC
  `, from, to, ...params);

  const levels = ['紧急', '严重', '一般', '轻微'];
  const distribution = {};
  levels.forEach(l => { distribution[l] = 0; });

  let total = 0;
  result.forEach(r => {
    distribution[r.level] = r.count;
    total += r.count;
  });

  return {
    from, to,
    total,
    distribution,
    list: levels.map(l => ({ level: l, count: distribution[l], percentage: total > 0 ? Math.round(distribution[l] / total * 100) : 0 }))
  };
}

async function getDashboardStats(filters = {}) {
  const today = formatDate(new Date());
  const thirtyDaysAgo = formatDate(new Date(Date.now() - 30 * 86400000));

  const todayPending = await db.get(`
    SELECT COUNT(*) as cnt FROM inspection_tasks t
    WHERE t.task_date = ? AND t.status = 'pending' AND t.skipped = 0
  `, today);

  const todayTasks = await db.all(`
    SELECT t.*, p.name as plan_name, d.name as device_name, d.area, u.name as inspector_name
    FROM inspection_tasks t
    LEFT JOIN inspection_plans p ON p.id = t.plan_id
    JOIN devices d ON d.id = t.device_id
    LEFT JOIN users u ON u.id = t.inspector_id
    WHERE t.task_date = ? AND t.status = 'pending' AND t.skipped = 0
    ORDER BY t.id LIMIT 10
  `, today);

  const pendingRecheck = await db.get(`
    SELECT COUNT(*) as cnt FROM anomalies WHERE status = 'rechecking'
  `);

  const recheckList = await db.all(`
    SELECT a.*, d.name as device_name, d.area, u.name as responsible_name
    FROM anomalies a
    JOIN devices d ON d.id = a.device_id
    LEFT JOIN users u ON u.id = a.responsible_id
    WHERE a.status = 'rechecking'
    ORDER BY a.id DESC LIMIT 10
  `);

  const topRiskAreas = await getAreaRiskRanking(filters);

  return {
    planCompletion: await getPlanCompletionRate(thirtyDaysAgo, today, filters),
    anomalyRate: await getAnomalyRate(thirtyDaysAgo, today, filters),
    overdueCount: await getOverdueRectificationCount(filters),
    repeatDevices: await getRepeatAnomalyDevices({ ...filters, limit: 10 }),
    areaRanking: topRiskAreas,
    workload: await getInspectorWorkload(thirtyDaysAgo, today, filters),
    todayPending: todayPending.cnt,
    todayTasks,
    pendingRecheck: pendingRecheck.cnt,
    recheckList,
    topRiskArea: topRiskAreas[0] || null
  };
}

module.exports = {
  getPlanCompletionRate,
  getAnomalyRate,
  getOverdueRectificationCount,
  getRepeatAnomalyDevices,
  getAreaRiskRanking,
  getInspectorWorkload,
  getDashboardStats,
  getTrendData,
  getLevelDistribution
};
