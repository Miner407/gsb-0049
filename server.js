const express = require('express');
const cors = require('cors');
const path = require('path');
const bodyParser = require('body-parser');
const { db, init, prepareAndRun } = require('./db');
const { generateTasksForPlan, generateAllTasks, togglePlan, formatDate } = require('./taskGenerator');
const anomalyFlow = require('./anomalyFlow');
const stats = require('./statistics');

const app = express();
app.use(cors());
app.use(bodyParser.json({ limit: '10mb' }));
app.use(express.static(path.join(__dirname, 'public')));

app.use((req, res, next) => {
  console.log(`[${new Date().toISOString()}] ${req.method} ${req.url}`);
  next();
});

app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', time: new Date().toISOString() });
});

app.get('/api/users', async (req, res) => {
  const users = await db.all('SELECT * FROM users ORDER BY id');
  res.json(users);
});

app.get('/api/devices', async (req, res) => {
  const { area, type, keyword } = req.query;
  let sql = 'SELECT * FROM devices WHERE 1=1';
  const params = [];
  if (area) { sql += ' AND area = ?'; params.push(area); }
  if (type) { sql += ' AND type = ?'; params.push(type); }
  if (keyword) { sql += ' AND (name LIKE ? OR code LIKE ?)'; params.push(`%${keyword}%`, `%${keyword}%`); }
  sql += ' ORDER BY id DESC';
  const devices = await db.all(sql, ...params);
  for (const d of devices) {
    d.points = await db.all('SELECT * FROM inspection_points WHERE device_id = ? ORDER BY sort_order', d.id);
    d.anomaly_count = (await db.get('SELECT COUNT(*) as cnt FROM anomalies WHERE device_id = ?', d.id)).cnt;
  }
  res.json(devices);
});

app.get('/api/devices/areas', async (req, res) => {
  const areas = (await db.all('SELECT DISTINCT area FROM devices ORDER BY area')).map(r => r.area);
  const types = (await db.all('SELECT DISTINCT type FROM devices ORDER BY type')).map(r => r.type);
  res.json({ areas, types });
});

app.get('/api/devices/:id', async (req, res) => {
  const device = await db.get('SELECT * FROM devices WHERE id = ?', req.params.id);
  if (!device) return res.status(404).json({ error: '设备不存在' });
  device.points = await db.all('SELECT * FROM inspection_points WHERE device_id = ? ORDER BY sort_order', device.id);
  device.anomalies = await db.all(`
    SELECT a.*, u.name as reporter_name FROM anomalies a
    LEFT JOIN users u ON u.id = a.reporter_id
    WHERE a.device_id = ? ORDER BY a.id DESC
  `, device.id);
  device.tasks = await db.all(`
    SELECT t.*, p.name as plan_name FROM inspection_tasks t
    LEFT JOIN inspection_plans p ON p.id = t.plan_id
    WHERE t.device_id = ? ORDER BY t.task_date DESC LIMIT 20
  `, device.id);
  res.json(device);
});

app.post('/api/devices', async (req, res) => {
  const { code, name, type, area, status, install_date, description, points } = req.body;
  const info = await prepareAndRun(
    'INSERT INTO devices (code, name, type, area, status, install_date, description) VALUES (?, ?, ?, ?, ?, ?, ?)',
    [code, name, type, area, status || '正常', install_date || null, description || null]
  );
  if (points && Array.isArray(points)) {
    for (let i = 0; i < points.length; i++) {
      const p = points[i];
      await prepareAndRun(
        'INSERT INTO inspection_points (device_id, name, standard, method, sort_order) VALUES (?, ?, ?, ?, ?)',
        [info.lastInsertRowid, p.name, p.standard || null, p.method || null, i + 1]
      );
    }
  }
  res.json({ id: info.lastInsertRowid });
});

app.get('/api/templates', async (req, res) => {
  const templates = await db.all('SELECT * FROM inspection_templates ORDER BY id DESC');
  for (const t of templates) {
    t.points = await db.all('SELECT * FROM template_points WHERE template_id = ? ORDER BY sort_order', t.id);
  }
  res.json(templates);
});

app.get('/api/plans', async (req, res) => {
  const { area, paused } = req.query;
  let sql = 'SELECT * FROM inspection_plans WHERE 1=1';
  const params = [];
  if (area) { sql += ' AND (area = ? OR area IS NULL)'; params.push(area); }
  if (paused !== undefined) { sql += ' AND paused = ?'; params.push(paused === 'true' ? 1 : 0); }
  sql += ' ORDER BY id DESC';
  const plans = await db.all(sql, ...params);
  for (const p of plans) {
    try { p.inspector_list = JSON.parse(p.inspector_ids || '[]'); } catch (e) { p.inspector_list = []; }
    p.device_count = (await db.get('SELECT COUNT(*) as cnt FROM plan_devices WHERE plan_id = ?', p.id)).cnt;
    p.task_count = (await db.get('SELECT COUNT(*) as cnt FROM inspection_tasks WHERE plan_id = ?', p.id)).cnt;
    if (p.template_id) {
      const tmpl = await db.get('SELECT name FROM inspection_templates WHERE id = ?', p.template_id);
      p.template_name = tmpl ? tmpl.name : null;
    }
  }
  res.json(plans);
});

app.get('/api/plans/calendar', async (req, res) => {
  const { from, to, area } = req.query;
  const start = from || formatDate(new Date(Date.now() - 7 * 86400000));
  const end = to || formatDate(new Date(Date.now() + 30 * 86400000));
  let sql = `
    SELECT t.*, p.name as plan_name, d.name as device_name, d.area, d.type as device_type, u.name as inspector_name
    FROM inspection_tasks t
    LEFT JOIN inspection_plans p ON p.id = t.plan_id
    JOIN devices d ON d.id = t.device_id
    LEFT JOIN users u ON u.id = t.inspector_id
    WHERE t.task_date BETWEEN ? AND ?
  `;
  const params = [start, end];
  if (area) { sql += ' AND d.area = ?'; params.push(area); }
  sql += ' ORDER BY t.task_date, t.id';
  const tasks = await db.all(sql, ...params);
  res.json({ from: start, to: end, tasks });
});

app.get('/api/plans/:id', async (req, res) => {
  const plan = await db.get('SELECT * FROM inspection_plans WHERE id = ?', req.params.id);
  if (!plan) return res.status(404).json({ error: '计划不存在' });
  try { plan.inspector_list = JSON.parse(plan.inspector_ids || '[]'); } catch (e) { plan.inspector_list = []; }
  plan.devices = await db.all(`
    SELECT d.* FROM devices d
    JOIN plan_devices pd ON pd.device_id = d.id
    WHERE pd.plan_id = ? ORDER BY d.id
  `, plan.id);
  plan.template = plan.template_id ? await db.get('SELECT * FROM inspection_templates WHERE id = ?', plan.template_id) : null;
  if (plan.template) {
    plan.template.points = await db.all('SELECT * FROM template_points WHERE template_id = ? ORDER BY sort_order', plan.template_id);
  }
  res.json(plan);
});

app.post('/api/plans', async (req, res) => {
  const { name, device_type, area, template_id, cycle, cycle_days, start_date, end_date, inspector_ids, description, device_ids } = req.body;
  const info = await prepareAndRun(
    `INSERT INTO inspection_plans (name, device_type, area, template_id, cycle, cycle_days, start_date, end_date, inspector_ids, description)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [name, device_type || null, area || null, template_id || null, cycle, cycle_days || 1,
     start_date, end_date || null, JSON.stringify(inspector_ids || []), description || null]
  );
  if (device_ids && Array.isArray(device_ids)) {
    for (const did of device_ids) {
      await prepareAndRun('INSERT OR IGNORE INTO plan_devices (plan_id, device_id) VALUES (?, ?)', [info.lastInsertRowid, did]);
    }
  }
  res.json({ id: info.lastInsertRowid });
});

app.post('/api/plans/:id/generate', async (req, res) => {
  const { from, to } = req.body;
  const result = await generateTasksForPlan(parseInt(req.params.id), from, to);
  res.json(result);
});

app.post('/api/plans/:id/toggle', async (req, res) => {
  const { paused } = req.body;
  const plan = await togglePlan(parseInt(req.params.id), paused);
  res.json(plan);
});

app.post('/api/tasks/generate-all', async (req, res) => {
  const { from, to } = req.body;
  const result = await generateAllTasks(from, to);
  res.json(result);
});

app.get('/api/tasks', async (req, res) => {
  const { status, inspector_id, area, from, to } = req.query;
  let sql = `
    SELECT t.*, p.name as plan_name, d.name as device_name, d.area, d.type as device_type, u.name as inspector_name
    FROM inspection_tasks t
    LEFT JOIN inspection_plans p ON p.id = t.plan_id
    JOIN devices d ON d.id = t.device_id
    LEFT JOIN users u ON u.id = t.inspector_id
    WHERE 1=1
  `;
  const params = [];
  if (status) { sql += ' AND t.status = ?'; params.push(status); }
  if (inspector_id) { sql += ' AND t.inspector_id = ?'; params.push(inspector_id); }
  if (area) { sql += ' AND d.area = ?'; params.push(area); }
  if (from) { sql += ' AND t.task_date >= ?'; params.push(from); }
  if (to) { sql += ' AND t.task_date <= ?'; params.push(to); }
  sql += ' ORDER BY t.task_date DESC, t.id DESC LIMIT 200';
  const tasks = await db.all(sql, ...params);
  res.json(tasks);
});

app.get('/api/tasks/:id', async (req, res) => {
  const task = await db.get(`
    SELECT t.*, p.name as plan_name, d.name as device_name, d.code as device_code, d.area,
      u.name as inspector_name, sb.name as submitter_name
    FROM inspection_tasks t
    LEFT JOIN inspection_plans p ON p.id = t.plan_id
    JOIN devices d ON d.id = t.device_id
    LEFT JOIN users u ON u.id = t.inspector_id
    LEFT JOIN users sb ON sb.id = t.submitted_by
    WHERE t.id = ?
  `, req.params.id);
  if (!task) return res.status(404).json({ error: '任务不存在' });
  task.points = await db.all('SELECT * FROM inspection_points WHERE device_id = ? ORDER BY sort_order', task.device_id);
  task.results = await db.all('SELECT * FROM task_results WHERE task_id = ?', task.id);
  task.anomalies = await db.all('SELECT a.* FROM anomalies a WHERE a.task_id = ?', task.id);
  for (const a of task.anomalies) {
    a.rectifications = await db.all('SELECT * FROM rectifications WHERE anomaly_id = ? ORDER BY id', a.id);
    a.rechecks = await db.all('SELECT * FROM rechecks WHERE anomaly_id = ? ORDER BY id', a.id);
  }
  res.json(task);
});

app.post('/api/tasks/:id/submit', async (req, res) => {
  try {
    const { user_id, results, remark } = req.body;
    const result = await anomalyFlow.submitInspection(parseInt(req.params.id), user_id, results || [], remark);
    res.json(result);
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

app.get('/api/anomalies', async (req, res) => {
  const { status, level, area, device_id, overdue } = req.query;
  let sql = `
    SELECT a.*, d.name as device_name, d.code as device_code, d.area, d.type as device_type,
      u.name as reporter_name, ru.name as responsible_name
    FROM anomalies a
    JOIN devices d ON d.id = a.device_id
    LEFT JOIN users u ON u.id = a.reporter_id
    LEFT JOIN users ru ON ru.id = a.responsible_id
    WHERE 1=1
  `;
  const params = [];
  if (status) { sql += ' AND a.status = ?'; params.push(status); }
  if (level) { sql += ' AND a.level = ?'; params.push(level); }
  if (area) { sql += ' AND d.area = ?'; params.push(area); }
  if (device_id) { sql += ' AND a.device_id = ?'; params.push(device_id); }
  if (overdue === 'true') {
    const today = formatDate(new Date());
    sql += " AND a.deadline < ? AND a.status NOT IN ('closed')";
    params.push(today);
  }
  sql += ' ORDER BY a.id DESC LIMIT 200';
  const anomalies = await db.all(sql, ...params);
  const today = formatDate(new Date());
  anomalies.forEach(a => {
    a.is_overdue = a.status !== 'closed' && a.deadline && a.deadline < today;
  });
  res.json(anomalies);
});

app.get('/api/anomalies/:id', async (req, res) => {
  const anomaly = await db.get(`
    SELECT a.*, d.name as device_name, d.code as device_code, d.area,
      u.name as reporter_name, ru.name as responsible_name, t.task_date
    FROM anomalies a
    JOIN devices d ON d.id = a.device_id
    LEFT JOIN users u ON u.id = a.reporter_id
    LEFT JOIN users ru ON ru.id = a.responsible_id
    LEFT JOIN inspection_tasks t ON t.id = a.task_id
    WHERE a.id = ?
  `, req.params.id);
  if (!anomaly) return res.status(404).json({ error: '异常不存在' });
  anomaly.rectifications = await db.all(`
    SELECT r.*, u.name as handler_name
    FROM rectifications r LEFT JOIN users u ON u.id = r.handler_id
    WHERE r.anomaly_id = ? ORDER BY r.id
  `, anomaly.id);
  anomaly.rechecks = await db.all(`
    SELECT rc.*, u.name as rechecker_name
    FROM rechecks rc LEFT JOIN users u ON u.id = rc.rechecker_id
    WHERE rc.anomaly_id = ? ORDER BY rc.id
  `, anomaly.id);
  res.json(anomaly);
});

app.post('/api/anomalies/:id/assign', async (req, res) => {
  try {
    const { responsible_id } = req.body;
    const result = await anomalyFlow.assignAnomaly(parseInt(req.params.id), responsible_id);
    res.json(result);
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

app.post('/api/anomalies/:id/rectify', async (req, res) => {
  try {
    const { handler_id, measure, evidence } = req.body;
    const result = await anomalyFlow.submitRectification(parseInt(req.params.id), handler_id, measure, evidence);
    res.json(result);
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

app.post('/api/anomalies/:id/extension', async (req, res) => {
  try {
    const { reason, days } = req.body;
    const result = await anomalyFlow.requestExtension(parseInt(req.params.id), reason, days);
    res.json(result);
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

app.post('/api/rectifications/:id/approve-extension', async (req, res) => {
  try {
    const { approved } = req.body;
    const result = await anomalyFlow.approveExtension(parseInt(req.params.id), approved);
    res.json(result);
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

app.post('/api/anomalies/:id/recheck', async (req, res) => {
  try {
    const { rechecker_id, result, remark, evidence } = req.body;
    const r = await anomalyFlow.recheckAnomaly(parseInt(req.params.id), rechecker_id, result, remark, evidence);
    res.json(r);
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

app.get('/api/anomalies/overdue/list', async (req, res) => {
  const list = await anomalyFlow.getOverdueAnomalies();
  res.json(list);
});

app.get('/api/holidays', async (req, res) => {
  const holidays = await db.all('SELECT * FROM holidays ORDER BY date');
  res.json(holidays);
});

app.post('/api/holidays', async (req, res) => {
  const { date, name } = req.body;
  try {
    const info = await prepareAndRun('INSERT INTO holidays (date, name) VALUES (?, ?)', [date, name || null]);
    res.json({ id: info.lastInsertRowid });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

app.delete('/api/holidays/:id', async (req, res) => {
  await db.run('DELETE FROM holidays WHERE id = ?', req.params.id);
  res.json({ success: true });
});

app.get('/api/stats/dashboard', async (req, res) => {
  const data = await stats.getDashboardStats();
  res.json(data);
});

app.get('/api/stats/completion', async (req, res) => {
  const { from, to } = req.query;
  res.json(await stats.getPlanCompletionRate(from, to));
});

app.get('/api/stats/anomaly-rate', async (req, res) => {
  const { from, to } = req.query;
  res.json(await stats.getAnomalyRate(from, to));
});

app.get('/api/stats/area-risk', async (req, res) => {
  res.json(await stats.getAreaRiskRanking());
});

app.get('/api/stats/workload', async (req, res) => {
  const { from, to } = req.query;
  res.json(await stats.getInspectorWorkload(from, to));
});

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.use((err, req, res, next) => {
  console.error('Server error:', err.message);
  console.error(err.stack);
  res.status(500).json({ error: '服务器内部错误', message: err.message });
});

async function startServer() {
  await init();
  const PORT = process.env.PORT || 3000;
  app.listen(PORT, () => {
    console.log(`Server running on http://localhost:${PORT}`);
    console.log(`Public directory: ${path.join(__dirname, 'public')}`);
  });
}

startServer().catch(e => {
  console.error('Failed to start server:', e);
  process.exit(1);
});

module.exports = app;
