let currentUser = null;
let users = [];
let areas = [];
let deviceTypes = [];
const API = '/api';

async function api(url, options = {}) {
  const res = await fetch(API + url, {
    headers: { 'Content-Type': 'application/json' },
    ...options,
    body: options.body ? JSON.stringify(options.body) : undefined
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    console.error('API Error:', url, data);
    throw new Error(data.error || '请求失败');
  }
  return data;
}

function $(id) { return document.getElementById(id); }

function closeModal() { $('modal').style.display = 'none'; }
function openModal(title, bodyHtml) {
  $('modal-title').textContent = title;
  $('modal-body').innerHTML = bodyHtml;
  $('modal').style.display = 'flex';
}

function formatDate(d) {
  if (!d) return '';
  const date = typeof d === 'string' ? new Date(d) : d;
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function todayStr() { return formatDate(new Date()); }

function getDaysBetween(start, end) {
  const days = [];
  const s = new Date(start);
  const e = new Date(end);
  for (let d = new Date(s); d <= e; d.setDate(d.getDate() + 1)) {
    days.push(formatDate(d));
  }
  return days;
}

function statusBadge(status) {
  const map = {
    pending: '待执行', submitted: '已提交', skipped: '已跳过',
    assigned: '已分配', rechecking: '待复查', reject: '已退回',
    closed: '已关闭', processing: '处理中'
  };
  const text = map[status] || status;
  return `<span class="badge badge-${status}">${text}</span>`;
}

function levelBadge(level) {
  return `<span class="badge badge-level-${level}">${level}</span>`;
}

async function initApp() {
  users = await api('/users');
  const areasData = await api('/devices/areas');
  areas = areasData.areas;
  deviceTypes = areasData.types;

  const sel = $('currentUser');
  sel.innerHTML = users.map(u =>
    `<option value="${u.id}">${u.name}（${u.role}）</option>`
  ).join('');
  sel.onchange = () => {
    currentUser = users.find(u => u.id == sel.value);
  };
  currentUser = users[0];

  document.querySelectorAll('#nav-menu li').forEach(li => {
    li.onclick = () => {
      document.querySelectorAll('#nav-menu li').forEach(l => l.classList.remove('active'));
      li.classList.add('active');
      renderPage(li.dataset.page);
    };
  });

  $('modal').onclick = (e) => { if (e.target.id === 'modal') closeModal(); };

  renderPage('dashboard');
}

async function renderPage(page) {
  const map = {
    dashboard: renderDashboard,
    calendar: renderCalendar,
    tasks: renderTasks,
    anomalies: renderAnomalies,
    devices: renderDevices
  };
  if (map[page]) await map[page]();
}

async function renderDashboard() {
  const data = await api('/stats/dashboard');
  const content = $('page-content');

  content.innerHTML = `
    <div class="page-header"><h2>📊 统计看板</h2></div>

    <div class="stat-grid">
      <div class="stat-card blue">
        <div class="stat-label">计划完成率</div>
        <div class="stat-value">${data.planCompletion.rate}%</div>
        <div class="stat-sub">${data.planCompletion.completed} / ${data.planCompletion.total} 任务</div>
        <div class="progress-bar"><div class="progress-fill blue" style="width:${data.planCompletion.rate}%"></div></div>
      </div>
      <div class="stat-card orange">
        <div class="stat-label">异常率</div>
        <div class="stat-value">${data.anomalyRate.rate}%</div>
        <div class="stat-sub">${data.anomalyRate.anomalyTasks} / ${data.anomalyRate.submittedTasks} 异常任务</div>
        <div class="progress-bar"><div class="progress-fill orange" style="width:${Math.min(data.anomalyRate.rate, 100)}%"></div></div>
      </div>
      <div class="stat-card red">
        <div class="stat-label">逾期整改数</div>
        <div class="stat-value">${data.overdueCount}</div>
        <div class="stat-sub">需立即处理</div>
        <div class="progress-bar"><div class="progress-fill red" style="width:${Math.min(data.overdueCount * 10, 100)}%"></div></div>
      </div>
      <div class="stat-card green">
        <div class="stat-label">重复异常设备</div>
        <div class="stat-value">${data.repeatDevices.length}</div>
        <div class="stat-sub">需关注设备</div>
        <div class="progress-bar"><div class="progress-fill green" style="width:${Math.min(data.repeatDevices.length * 10, 100)}%"></div></div>
      </div>
    </div>

    <div class="two-col">
      <div class="card">
        <div class="section-title">区域风险排行</div>
        ${data.areaRanking.length ? `
          <table>
            <thead><tr><th>区域</th><th>设备数</th><th>异常数</th><th>风险率</th><th>风险分布</th></tr></thead>
            <tbody>
              ${data.areaRanking.map(r => `
                <tr>
                  <td>${r.area}</td>
                  <td>${r.device_count}</td>
                  <td>${r.anomaly_count}</td>
                  <td><b>${r.risk_rate}%</b></td>
                  <td><div class="risk-bar"><div class="bar"><div class="bar-fill" style="width:${r.risk_rate}%"></div></div></div></td>
                </tr>
              `).join('')}
            </tbody>
          </table>
        ` : '<div class="empty-state">暂无数据</div>'}
      </div>
      <div class="card">
        <div class="section-title">重复异常设备 TOP 10</div>
        ${data.repeatDevices.length ? `
          <table>
            <thead><tr><th>设备编号</th><th>设备名称</th><th>区域</th><th>类型</th><th>异常次数</th></tr></thead>
            <tbody>
              ${data.repeatDevices.map(d => `
                <tr>
                  <td>${d.code}</td>
                  <td><a href="#" onclick="showDeviceDetail(${d.id});return false;">${d.name}</a></td>
                  <td>${d.area}</td>
                  <td>${d.type}</td>
                  <td><b style="color:#f5222d;">${d.anomaly_count}</b></td>
                </tr>
              `).join('')}
            </tbody>
          </table>
        ` : '<div class="empty-state">暂无重复异常设备</div>'}
      </div>
    </div>

    <div class="card">
      <div class="section-title">人员任务负载（近30天）</div>
      ${data.workload.length ? `
        <table>
          <thead><tr><th>巡检员</th><th>总任务数</th><th>已完成</th><th>待处理</th><th>完成率</th><th>负载条</th></tr></thead>
          <tbody>
            ${data.workload.map(w => {
              const rate = w.total_tasks > 0 ? Math.round(w.completed_tasks / w.total_tasks * 100) : 0;
              return `
                <tr>
                  <td>${w.name}</td>
                  <td>${w.total_tasks}</td>
                  <td>${w.completed_tasks}</td>
                  <td>${w.pending_tasks}</td>
                  <td>${rate}%</td>
                  <td><div class="progress-bar" style="max-width:200px;"><div class="progress-fill blue" style="width:${rate}%"></div></div></td>
                </tr>
              `;
            }).join('')}
          </tbody>
        </table>
      ` : '<div class="empty-state">暂无数据</div>'}
    </div>
  `;
}

let calState = { viewMonth: new Date() };

async function renderCalendar() {
  const content = $('page-content');
  const y = calState.viewMonth.getFullYear();
  const m = calState.viewMonth.getMonth();
  const firstDay = new Date(y, m, 1);
  const lastDay = new Date(y, m + 1, 0);
  const startOffset = firstDay.getDay();
  const daysInMonth = lastDay.getDate();

  const fromStr = formatDate(firstDay);
  const toStr = formatDate(lastDay);

  const [tasks, holidays] = await Promise.all([
    api(`/plans/calendar?from=${fromStr}&to=${toStr}`),
    api('/holidays')
  ]);

  const holidayMap = {};
  holidays.forEach(h => { holidayMap[h.date] = h.name; });
  const tasksByDate = {};
  tasks.tasks.forEach(t => {
    if (!tasksByDate[t.task_date]) tasksByDate[t.task_date] = [];
    tasksByDate[t.task_date].push(t);
  });

  const weekdays = ['日', '一', '二', '三', '四', '五', '六'];
  const cells = [];
  for (let i = 0; i < startOffset; i++) cells.push(null);
  for (let d = 1; d <= daysInMonth; d++) {
    const dateStr = `${y}-${String(m + 1).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
    cells.push({ date: d, dateStr, day: new Date(y, m, d).getDay() });
  }

  content.innerHTML = `
    <div class="page-header">
      <h2>📅 计划日历</h2>
      <div>
        <button class="btn" onclick="changeMonth(-1)">◀ 上月</button>
        <b style="margin:0 16px;font-size:16px;">${y}年${m + 1}月</b>
        <button class="btn" onclick="changeMonth(1)">下月 ▶</button>
        <button class="btn btn-primary" onclick="generateTasksAction()" style="margin-left:16px;">🔄 生成本月任务</button>
      </div>
    </div>

    <div class="card">
      <div class="toolbar">
        <label>区域筛选：</label>
        <select id="cal-area-filter" onchange="renderCalendar()">
          <option value="">全部区域</option>
          ${areas.map(a => `<option value="${a}">${a}</option>`).join('')}
        </select>
      </div>
      <div class="calendar">
        ${weekdays.map(w => `<div class="calendar-header">${w}</div>`).join('')}
        ${cells.map(c => {
          if (!c) return '<div></div>';
          const dayTasks = tasksByDate[c.dateStr] || [];
          const isToday = c.dateStr === todayStr();
          const isWeekend = c.day === 0 || c.day === 6;
          const isHoliday = !!holidayMap[c.dateStr];
          return `
            <div class="calendar-day ${isToday ? 'today' : ''} ${isWeekend ? 'weekend' : ''} ${isHoliday ? 'holiday' : ''}">
              <div class="day-date">${c.date}${isHoliday ? `<span class="holiday-tag">${holidayMap[c.dateStr]}</span>` : ''}</div>
              <div class="day-tasks">
                ${dayTasks.slice(0, 3).map(t => {
                  let cls = '';
                  if (t.skipped) cls = 'skipped';
                  else if (t.status === 'submitted') cls = t.anomalies ? 'anomaly' : 'done';
                  return `<div class="day-task ${cls}" title="${t.device_name} - ${t.status}" onclick="showTaskDetail(${t.id})">${t.device_name}</div>`;
                }).join('')}
                ${dayTasks.length > 3 ? `<div class="day-task">+${dayTasks.length - 3}更多</div>` : ''}
              </div>
            </div>
          `;
        }).join('')}
      </div>
    </div>
  `;
}

function changeMonth(delta) {
  calState.viewMonth.setMonth(calState.viewMonth.getMonth() + delta);
  renderCalendar();
}

async function generateTasksAction() {
  const y = calState.viewMonth.getFullYear();
  const m = calState.viewMonth.getMonth();
  const from = `${y}-${String(m + 1).padStart(2, '0')}-01`;
  const lastDay = new Date(y, m + 1, 0).getDate();
  const to = `${y}-${String(m + 1).padStart(2, '0')}-${lastDay}`;
  try {
    const result = await api('/tasks/generate-all', { method: 'POST', body: { from, to } });
    alert(`任务生成完成！\n已生成: ${result.totalCreated} 个任务\n跳过: ${result.totalSkipped} 个`);
    renderCalendar();
  } catch (e) {
    alert('生成失败: ' + e.message);
  }
}

async function renderTasks() {
  const content = $('page-content');
  const urlParams = new URLSearchParams(window.location.search);
  const filterStatus = urlParams.get('status') || '';
  const filterArea = urlParams.get('area') || '';

  const [tasks, plans] = await Promise.all([
    api(`/tasks?status=${filterStatus}&area=${filterArea}`),
    api('/plans')
  ]);

  content.innerHTML = `
    <div class="page-header">
      <h2>✅ 巡检任务</h2>
      <div>
        <button class="btn btn-primary" onclick="generateTasksAction()">🔄 生成任务</button>
        <button class="btn" onclick="showCreatePlan()">📝 新建巡检计划</button>
      </div>
    </div>

    <div class="card">
      <div class="toolbar">
        <label>状态：</label>
        <select id="task-status-filter" onchange="filterTasks()">
          <option value="">全部</option>
          <option value="pending">待执行</option>
          <option value="submitted">已提交</option>
          <option value="skipped">已跳过</option>
        </select>
        <label>区域：</label>
        <select id="task-area-filter" onchange="filterTasks()">
          <option value="">全部区域</option>
          ${areas.map(a => `<option value="${a}">${a}</option>`).join('')}
        </select>
      </div>
      <table>
        <thead>
          <tr>
            <th>任务日期</th>
            <th>设备</th>
            <th>区域</th>
            <th>所属计划</th>
            <th>巡检员</th>
            <th>状态</th>
            <th>操作</th>
          </tr>
        </thead>
        <tbody>
          ${tasks.length ? tasks.map(t => `
            <tr>
              <td>${t.task_date}</td>
              <td>${t.device_name}</td>
              <td>${t.area}</td>
              <td>${t.plan_name || '-'}</td>
              <td>${t.inspector_name || '-'}</td>
              <td>${statusBadge(t.status)}${t.skipped ? ` <span class="badge badge-skipped">${t.skip_reason || ''}</span>` : ''}</td>
              <td>
                ${t.status === 'pending' && !t.skipped ? `<button class="btn btn-sm btn-primary" onclick="submitTask(${t.id})">提交巡检</button>` : ''}
                <button class="btn btn-sm" onclick="showTaskDetail(${t.id})">详情</button>
              </td>
            </tr>
          `).join('') : '<tr><td colspan="7"><div class="empty-state"><div class="empty-state-icon">📋</div>暂无任务，请先生成任务</div></td></tr>'}
        </tbody>
      </table>
    </div>

    <div class="card">
      <div class="section-title">巡检计划列表</div>
      <table>
        <thead>
          <tr>
            <th>计划名称</th>
            <th>设备类型</th>
            <th>区域</th>
            <th>周期</th>
            <th>巡检员</th>
            <th>关联设备</th>
            <th>状态</th>
            <th>操作</th>
          </tr>
        </thead>
        <tbody>
          ${plans.map(p => {
            const inspectorNames = (p.inspector_list || [])
              .map(id => (users.find(u => u.id === id) || {}).name).join('、');
            return `
              <tr>
                <td>${p.name}</td>
                <td>${p.device_type || '-'}</td>
                <td>${p.area || '-'}</td>
                <td>${p.cycle === 'daily' ? '每日' : p.cycle === 'weekly' ? '每周' : '每月'}</td>
                <td>${inspectorNames || '-'}</td>
                <td>${p.device_count} 台</td>
                <td>
                  <label class="switch">
                    <input type="checkbox" ${!p.paused ? 'checked' : ''} onchange="togglePlan(${p.id}, this.checked)">
                    <span class="slider"></span>
                  </label>
                  <span style="margin-left:6px;">${p.paused ? '已暂停' : '运行中'}</span>
                </td>
                <td>
                  <button class="btn btn-sm" onclick="generatePlanTasks(${p.id})">生成任务</button>
                </td>
              </tr>
            `;
          }).join('')}
        </tbody>
      </table>
    </div>
  `;

  $('task-status-filter').value = filterStatus;
  $('task-area-filter').value = filterArea;
}

function filterTasks() {
  const s = $('task-status-filter').value;
  const a = $('task-area-filter').value;
  window.history.replaceState(null, '', `?status=${s}&area=${a}`);
  renderTasks();
}

async function togglePlan(planId, running) {
  try {
    await api(`/plans/${planId}/toggle`, { method: 'POST', body: { paused: !running } });
    renderTasks();
  } catch (e) { alert(e.message); }
}

async function generatePlanTasks(planId) {
  try {
    const from = todayStr();
    const to = formatDate(new Date(Date.now() + 30 * 86400000));
    const r = await api(`/plans/${planId}/generate`, { method: 'POST', body: { from, to } });
    alert(`完成：生成${r.created}个任务，跳过${r.skipped}个`);
    renderTasks();
  } catch (e) { alert(e.message); }
}

async function showTaskDetail(taskId) {
  const task = await api(`/tasks/${taskId}`);
  openModal(`任务详情 - ${task.device_name}`, `
    <div class="card" style="box-shadow:none;padding:0;">
      <div class="two-col" style="margin-bottom:16px;">
        <div><b>任务日期：</b>${task.task_date}</div>
        <div><b>设备编号：</b>${task.device_code}</div>
        <div><b>设备名称：</b>${task.device_name}</div>
        <div><b>所属区域：</b>${task.area}</div>
        <div><b>巡检计划：</b>${task.plan_name || '-'}</div>
        <div><b>巡检员：</b>${task.inspector_name || '-'}</div>
        <div><b>状态：</b>${statusBadge(task.status)}</div>
        <div><b>提交时间：</b>${task.submitted_at || '-'}</div>
      </div>

      <div class="section-title">巡检项结果</div>
      ${task.results.length ? `
        <table>
          <thead><tr><th>巡检点</th><th>结果</th><th>证据</th><th>备注</th></tr></thead>
          <tbody>
            ${task.results.map(r => `
              <tr>
                <td>${r.point_name}</td>
                <td>${r.result === 'normal' ? '<span style="color:#52c41a;">正常</span>' : '<span style="color:#f5222d;">异常</span>'}</td>
                <td>${r.evidence ? `<a class="evidence-link" href="${r.evidence}" target="_blank">查看证据</a>` : '-'}</td>
                <td>${r.remark || '-'}</td>
              </tr>
            `).join('')}
          </tbody>
        </table>
      ` : '<div class="empty-state">暂无结果</div>'}

      ${task.anomalies.length ? `
        <div class="section-title" style="margin-top:16px;">关联异常</div>
        <table>
          <thead><tr><th>异常等级</th><th>描述</th><th>状态</th><th>截止日期</th><th>操作</th></tr></thead>
          <tbody>
            ${task.anomalies.map(a => `
              <tr>
                <td>${levelBadge(a.level)}</td>
                <td>${a.description}</td>
                <td>${statusBadge(a.status)}</td>
                <td>${a.deadline || '-'}</td>
                <td><button class="btn btn-sm" onclick="showAnomalyDetail(${a.id});closeModal();">查看详情</button></td>
              </tr>
            `).join('')}
          </tbody>
        </table>
      ` : ''}

      <div style="text-align:right;margin-top:16px;">
        <button class="btn" onclick="closeModal()">关闭</button>
      </div>
    </div>
  `);
}

async function submitTask(taskId) {
  const task = await api(`/tasks/${taskId}`);
  const points = task.points || [];

  openModal(`提交巡检 - ${task.device_name}`, `
    <div class="card" style="box-shadow:none;padding:0;">
      <form id="submit-form">
        ${points.map((p, i) => `
          <div class="point-item">
            <div class="point-name">${p.name}</div>
            <div class="point-standard">标准：${p.standard || '-'} | 方法：${p.method || '-'}</div>
            <div class="result-options">
              <label><input type="radio" name="result_${i}" value="normal" checked><span>正常</span></label>
              <label><input type="radio" name="result_${i}" value="abnormal"><span>异常</span></label>
            </div>
            <div id="abnormal_fields_${i}" style="display:none;margin-top:8px;">
              <div class="form-row">
                <div class="form-group">
                  <label>异常等级</label>
                  <select name="level_${i}">
                    <option value="轻微">轻微</option>
                    <option value="一般" selected>一般</option>
                    <option value="严重">严重</option>
                    <option value="紧急">紧急</option>
                  </select>
                </div>
                <div class="form-group">
                  <label>异常描述</label>
                  <input type="text" name="desc_${i}" placeholder="请描述异常情况">
                </div>
              </div>
            </div>
            <div style="margin-top:6px;">
              <input type="text" name="evidence_${i}" placeholder="证据链接（可选）" style="width:60%;padding:5px 8px;border:1px solid #d9d9d9;border-radius:4px;margin-right:8px;">
              <input type="text" name="remark_${i}" placeholder="备注（可选）" style="width:35%;padding:5px 8px;border:1px solid #d9d9d9;border-radius:4px;">
            </div>
          </div>
        `).join('')}
        <div class="form-group" style="margin-top:8px;">
          <label>整体备注</label>
          <textarea name="remark" rows="2" placeholder="整体巡检备注（可选）"></textarea>
        </div>
        <div style="text-align:right;margin-top:16px;">
          <button type="button" class="btn" onclick="closeModal()">取消</button>
          <button type="submit" class="btn btn-primary">提交巡检</button>
        </div>
      </form>
    </div>
  `);

  points.forEach((_, i) => {
    document.querySelectorAll(`input[name="result_${i}"]`).forEach(r => {
      r.onchange = () => {
        const val = document.querySelector(`input[name="result_${i}"]:checked`).value;
        document.getElementById(`abnormal_fields_${i}`).style.display = val === 'abnormal' ? 'block' : 'none';
      };
    });
  });

  $('submit-form').onsubmit = async (e) => {
    e.preventDefault();
    const fd = new FormData(e.target);
    const results = [];
    points.forEach((p, i) => {
      const result = fd.get(`result_${i}`);
      const isAbnormal = result === 'abnormal';
      results.push({
        point_id: p.id,
        point_name: p.name,
        result: result,
        is_anomaly: isAbnormal,
        anomaly_level: isAbnormal ? fd.get(`level_${i}`) : null,
        anomaly_description: isAbnormal ? fd.get(`desc_${i}`) || null : null,
        evidence: fd.get(`evidence_${i}`) || null,
        remark: fd.get(`remark_${i}`) || null
      });
    });
    try {
      const r = await api(`/tasks/${taskId}/submit`, {
        method: 'POST',
        body: { user_id: currentUser.id, results, remark: fd.get('remark') }
      });
      closeModal();
      alert(`提交成功！生成 ${r.anomalyIds.length} 条异常记录`);
      renderTasks();
    } catch (err) {
      alert('提交失败：' + err.message);
    }
  };
}

async function showCreatePlan() {
  const templates = await api('/templates');
  const devices = await api('/devices');
  openModal('新建巡检计划', `
    <div class="card" style="box-shadow:none;padding:0;">
      <form id="plan-form">
        <div class="form-row">
          <div class="form-group">
            <label>* 计划名称</label>
            <input type="text" name="name" required placeholder="如：A区变压器日巡检">
          </div>
          <div class="form-group">
            <label>巡检周期</label>
            <select name="cycle">
              <option value="daily">每日</option>
              <option value="weekly">每周</option>
              <option value="monthly">每月</option>
            </select>
          </div>
        </div>
        <div class="form-row">
          <div class="form-group">
            <label>设备类型</label>
            <select name="device_type">
              <option value="">不限</option>
              ${deviceTypes.map(t => `<option value="${t}">${t}</option>`).join('')}
            </select>
          </div>
          <div class="form-group">
            <label>区域</label>
            <select name="area">
              <option value="">不限</option>
              ${areas.map(a => `<option value="${a}">${a}</option>`).join('')}
            </select>
          </div>
        </div>
        <div class="form-row">
          <div class="form-group">
            <label>* 开始日期</label>
            <input type="date" name="start_date" value="${todayStr()}" required>
          </div>
          <div class="form-group">
            <label>结束日期</label>
            <input type="date" name="end_date">
          </div>
        </div>
        <div class="form-row">
          <div class="form-group">
            <label>巡检模板</label>
            <select name="template_id">
              <option value="">不使用模板</option>
              ${templates.map(t => `<option value="${t.id}">${t.name}</option>`).join('')}
            </select>
          </div>
          <div class="form-group">
            <label>巡检员</label>
            <select name="inspector_id">
              <option value="">请选择</option>
              ${users.filter(u => u.role !== 'worker').map(u => `<option value="${u.id}">${u.name}</option>`).join('')}
            </select>
          </div>
        </div>
        <div class="form-group">
          <label>关联设备（多选）</label>
          <div style="max-height:150px;overflow-y:auto;border:1px solid #e8e8e8;padding:8px;border-radius:4px;">
            ${devices.map(d => `<label style="display:block;margin:4px 0;"><input type="checkbox" name="device_ids" value="${d.id}"> ${d.code} - ${d.name} (${d.area})</label>`).join('')}
          </div>
        </div>
        <div class="form-group">
          <label>计划描述</label>
          <textarea name="description" rows="2"></textarea>
        </div>
        <div style="text-align:right;margin-top:16px;">
          <button type="button" class="btn" onclick="closeModal()">取消</button>
          <button type="submit" class="btn btn-primary">创建计划</button>
        </div>
      </form>
    </div>
  `);

  $('plan-form').onsubmit = async (e) => {
    e.preventDefault();
    const fd = new FormData(e.target);
    const deviceIds = fd.getAll('device_ids').map(Number);
    const inspectorIds = fd.get('inspector_id') ? [Number(fd.get('inspector_id'))] : [];
    try {
      await api('/plans', {
        method: 'POST',
        body: {
          name: fd.get('name'),
          cycle: fd.get('cycle'),
          device_type: fd.get('device_type') || null,
          area: fd.get('area') || null,
          start_date: fd.get('start_date'),
          end_date: fd.get('end_date') || null,
          template_id: fd.get('template_id') ? Number(fd.get('template_id')) : null,
          inspector_ids: inspectorIds,
          device_ids: deviceIds,
          description: fd.get('description')
        }
      });
      closeModal();
      alert('计划创建成功！');
      renderTasks();
    } catch (err) {
      alert('创建失败：' + err.message);
    }
  };
}

async function renderAnomalies() {
  const content = $('page-content');
  const urlParams = new URLSearchParams(window.location.search);
  const filterStatus = urlParams.get('status') || '';
  const filterLevel = urlParams.get('level') || '';
  const filterArea = urlParams.get('area') || '';
  const overdueOnly = urlParams.get('overdue') === 'true';

  const qs = new URLSearchParams();
  if (filterStatus) qs.set('status', filterStatus);
  if (filterLevel) qs.set('level', filterLevel);
  if (filterArea) qs.set('area', filterArea);
  if (overdueOnly) qs.set('overdue', 'true');

  const anomalies = await api(`/anomalies?${qs.toString()}`);

  content.innerHTML = `
    <div class="page-header">
      <h2>⚠️ 异常闭环管理</h2>
      <button class="btn btn-primary" onclick="location.reload();">🔄 刷新</button>
    </div>

    <div class="stat-grid">
      <div class="stat-card orange">
        <div class="stat-label">待处理异常</div>
        <div class="stat-value">${anomalies.filter(a => a.status === 'pending').length}</div>
      </div>
      <div class="stat-card blue">
        <div class="stat-label">整改中</div>
        <div class="stat-value">${anomalies.filter(a => a.status === 'assigned' || a.status === 'processing').length}</div>
      </div>
      <div class="stat-card red">
        <div class="stat-label">待复查</div>
        <div class="stat-value">${anomalies.filter(a => a.status === 'rechecking').length}</div>
      </div>
      <div class="stat-card green">
        <div class="stat-label">已关闭</div>
        <div class="stat-value">${anomalies.filter(a => a.status === 'closed').length}</div>
      </div>
    </div>

    <div class="card">
      <div class="toolbar">
        <label>状态：</label>
        <select id="a-status-filter" onchange="filterAnomalies()">
          <option value="">全部</option>
          <option value="pending">待分配</option>
          <option value="assigned">已分配</option>
          <option value="rechecking">待复查</option>
          <option value="reject">已退回</option>
          <option value="closed">已关闭</option>
        </select>
        <label>等级：</label>
        <select id="a-level-filter" onchange="filterAnomalies()">
          <option value="">全部</option>
          <option value="紧急">紧急</option>
          <option value="严重">严重</option>
          <option value="一般">一般</option>
          <option value="轻微">轻微</option>
        </select>
        <label>区域：</label>
        <select id="a-area-filter" onchange="filterAnomalies()">
          <option value="">全部区域</option>
          ${areas.map(a => `<option value="${a}">${a}</option>`).join('')}
        </select>
        <label><input type="checkbox" id="a-overdue-filter" onchange="filterAnomalies()"> 仅看逾期</label>
      </div>
      <table>
        <thead>
          <tr>
            <th>ID</th>
            <th>设备</th>
            <th>区域</th>
            <th>巡检点</th>
            <th>等级</th>
            <th>描述</th>
            <th>责任人</th>
            <th>截止日期</th>
            <th>状态</th>
            <th>操作</th>
          </tr>
        </thead>
        <tbody>
          ${anomalies.length ? anomalies.map(a => `
            <tr>
              <td>#${a.id}</td>
              <td>${a.device_name}</td>
              <td>${a.area}</td>
              <td>${a.point_name || '-'}</td>
              <td>${levelBadge(a.level)}</td>
              <td style="max-width:200px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${a.description}</td>
              <td>${a.responsible_name || '-'}</td>
              <td>${a.deadline || '-'} ${a.is_overdue ? '<span style=\"color:#f5222d;font-weight:bold;\">逾期</span>' : ''}</td>
              <td>${statusBadge(a.status)}</td>
              <td>
                <button class="btn btn-sm" onclick="showAnomalyDetail(${a.id})">详情</button>
                ${a.status === 'pending' ? `<button class="btn btn-sm btn-primary" onclick="assignAnomaly(${a.id})">分配</button>` : ''}
                ${a.status === 'assigned' || a.status === 'processing' ? `<button class="btn btn-sm btn-primary" onclick="showRectifyForm(${a.id})">整改</button>` : ''}
                ${a.status === 'rechecking' ? `<button class="btn btn-sm btn-primary" onclick="showRecheckForm(${a.id})">复查</button>` : ''}
              </td>
            </tr>
          `).join('') : '<tr><td colspan=\"10\"><div class=\"empty-state\"><div class=\"empty-state-icon\">✅</div>暂无异常记录</div></td></tr>'}
        </tbody>
      </table>
    </div>
  `;

  $('a-status-filter').value = filterStatus;
  $('a-level-filter').value = filterLevel;
  $('a-area-filter').value = filterArea;
  $('a-overdue-filter').checked = overdueOnly;
}

function filterAnomalies() {
  const s = $('a-status-filter').value;
  const l = $('a-level-filter').value;
  const a = $('a-area-filter').value;
  const o = $('a-overdue-filter').checked;
  const qs = new URLSearchParams();
  if (s) qs.set('status', s);
  if (l) qs.set('level', l);
  if (a) qs.set('area', a);
  if (o) qs.set('overdue', 'true');
  window.history.replaceState(null, '', `?${qs.toString()}`);
  renderAnomalies();
}

async function showAnomalyDetail(anomalyId) {
  const a = await api(`/anomalies/${anomalyId}`);
  openModal(`异常详情 #${a.id}`, `
    <div class="card" style="box-shadow:none;padding:0;">
      <div class="two-col" style="margin-bottom:16px;">
        <div><b>设备：</b>${a.device_name} (${a.device_code})</div>
        <div><b>区域：</b>${a.area}</div>
        <div><b>巡检点：</b>${a.point_name || '-'}</div>
        <div><b>等级：</b>${levelBadge(a.level)}</div>
        <div><b>报告人：</b>${a.reporter_name || '-'}</div>
        <div><b>责任人：</b>${a.responsible_name || '-'}</div>
        <div><b>任务日期：</b>${a.task_date || '-'}</div>
        <div><b>截止日期：</b>${a.deadline || '-'} ${a.status !== 'closed' && a.deadline && a.deadline < todayStr() ? '<span style=\"color:#f5222d;\">（逾期）</span>' : ''}</div>
        <div><b>状态：</b>${statusBadge(a.status)}</div>
        <div><b>证据：</b>${a.evidence ? `<a class="evidence-link" href="${a.evidence}" target="_blank">查看</a>` : '-'}</div>
      </div>
      <div class="form-group" style="margin-bottom:16px;">
        <label>异常描述</label>
        <div style="padding:10px;background:#fafafa;border-radius:4px;">${a.description}</div>
      </div>

      <div class="section-title">处理时间线</div>
      <div class="timeline">
        ${(a.rectifications || []).map(r => `
          <div class="timeline-item">
            <div class="timeline-title">整改${statusBadge(r.status)} <span class="timeline-time">${r.created_at}</span></div>
            ${r.handler_name ? `<div class="timeline-content">处理人：${r.handler_name}</div>` : ''}
            ${r.measure ? `<div class="timeline-content">整改措施：${r.measure}</div>` : ''}
            ${r.evidence ? `<div class="timeline-content">证据：<a class="evidence-link" href="${r.evidence}" target="_blank">${r.evidence}</a></div>` : ''}
            ${r.extension_request ? `<div class="timeline-content">
              延期申请：${r.extension_days}天，原因：${r.extension_reason}，
              审批：${r.extension_approved === null ? '待审批' : r.extension_approved === 1 ? '已批准' : '已拒绝'}
              ${r.extension_approved === null && currentUser.role === 'admin' ? `
                <button class="btn btn-sm btn-primary" onclick="approveExtension(${r.id}, true)">批准</button>
                <button class="btn btn-sm btn-danger" onclick="approveExtension(${r.id}, false)">拒绝</button>
              ` : ''}
            </div>` : ''}
          </div>
        `).join('')}
        ${(a.rechecks || []).map(rc => `
          <div class="timeline-item">
            <div class="timeline-title">复查${rc.result === 'pass' ? '<span class=\"badge badge-closed\">通过</span>' : '<span class=\"badge badge-reject\">退回</span>'} <span class="timeline-time">${rc.rechecked_at}</span></div>
            ${rc.rechecker_name ? `<div class="timeline-content">复查人：${rc.rechecker_name}</div>` : ''}
            ${rc.remark ? `<div class="timeline-content">备注：${rc.remark}</div>` : ''}
            ${rc.evidence ? `<div class="timeline-content">证据：<a class="evidence-link" href="${rc.evidence}" target="_blank">${rc.evidence}</a></div>` : ''}
          </div>
        `).join('')}
      </div>

      <div style="margin-top:16px;display:flex;gap:8px;">
        ${a.status === 'pending' ? `<button class="btn btn-primary" onclick="assignAnomaly(${a.id})">分配责任人</button>` : ''}
        ${a.status === 'assigned' || a.status === 'processing' ? `
          <button class="btn btn-primary" onclick="showRectifyForm(${a.id})">提交整改</button>
          <button class="btn" onclick="showExtensionForm(${a.id})">申请延期</button>
        ` : ''}
        ${a.status === 'rechecking' ? `<button class="btn btn-primary" onclick="showRecheckForm(${a.id})">复查</button>` : ''}
        <button class="btn" onclick="closeModal()">关闭</button>
      </div>
    </div>
  `);
}

async function approveExtension(rectId, approved) {
  try {
    await api(`/rectifications/${rectId}/approve-extension`, {
      method: 'POST', body: { approved }
    });
    alert(approved ? '已批准延期' : '已拒绝延期');
    closeModal();
    renderAnomalies();
  } catch (e) { alert(e.message); }
}

async function assignAnomaly(anomalyId) {
  openModal('分配责任人', `
    <div class="card" style="box-shadow:none;padding:0;">
      <form id="assign-form">
        <div class="form-group">
          <label>选择责任人</label>
          <select name="responsible_id" required>
            <option value="">请选择</option>
            ${users.map(u => `<option value="${u.id}">${u.name} (${u.role})</option>`).join('')}
          </select>
        </div>
        <div style="text-align:right;margin-top:16px;">
          <button type="button" class="btn" onclick="closeModal()">取消</button>
          <button type="submit" class="btn btn-primary">确认分配</button>
        </div>
      </form>
    </div>
  `);
  $('assign-form').onsubmit = async (e) => {
    e.preventDefault();
    const fd = new FormData(e.target);
    try {
      await api(`/anomalies/${anomalyId}/assign`, {
        method: 'POST', body: { responsible_id: Number(fd.get('responsible_id')) }
      });
      closeModal();
      alert('分配成功！');
      renderAnomalies();
    } catch (err) { alert(err.message); }
  };
}

async function showRectifyForm(anomalyId) {
  openModal('提交整改措施', `
    <div class="card" style="box-shadow:none;padding:0;">
      <form id="rectify-form">
        <div class="form-group">
          <label>* 整改措施</label>
          <textarea name="measure" rows="3" required placeholder="请描述具体整改措施"></textarea>
        </div>
        <div class="form-group">
          <label>整改证据链接</label>
          <input type="text" name="evidence" placeholder="照片/文档链接（可选）">
        </div>
        <div style="text-align:right;margin-top:16px;">
          <button type="button" class="btn" onclick="closeModal()">取消</button>
          <button type="button" class="btn" onclick="closeModal();setTimeout(()=>showExtensionForm(${anomalyId}),100);">申请延期</button>
          <button type="submit" class="btn btn-primary">提交整改</button>
        </div>
      </form>
    </div>
  `);
  $('rectify-form').onsubmit = async (e) => {
    e.preventDefault();
    const fd = new FormData(e.target);
    try {
      await api(`/anomalies/${anomalyId}/rectify`, {
        method: 'POST',
        body: {
          handler_id: currentUser.id,
          measure: fd.get('measure'),
          evidence: fd.get('evidence') || null
        }
      });
      closeModal();
      alert('整改已提交，等待复查！');
      renderAnomalies();
    } catch (err) { alert(err.message); }
  };
}

async function showExtensionForm(anomalyId) {
  openModal('申请延期', `
    <div class="card" style="box-shadow:none;padding:0;">
      <form id="ext-form">
        <div class="form-row">
          <div class="form-group">
            <label>* 延天天数</label>
            <input type="number" name="days" min="1" max="30" value="3" required>
          </div>
        </div>
        <div class="form-group">
          <label>* 延期原因</label>
          <textarea name="reason" rows="2" required placeholder="请说明延期原因"></textarea>
        </div>
        <div style="text-align:right;margin-top:16px;">
          <button type="button" class="btn" onclick="closeModal()">取消</button>
          <button type="submit" class="btn btn-primary">提交申请</button>
        </div>
      </form>
    </div>
  `);
  $('ext-form').onsubmit = async (e) => {
    e.preventDefault();
    const fd = new FormData(e.target);
    try {
      await api(`/anomalies/${anomalyId}/extension`, {
        method: 'POST',
        body: { reason: fd.get('reason'), days: Number(fd.get('days')) }
      });
      closeModal();
      alert('延期申请已提交！');
      renderAnomalies();
    } catch (err) { alert(err.message); }
  };
}

async function showRecheckForm(anomalyId) {
  openModal('复查结果', `
    <div class="card" style="box-shadow:none;padding:0;">
      <form id="recheck-form">
        <div class="form-group">
          <label>* 复查结果</label>
          <select name="result" required>
            <option value="">请选择</option>
            <option value="pass">复查通过</option>
            <option value="fail">退回整改</option>
          </select>
        </div>
        <div class="form-group">
          <label>复查备注</label>
          <textarea name="remark" rows="2" placeholder="请填写复查意见"></textarea>
        </div>
        <div class="form-group">
          <label>复查证据链接</label>
          <input type="text" name="evidence" placeholder="照片/文档链接（可选）">
        </div>
        <div style="text-align:right;margin-top:16px;">
          <button type="button" class="btn" onclick="closeModal()">取消</button>
          <button type="submit" class="btn btn-primary">提交复查</button>
        </div>
      </form>
    </div>
  `);
  $('recheck-form').onsubmit = async (e) => {
    e.preventDefault();
    const fd = new FormData(e.target);
    try {
      await api(`/anomalies/${anomalyId}/recheck`, {
        method: 'POST',
        body: {
          rechecker_id: currentUser.id,
          result: fd.get('result'),
          remark: fd.get('remark') || null,
          evidence: fd.get('evidence') || null
        }
      });
      closeModal();
      alert(fd.get('result') === 'pass' ? '复查通过，异常已关闭！' : '已退回整改！');
      renderAnomalies();
    } catch (err) { alert(err.message); }
  };
}

async function renderDevices() {
  const content = $('page-content');
  const urlParams = new URLSearchParams(window.location.search);
  const filterArea = urlParams.get('area') || '';
  const filterType = urlParams.get('type') || '';
  const keyword = urlParams.get('keyword') || '';

  const qs = new URLSearchParams();
  if (filterArea) qs.set('area', filterArea);
  if (filterType) qs.set('type', filterType);
  if (keyword) qs.set('keyword', keyword);

  const devices = await api(`/devices?${qs.toString()}`);

  content.innerHTML = `
    <div class="page-header">
      <h2>🔧 设备档案</h2>
      <button class="btn btn-primary" onclick="showCreateDevice()">➕ 新增设备</button>
    </div>

    <div class="card">
      <div class="toolbar">
        <input type="text" id="d-keyword" placeholder="搜索设备名称/编号" value="${keyword}" style="width:200px;">
        <label>类型：</label>
        <select id="d-type-filter">
          <option value="">全部类型</option>
          ${deviceTypes.map(t => `<option value="${t}" ${t === filterType ? 'selected' : ''}>${t}</option>`).join('')}
        </select>
        <label>区域：</label>
        <select id="d-area-filter">
          <option value="">全部区域</option>
          ${areas.map(a => `<option value="${a}" ${a === filterArea ? 'selected' : ''}>${a}</option>`).join('')}
        </select>
        <button class="btn btn-primary" onclick="filterDevices()">搜索</button>
      </div>
      <table>
        <thead>
          <tr>
            <th>设备编号</th>
            <th>设备名称</th>
            <th>类型</th>
            <th>区域</th>
            <th>状态</th>
            <th>安装日期</th>
            <th>巡检点数</th>
            <th>异常数</th>
            <th>操作</th>
          </tr>
        </thead>
        <tbody>
          ${devices.length ? devices.map(d => `
            <tr>
              <td><b>${d.code}</b></td>
              <td>${d.name}</td>
              <td>${d.type}</td>
              <td>${d.area}</td>
              <td><span class="badge badge-${d.status === '正常' ? 'closed' : 'pending'}">${d.status}</span></td>
              <td>${d.install_date || '-'}</td>
              <td>${(d.points || []).length}</td>
              <td>${d.anomaly_count || 0}</td>
              <td>
                <button class="btn btn-sm" onclick="showDeviceDetail(${d.id})">详情</button>
              </td>
            </tr>
          `).join('') : '<tr><td colspan=\"9\"><div class=\"empty-state\"><div class=\"empty-state-icon\">🔧</div>暂无设备</div></td></tr>'}
        </tbody>
      </table>
    </div>
  `;
}

function filterDevices() {
  const k = $('d-keyword').value;
  const t = $('d-type-filter').value;
  const a = $('d-area-filter').value;
  const qs = new URLSearchParams();
  if (k) qs.set('keyword', k);
  if (t) qs.set('type', t);
  if (a) qs.set('area', a);
  window.history.replaceState(null, '', `?${qs.toString()}`);
  renderDevices();
}

async function showDeviceDetail(deviceId) {
  const d = await api(`/devices/${deviceId}`);
  openModal(`设备详情 - ${d.name}`, `
    <div class="card" style="box-shadow:none;padding:0;">
      <div class="two-col" style="margin-bottom:16px;">
        <div><b>设备编号：</b>${d.code}</div>
        <div><b>设备名称：</b>${d.name}</div>
        <div><b>类型：</b>${d.type}</div>
        <div><b>区域：</b>${d.area}</div>
        <div><b>状态：</b>${d.status}</div>
        <div><b>安装日期：</b>${d.install_date || '-'}</div>
      </div>
      ${d.description ? `<div class="form-group" style="margin-bottom:16px;"><label>设备描述</label><div style="padding:10px;background:#fafafa;border-radius:4px;">${d.description}</div></div>` : ''}

      <div class="section-title">巡检点</div>
      <table>
        <thead><tr><th>序号</th><th>巡检点名称</th><th>检查标准</th><th>检查方法</th></tr></thead>
        <tbody>
          ${(d.points || []).map((p, i) => `
            <tr><td>${i + 1}</td><td>${p.name}</td><td>${p.standard || '-'}</td><td>${p.method || '-'}</td></tr>
          `).join('') || '<tr><td colspan=\"4\"><div class=\"empty-state\">暂无巡检点</div></td></tr>'}
        </tbody>
      </table>

      <div class="section-title" style="margin-top:16px;">异常历史</div>
      <table>
        <thead><tr><th>ID</th><th>等级</th><th>描述</th><th>状态</th><th>报告人</th><th>报告时间</th></tr></thead>
        <tbody>
          ${(d.anomalies || []).map(a => `
            <tr>
              <td>#${a.id}</td>
              <td>${levelBadge(a.level)}</td>
              <td>${a.description}</td>
              <td>${statusBadge(a.status)}</td>
              <td>${a.reporter_name || '-'}</td>
              <td>${a.reported_at}</td>
            </tr>
          `).join('') || '<tr><td colspan=\"6\"><div class=\"empty-state\">暂无异常记录</div></td></tr>'}
        </tbody>
      </table>

      <div style="text-align:right;margin-top:16px;">
        <button class="btn" onclick="closeModal()">关闭</button>
      </div>
    </div>
  `);
}

async function showCreateDevice() {
  openModal('新增设备', `
    <div class="card" style="box-shadow:none;padding:0;">
      <form id="device-form">
        <div class="form-row">
          <div class="form-group">
            <label>* 设备编号</label>
            <input type="text" name="code" required placeholder="如：DEV-009">
          </div>
          <div class="form-group">
            <label>* 设备名称</label>
            <input type="text" name="name" required>
          </div>
        </div>
        <div class="form-row">
          <div class="form-group">
            <label>* 设备类型</label>
            <select name="type" required>
              <option value="">请选择</option>
              ${deviceTypes.map(t => `<option value="${t}">${t}</option>`).join('')}
              <option value="其他">其他</option>
            </select>
          </div>
          <div class="form-group">
            <label>* 所在区域</label>
            <select name="area" required>
              <option value="">请选择</option>
              ${areas.map(a => `<option value="${a}">${a}</option>`).join('')}
            </select>
          </div>
        </div>
        <div class="form-row">
          <div class="form-group">
            <label>安装日期</label>
            <input type="date" name="install_date">
          </div>
          <div class="form-group">
            <label>状态</label>
            <select name="status">
              <option value="正常">正常</option>
              <option value="维修中">维修中</option>
              <option value="停用">停用</option>
            </select>
          </div>
        </div>
        <div class="form-group">
          <label>设备描述</label>
          <textarea name="description" rows="2"></textarea>
        </div>
        <div style="text-align:right;margin-top:16px;">
          <button type="button" class="btn" onclick="closeModal()">取消</button>
          <button type="submit" class="btn btn-primary">创建设备</button>
        </div>
      </form>
    </div>
  `);
  $('device-form').onsubmit = async (e) => {
    e.preventDefault();
    const fd = new FormData(e.target);
    try {
      await api('/devices', {
        method: 'POST',
        body: {
          code: fd.get('code'),
          name: fd.get('name'),
          type: fd.get('type'),
          area: fd.get('area'),
          status: fd.get('status'),
          install_date: fd.get('install_date') || null,
          description: fd.get('description') || null
        }
      });
      closeModal();
      alert('设备创建成功！');
      renderDevices();
    } catch (err) { alert(err.message); }
  };
}

window.onload = initApp;

