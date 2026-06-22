const sqlite3 = require('sqlite3').verbose();
const path = require('path');
const { promisify } = require('util');
const fs = require('fs');

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
      pause_reason TEXT,
      holiday_strategy TEXT DEFAULT 'skip',
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
      skip_type TEXT,
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

    CREATE TABLE IF NOT EXISTS anomaly_status_history (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      anomaly_id INTEGER NOT NULL,
      from_status TEXT,
      to_status TEXT NOT NULL,
      operator_id INTEGER,
      operator_name TEXT,
      remark TEXT,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (anomaly_id) REFERENCES anomalies(id) ON DELETE CASCADE
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
      extension_approver_id INTEGER,
      extension_remark TEXT,
      extension_approved_at TEXT,
      previous_measure TEXT,
      round INTEGER DEFAULT 1,
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
    CREATE INDEX IF NOT EXISTS idx_tasks_plan_date ON inspection_tasks(plan_id, task_date, device_id);
    CREATE INDEX IF NOT EXISTS idx_anomalies_status ON anomalies(status);
    CREATE INDEX IF NOT EXISTS idx_anomalies_device ON anomalies(device_id);
    CREATE INDEX IF NOT EXISTS idx_anomaly_history_anomaly ON anomaly_status_history(anomaly_id);
    CREATE INDEX IF NOT EXISTS idx_rectifications_anomaly ON rectifications(anomaly_id);
    CREATE INDEX IF NOT EXISTS idx_rechecks_anomaly ON rechecks(anomaly_id);
  `);
}

async function addStatusHistory(anomalyId, fromStatus, toStatus, operatorId, operatorName, remark) {
  await prepareAndRun(
    'INSERT INTO anomaly_status_history (anomaly_id, from_status, to_status, operator_id, operator_name, remark) VALUES (?, ?, ?, ?, ?, ?)',
    [anomalyId, fromStatus || null, toStatus, operatorId || null, operatorName || null, remark || null]
  );
}

async function getStatusHistory(anomalyId) {
  return db.all(`
    SELECT * FROM anomaly_status_history
    WHERE anomaly_id = ?
    ORDER BY id ASC
  `, anomalyId);
}

const POINTS_BY_TYPE = {
  '变压器': [
    ['外观检查', '无变形、无渗油、清洁', '目视检查'],
    ['温度检测', '油温≤85℃', '红外测温仪'],
    ['声音检查', '无异常噪音', '听声检查'],
    ['接地检查', '接地良好', '万用表']
  ],
  '配电柜': [
    ['仪表指示', '电压电流正常', '观察仪表'],
    ['开关状态', '位置正确', '目视检查'],
    ['接线端子', '无发热、无松动', '目视+测温'],
    ['柜内清洁', '无灰尘、无异物', '目视检查']
  ],
  '电机': [
    ['运行声音', '无异常噪音', '听声检查'],
    ['轴承温度', '≤70℃', '红外测温仪'],
    ['振动检测', '振动值≤4.5mm/s', '振动仪'],
    ['电流检测', '三相电流平衡', '钳形表']
  ],
  '泵类': [
    ['运行压力', '压力在额定范围', '压力表'],
    ['密封检查', '无泄漏', '目视检查'],
    ['轴承温度', '≤75℃', '红外测温仪'],
    ['振动检测', '无异常振动', '手感+测振']
  ],
  '空压机': [
    ['排气压力', '0.7-0.8MPa', '压力表'],
    ['润滑油位', '油位在正常区间', '观察油镜'],
    ['排气温度', '≤110℃', '温度表'],
    ['分离器压差', '≤0.1MPa', '压差表']
  ]
};

const DEVICE_DATA = [
  ['DEV-001', '1号主变压器', '变压器', 'A区-一号车间', '正常', '2023-01-15', '1000KVA主变压器'],
  ['DEV-002', '2号变压器', '变压器', 'A区-二号车间', '正常', '2023-03-20', '500KVA变压器'],
  ['DEV-003', '高压配电柜A1', '配电柜', 'A区-一号车间', '正常', '2023-01-15', '10KV进线柜'],
  ['DEV-004', '低压配电柜B1', '配电柜', 'B区-动力站', '正常', '2023-02-10', '低压出线柜'],
  ['DEV-005', '循环水泵1号', '泵类', 'B区-水处理', '正常', '2023-04-01', '冷却循环水泵'],
  ['DEV-006', '空压机1号', '空压机', 'B区-动力站', '正常', '2023-02-28', '螺杆式空压机'],
  ['DEV-007', '输送电机M1', '电机', 'C区-仓储中心', '正常', '2023-05-10', '输送带驱动电机'],
  ['DEV-008', '消防水泵', '泵类', 'A区-一号车间', '正常', '2023-01-20', '消防系统备用泵']
];

const USER_DATA = [
  ['admin', '系统管理员', 'admin'],
  ['inspector1', '张三', 'inspector'],
  ['inspector2', '李四', 'inspector'],
  ['worker1', '王五', 'worker'],
  ['manager1', '赵六', 'manager']
];

const HOLIDAY_DATA = [
  ['2026-01-01', '元旦'],
  ['2026-02-16', '春节'],
  ['2026-02-17', '春节'],
  ['2026-02-18', '春节'],
  ['2026-04-06', '清明节'],
  ['2026-05-01', '劳动节'],
  ['2026-06-19', '端午节'],
  ['2026-10-01', '国庆节'],
  ['2026-10-02', '国庆节'],
  ['2026-10-03', '国庆节']
];

const TEMPLATE_DATA = [
  ['变压器日常巡检模板', '变压器', '标准变压器日常巡检项目'],
  ['配电柜日常巡检模板', '配电柜', '标准配电柜日常巡检项目'],
  ['机械设备通用模板', null, '泵类、电机等通用机械巡检'],
  ['空压机专项巡检模板', '空压机', '空压机专项检查项目']
];

async function seedData() {
  await db.run('BEGIN');
  try {
    for (const u of USER_DATA) {
      await prepareAndRun('INSERT OR IGNORE INTO users (username, name, role) VALUES (?, ?, ?)', u);
    }

    for (const d of DEVICE_DATA) {
      const existing = await db.get('SELECT id FROM devices WHERE code = ?', d[0]);
      if (!existing) {
        const info = await prepareAndRun(
          'INSERT INTO devices (code, name, type, area, status, install_date, description) VALUES (?, ?, ?, ?, ?, ?, ?)',
          d
        );
        const points = POINTS_BY_TYPE[d[2]] || [];
        for (let i = 0; i < points.length; i++) {
          await prepareAndRun(
            'INSERT INTO inspection_points (device_id, name, standard, method, sort_order) VALUES (?, ?, ?, ?, ?)',
            [info.lastID, points[i][0], points[i][1], points[i][2], i + 1]
          );
        }
      }
    }

    for (const h of HOLIDAY_DATA) {
      await prepareAndRun('INSERT OR IGNORE INTO holidays (date, name) VALUES (?, ?)', h);
    }

    const existingTemplates = await db.all('SELECT id, name FROM inspection_templates');
    const existingTemplateNames = existingTemplates.map(t => t.name);
    const templateIds = [];

    for (const t of TEMPLATE_DATA) {
      if (!existingTemplateNames.includes(t[0])) {
        const info = await prepareAndRun(
          'INSERT INTO inspection_templates (name, device_type, description) VALUES (?, ?, ?)',
          t
        );
        templateIds.push(info.lastID);
        const points = t[1] && POINTS_BY_TYPE[t[1]] ? POINTS_BY_TYPE[t[1]] :
          [['外观检查', '清洁完好无损坏', '目视'], ['运行声音', '无异常噪音', '听声'], ['温度检测', '温度正常范围', '测温仪']];
        for (let i = 0; i < points.length; i++) {
          await prepareAndRun(
            'INSERT INTO template_points (template_id, point_name, standard, method, sort_order) VALUES (?, ?, ?, ?, ?)',
            [info.lastID, points[i][0], points[i][1], points[i][2], i + 1]
          );
        }
      } else {
        const existing = existingTemplates.find(et => et.name === t[0]);
        templateIds.push(existing.id);
      }
    }

    const planCount = (await db.get('SELECT COUNT(*) as cnt FROM inspection_plans')).cnt;
    if (planCount === 0) {
      const devices = await db.all('SELECT id, type, area FROM devices');
      const plans = [
        {
          name: 'A区变压器日巡检',
          device_type: '变压器',
          area: null,
          template_id: templateIds[0],
          cycle: 'daily',
          cycle_days: 1,
          start_date: '2026-06-01',
          end_date: '2026-12-31',
          inspector_ids: JSON.stringify([2]),
          paused: 0,
          pause_reason: null,
          holiday_strategy: 'skip',
          description: '每日巡检A区变压器',
          deviceQuery: "SELECT id FROM devices WHERE type='变压器'"
        },
        {
          name: '配电柜周巡检',
          device_type: '配电柜',
          area: null,
          template_id: templateIds[1],
          cycle: 'weekly',
          cycle_days: 7,
          start_date: '2026-06-02',
          end_date: '2026-12-31',
          inspector_ids: JSON.stringify([3]),
          paused: 0,
          pause_reason: null,
          holiday_strategy: 'skip',
          description: '每周巡检所有配电柜',
          deviceQuery: "SELECT id FROM devices WHERE type='配电柜'"
        },
        {
          name: 'B区动力设备巡检',
          device_type: null,
          area: 'B区-动力站',
          template_id: templateIds[2],
          cycle: 'daily',
          cycle_days: 1,
          start_date: '2026-06-01',
          end_date: '2026-12-31',
          inspector_ids: JSON.stringify([2]),
          paused: 0,
          pause_reason: null,
          holiday_strategy: 'work',
          description: 'B区动力站设备巡检（节假日正常巡检）',
          deviceQuery: "SELECT id FROM devices WHERE area LIKE 'B区-动力站%'"
        },
        {
          name: '月度重点设备巡检',
          device_type: null,
          area: null,
          template_id: templateIds[2],
          cycle: 'monthly',
          cycle_days: 30,
          start_date: '2026-06-15',
          end_date: '2026-12-31',
          inspector_ids: JSON.stringify([2, 3]),
          paused: 1,
          pause_reason: '等待设备升级完成',
          holiday_strategy: 'skip',
          description: '已暂停的月度重点设备巡检计划',
          deviceQuery: "SELECT id FROM devices WHERE area LIKE 'A区%' OR area LIKE 'C区%'"
        }
      ];

      for (const p of plans) {
        const info = await prepareAndRun(
          `INSERT INTO inspection_plans (name, device_type, area, template_id, cycle, cycle_days, start_date, end_date, inspector_ids, paused, pause_reason, holiday_strategy, description)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [p.name, p.device_type, p.area, p.template_id, p.cycle, p.cycle_days, p.start_date, p.end_date,
           p.inspector_ids, p.paused, p.pause_reason, p.holiday_strategy, p.description]
        );
        const planDevices = await db.all(p.deviceQuery);
        for (const d of planDevices) {
          await prepareAndRun('INSERT OR IGNORE INTO plan_devices (plan_id, device_id) VALUES (?, ?)', [info.lastID, d.id]);
        }
      }
    }

    await db.run('COMMIT');
    console.log('Sample data seeded successfully');
  } catch (e) {
    await db.run('ROLLBACK');
    throw e;
  }
}

async function verifyData() {
  const results = {};

  results.users = (await db.get('SELECT COUNT(*) as cnt FROM users')).cnt;
  results.devices = (await db.get('SELECT COUNT(*) as cnt FROM devices')).cnt;
  results.device_types = (await db.get('SELECT COUNT(DISTINCT type) as cnt FROM devices')).cnt;
  results.areas = (await db.get('SELECT COUNT(DISTINCT area) as cnt FROM devices')).cnt;
  results.templates = (await db.get('SELECT COUNT(*) as cnt FROM inspection_templates')).cnt;
  results.plans = (await db.get('SELECT COUNT(*) as cnt FROM inspection_plans')).cnt;
  results.holidays = (await db.get('SELECT COUNT(*) as cnt FROM holidays')).cnt;
  results.points = (await db.get('SELECT COUNT(*) as cnt FROM inspection_points')).cnt;
  results.roles = (await db.all('SELECT role, COUNT(*) as cnt FROM users GROUP BY role')).map(r => ({ role: r.role, count: r.cnt }));

  const checks = [
    { name: '用户数量 ≥ 3', pass: results.users >= 3 },
    { name: '用户角色 ≥ 3 种', pass: results.roles.length >= 3 },
    { name: '设备数量 ≥ 8', pass: results.devices >= 8 },
    { name: '设备类型 ≥ 3', pass: results.device_types >= 3 },
    { name: '区域数量 ≥ 3', pass: results.areas >= 3 },
    { name: '巡检模板 ≥ 3', pass: results.templates >= 3 },
    { name: '巡检计划 ≥ 4', pass: results.plans >= 4 },
    { name: '节假日 ≥ 7', pass: results.holidays >= 7 },
    { name: '巡检点数量 > 0', pass: results.points > 0 }
  ];

  return { results, checks, allPassed: checks.every(c => c.pass) };
}

async function resetDatabase() {
  const tables = [
    'rechecks', 'rectifications', 'anomaly_status_history', 'anomalies',
    'task_results', 'inspection_tasks', 'plan_devices', 'inspection_plans',
    'holidays', 'users', 'template_points', 'inspection_templates',
    'inspection_points', 'devices'
  ];

  await db.run('BEGIN');
  try {
    for (const table of tables) {
      await db.run(`DROP TABLE IF EXISTS ${table}`);
    }
    await db.run('COMMIT');
  } catch (e) {
    await db.run('ROLLBACK');
    throw e;
  }

  await initDatabase();
  await seedData();
}

async function init() {
  await initDatabase();
}

module.exports = {
  db,
  init,
  initDatabase,
  seedData,
  verifyData,
  resetDatabase,
  prepareAndRun,
  addStatusHistory,
  getStatusHistory,
  POINTS_BY_TYPE
};
