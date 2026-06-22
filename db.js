const sqlite3 = require('sqlite3').verbose();
const path = require('path');
const { promisify } = require('util');

const dbPath = path.join(__dirname, 'inspection.db');
const db = new sqlite3.Database(dbPath);

db.run = promisify(db.run).bind(db);
db.get = promisify(db.get).bind(db);
db.all = promisify(db.all).bind(db);
db.exec = promisify(db.exec).bind(db);

async function prepareAndRun(sql, params = []) {
  return new Promise((resolve, reject) => {
    const stmt = db.prepare(sql);
    stmt.run(params, function(err) {
      if (err) reject(err);
      else resolve({ lastID: this.lastID, changes: this.changes });
      stmt.finalize();
    });
  });
}

db.prepareAndRun = prepareAndRun;

async function initDatabase() {
  await db.exec(`
    CREATE TABLE IF NOT EXISTS devices (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      code TEXT UNIQUE NOT NULL,
      name TEXT NOT NULL,
      type TEXT NOT NULL,
      area TEXT NOT NULL,
      status TEXT DEFAULT '正常',
      install_date TEXT,
      description TEXT,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS inspection_points (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      device_id INTEGER NOT NULL,
      name TEXT NOT NULL,
      standard TEXT,
      method TEXT,
      sort_order INTEGER DEFAULT 0,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (device_id) REFERENCES devices(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS inspection_templates (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      device_type TEXT,
      description TEXT,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS template_points (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      template_id INTEGER NOT NULL,
      point_name TEXT NOT NULL,
      standard TEXT,
      method TEXT,
      sort_order INTEGER DEFAULT 0,
      FOREIGN KEY (template_id) REFERENCES inspection_templates(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      username TEXT UNIQUE NOT NULL,
      name TEXT NOT NULL,
      role TEXT DEFAULT 'inspector',
      created_at TEXT DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS holidays (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      date TEXT UNIQUE NOT NULL,
      name TEXT,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS inspection_plans (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      device_type TEXT,
      area TEXT,
      template_id INTEGER,
      cycle TEXT NOT NULL,
      cycle_days INTEGER DEFAULT 1,
      start_date TEXT NOT NULL,
      end_date TEXT,
      inspector_ids TEXT,
      paused INTEGER DEFAULT 0,
      description TEXT,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (template_id) REFERENCES inspection_templates(id)
    );

    CREATE TABLE IF NOT EXISTS plan_devices (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      plan_id INTEGER NOT NULL,
      device_id INTEGER NOT NULL,
      FOREIGN KEY (plan_id) REFERENCES inspection_plans(id) ON DELETE CASCADE,
      FOREIGN KEY (device_id) REFERENCES devices(id) ON DELETE CASCADE,
      UNIQUE(plan_id, device_id)
    );

    CREATE TABLE IF NOT EXISTS inspection_tasks (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      plan_id INTEGER,
      device_id INTEGER NOT NULL,
      task_date TEXT NOT NULL,
      inspector_id INTEGER,
      status TEXT DEFAULT 'pending',
      submitted_at TEXT,
      submitted_by INTEGER,
      remark TEXT,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP,
      skipped INTEGER DEFAULT 0,
      skip_reason TEXT,
      FOREIGN KEY (plan_id) REFERENCES inspection_plans(id),
      FOREIGN KEY (device_id) REFERENCES devices(id),
      FOREIGN KEY (inspector_id) REFERENCES users(id)
    );

    CREATE TABLE IF NOT EXISTS task_results (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      task_id INTEGER NOT NULL,
      point_id INTEGER,
      point_name TEXT NOT NULL,
      result TEXT NOT NULL,
      evidence TEXT,
      remark TEXT,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (task_id) REFERENCES inspection_tasks(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS anomalies (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      task_id INTEGER NOT NULL,
      device_id INTEGER NOT NULL,
      point_id INTEGER,
      point_name TEXT,
      level TEXT NOT NULL,
      description TEXT NOT NULL,
      evidence TEXT,
      status TEXT DEFAULT 'pending',
      reporter_id INTEGER,
      reported_at TEXT DEFAULT CURRENT_TIMESTAMP,
      deadline TEXT,
      responsible_id INTEGER,
      FOREIGN KEY (task_id) REFERENCES inspection_tasks(id),
      FOREIGN KEY (device_id) REFERENCES devices(id)
    );

    CREATE TABLE IF NOT EXISTS rectifications (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      anomaly_id INTEGER NOT NULL,
      handler_id INTEGER,
      measure TEXT,
      evidence TEXT,
      status TEXT DEFAULT 'processing',
      handled_at TEXT,
      extension_request INTEGER DEFAULT 0,
      extension_reason TEXT,
      extension_days INTEGER,
      extension_approved INTEGER,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (anomaly_id) REFERENCES anomalies(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS rechecks (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      anomaly_id INTEGER NOT NULL,
      rectification_id INTEGER NOT NULL,
      rechecker_id INTEGER,
      result TEXT NOT NULL,
      remark TEXT,
      evidence TEXT,
      rechecked_at TEXT DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (anomaly_id) REFERENCES anomalies(id),
      FOREIGN KEY (rectification_id) REFERENCES rectifications(id)
    );
  `);

  await db.exec(`
    CREATE INDEX IF NOT EXISTS idx_tasks_date ON inspection_tasks(task_date);
    CREATE INDEX IF NOT EXISTS idx_tasks_status ON inspection_tasks(status);
    CREATE INDEX IF NOT EXISTS idx_anomalies_status ON anomalies(status);
    CREATE INDEX IF NOT EXISTS idx_anomalies_device ON anomalies(device_id);
  `);
}

async function seedData() {
  const userCount = (await db.get('SELECT COUNT(*) as cnt FROM users')).cnt;
  if (userCount > 0) return;

  await db.run('BEGIN');
  try {
    const userData = [
      ['admin', '系统管理员', 'admin'],
      ['inspector1', '张三', 'inspector'],
      ['inspector2', '李四', 'inspector'],
      ['worker1', '王五', 'worker']
    ];
    const insertUser = db.prepare('INSERT INTO users (username, name, role) VALUES (?, ?, ?)');
    for (const u of userData) {
      await new Promise((res, rej) => insertUser.run(u, function(err) { if (err) rej(err); else res(); }));
    }

    const deviceData = [
      ['DEV-001', '1号主变压器', '变压器', 'A区-一号车间', '2023-01-15', '1000KVA主变压器'],
      ['DEV-002', '2号变压器', '变压器', 'A区-二号车间', '2023-03-20', '500KVA变压器'],
      ['DEV-003', '高压配电柜A1', '配电柜', 'A区-一号车间', '2023-01-15', '10KV进线柜'],
      ['DEV-004', '低压配电柜B1', '配电柜', 'B区-动力站', '2023-02-10', '低压出线柜'],
      ['DEV-005', '循环水泵1号', '泵类', 'B区-水处理', '2023-04-01', '冷却循环水泵'],
      ['DEV-006', '空压机1号', '空压机', 'B区-动力站', '2023-02-28', '螺杆式空压机'],
      ['DEV-007', '输送电机M1', '电机', 'C区-仓储中心', '2023-05-10', '输送带驱动电机'],
      ['DEV-008', '消防水泵', '泵类', 'A区-一号车间', '2023-01-20', '消防系统备用泵']
    ];
    const insertDevice = db.prepare('INSERT INTO devices (code, name, type, area, status, install_date, description) VALUES (?, ?, ?, ?, ?, ?, ?)');
    for (const d of deviceData) {
      await new Promise((res, rej) => insertDevice.run([d[0], d[1], d[2], d[3], '正常', d[4], d[5]], function(err) { if (err) rej(err); else res(); }));
    }

    const pointsByType = {
      '变压器': [['外观检查', '无变形、无渗油、清洁', '目视检查'],['温度检测', '油温≤85℃', '红外测温仪'],['声音检查', '无异常噪音', '听声检查'],['接地检查', '接地良好', '万用表']],
      '配电柜': [['仪表指示', '电压电流正常', '观察仪表'],['开关状态', '位置正确', '目视检查'],['接线端子', '无发热、无松动', '目视+测温'],['柜内清洁', '无灰尘、无异物', '目视检查']],
      '电机': [['运行声音', '无异常噪音', '听声检查'],['轴承温度', '≤70℃', '红外测温仪'],['振动检测', '振动值≤4.5mm/s', '振动仪'],['电流检测', '三相电流平衡', '钳形表']],
      '泵类': [['运行压力', '压力在额定范围', '压力表'],['密封检查', '无泄漏', '目视检查'],['轴承温度', '≤75℃', '红外测温仪'],['振动检测', '无异常振动', '手感+测振']],
      '空压机': [['排气压力', '0.7-0.8MPa', '压力表'],['润滑油位', '油位在正常区间', '观察油镜'],['排气温度', '≤110℃', '温度表'],['分离器压差', '≤0.1MPa', '压差表']]
    };

    const devices = await db.all('SELECT id, type FROM devices');
    for (const dev of devices) {
      const points = pointsByType[dev.type] || [];
      const insertPoint = db.prepare('INSERT INTO inspection_points (device_id, name, standard, method, sort_order) VALUES (?, ?, ?, ?, ?)');
      for (let i = 0; i < points.length; i++) {
        await new Promise((res, rej) => insertPoint.run([dev.id, points[i][0], points[i][1], points[i][2], i + 1], function(err) { if (err) rej(err); else res(); }));
      }
    }

    const templateNames = [
      ['变压器日常巡检模板', '变压器', '标准变压器日常巡检项目'],
      ['配电柜日常巡检模板', '配电柜', '标准配电柜日常巡检项目'],
      ['机械设备通用模板', null, '泵类、电机等通用机械巡检']
    ];
    const tmplIds = [];
    for (const t of templateNames) {
      const r = await prepareAndRun('INSERT INTO inspection_templates (name, device_type, description) VALUES (?, ?, ?)', t);
      tmplIds.push(r.lastID);
    }

    const tmplPointsData = [
      [tmplIds[0], pointsByType['变压器']],
      [tmplIds[1], pointsByType['配电柜']],
      [tmplIds[2], [['外观检查', '清洁完好无损坏', '目视'],['运行声音', '无异常噪音', '听声'],['温度检测', '温度正常范围', '测温仪']]]
    ];
    for (const [tid, pts] of tmplPointsData) {
      const insertTmplPoint = db.prepare('INSERT INTO template_points (template_id, point_name, standard, method, sort_order) VALUES (?, ?, ?, ?, ?)');
      for (let i = 0; i < pts.length; i++) {
        await new Promise((res, rej) => insertTmplPoint.run([tid, pts[i][0], pts[i][1], pts[i][2], i + 1], function(err) { if (err) rej(err); else res(); }));
      }
    }

    const holidayData = [
      ['2026-01-01', '元旦'],['2026-02-16', '春节'],['2026-02-17', '春节'],
      ['2026-02-18', '春节'],['2026-04-06', '清明节'],['2026-05-01', '劳动节'],['2026-06-19', '端午节']
    ];
    for (const h of holidayData) {
      await prepareAndRun('INSERT OR IGNORE INTO holidays (date, name) VALUES (?, ?)', h);
    }

    const plans = [
      ['A区变压器日巡检', '变压器', 'A区-一号车间', tmplIds[0], 'daily', 1, '2026-06-01', '2026-12-31', JSON.stringify([2]), 0, '每日巡检A区变压器'],
      ['配电柜周巡检', '配电柜', null, tmplIds[1], 'weekly', 7, '2026-06-01', '2026-12-31', JSON.stringify([3]), 0, '每周巡检所有配电柜'],
      ['B区动力设备巡检', null, 'B区-动力站', tmplIds[2], 'daily', 1, '2026-06-01', '2026-12-31', JSON.stringify([2]), 0, 'B区动力站设备巡检'],
      ['月度重点设备巡检', null, 'A区-二号车间', tmplIds[2], 'monthly', 30, '2026-06-01', '2026-12-31', JSON.stringify([2, 3]), 1, '已暂停的月度计划']
    ];
    const planIds = [];
    for (const p of plans) {
      const r = await prepareAndRun('INSERT INTO inspection_plans (name, device_type, area, template_id, cycle, cycle_days, start_date, end_date, inspector_ids, paused, description) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)', p);
      planIds.push(r.lastID);
    }

    const planDeviceQueries = [
      [planIds[0], "SELECT id FROM devices WHERE type='变压器' AND area LIKE 'A区%'"],
      [planIds[1], "SELECT id FROM devices WHERE type='配电柜'"],
      [planIds[2], "SELECT id FROM devices WHERE area LIKE 'B区%'"],
      [planIds[3], "SELECT id FROM devices WHERE area LIKE 'A区-二号车间'"]
    ];
    for (const [pid, sql] of planDeviceQueries) {
      const devs = await db.all(sql);
      for (const d of devs) {
        await prepareAndRun('INSERT OR IGNORE INTO plan_devices (plan_id, device_id) VALUES (?, ?)', [pid, d.id]);
      }
    }

    await db.run('COMMIT');
  } catch (e) {
    await db.run('ROLLBACK');
    throw e;
  }
}

async function init() {
  await initDatabase();
  await seedData();
  console.log('Database initialized successfully');
}

module.exports = { db, init, prepareAndRun };
