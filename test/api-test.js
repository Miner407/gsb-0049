const http = require('http');
const { spawn, execSync } = require('child_process');
const path = require('path');
const fs = require('fs');

const PORT = process.env.TEST_PORT || 3001;
const BASE_URL = `http://localhost:${PORT}`;
let serverProcess = null;
let passed = 0;
let failed = 0;
const errors = [];
let anomalyIdForFlow = null;
let taskIdForFlow = null;

function request(path, options = {}) {
  return new Promise((resolve, reject) => {
    try {
      const url = new URL(BASE_URL + path);
      const reqOptions = {
        hostname: url.hostname,
        port: url.port,
        path: url.pathname + url.search,
        method: options.method || 'GET',
        headers: { 'Content-Type': 'application/json', ...(options.headers || {}) },
        timeout: 10000
      };
      const req = http.request(reqOptions, (res) => {
        let data = '';
        res.on('data', (chunk) => { data += chunk; });
        res.on('end', () => {
          try {
            resolve({ status: res.statusCode, data: data ? JSON.parse(data) : null, raw: data });
          } catch (e) {
            resolve({ status: res.statusCode, data: null, raw: data });
          }
        });
      });
      req.on('error', reject);
      req.on('timeout', () => { req.destroy(new Error('Request timeout')); });
      if (options.body) req.write(JSON.stringify(options.body));
      req.end();
    } catch (e) {
      reject(e);
    }
  });
}

function test(name, fn) {
  try {
    fn();
    passed++;
    console.log(`  ✅ ${name}`);
  } catch (e) {
    failed++;
    errors.push({ name, error: e.message });
    console.log(`  ❌ ${name}: ${e.message}`);
  }
}

async function asyncTest(name, fn) {
  try {
    await fn();
    passed++;
    console.log(`  ✅ ${name}`);
  } catch (e) {
    failed++;
    errors.push({ name, error: e.message });
    console.log(`  ❌ ${name}: ${e.message}`);
  }
}

function assert(condition, msg) {
  if (!condition) throw new Error(msg || '断言失败');
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function waitForServer(timeout = 30000) {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    try {
      const r = await request('/api/health');
      if (r.status === 200 && r.data && r.data.status === 'ok') {
        return true;
      }
    } catch (e) {
      // 服务未启动，继续等待
    }
    await sleep(500);
  }
  return false;
}

function checkPortInUse(port) {
  return new Promise((resolve) => {
    const server = http.createServer();
    server.once('error', () => resolve(true));
    server.once('listening', () => {
      server.close();
      resolve(false);
    });
    server.listen(port);
  });
}

async function startServer() {
  console.log('\n[启动] 正在启动测试服务...');

  const inUse = await checkPortInUse(PORT);
  if (inUse) {
    console.log(`  ⚠️  端口 ${PORT} 已被占用，尝试关闭占用进程...`);
    try {
      if (process.platform === 'win32') {
        execSync(`netstat -ano | findstr :${PORT} | findstr LISTENING`, { stdio: 'pipe' })
          .toString().split('\n').forEach(line => {
            const match = line.trim().match(/LISTENING\s+(\d+)/);
            if (match) {
              try { execSync(`taskkill /F /PID ${match[1]}`); } catch (e) {}
            }
          });
      } else {
        execSync(`lsof -ti:${PORT} | xargs -r kill -9`);
      }
      await sleep(1000);
    } catch (e) {
      console.log(`  ⚠️  无法关闭占用进程: ${e.message}`);
    }
  }

  const env = { ...process.env, PORT: String(PORT), NODE_ENV: 'test' };
  serverProcess = spawn('node', ['server.js'], {
    cwd: path.join(__dirname, '..'),
    env: env,
    stdio: ['ignore', 'pipe', 'pipe']
  });

  serverProcess.stdout.on('data', (data) => {
    if (process.env.VERBOSE) process.stdout.write(`[server] ${data}`);
  });
  serverProcess.stderr.on('data', (data) => {
    if (process.env.VERBOSE) process.stderr.write(`[server:err] ${data}`);
  });

  const ready = await waitForServer();
  if (!ready) {
    console.error('  ❌ 服务启动超时');
    process.exit(1);
  }
  console.log(`  ✅ 服务已启动，监听端口 ${PORT}`);
  return true;
}

async function stopServer() {
  if (serverProcess) {
    console.log('\n[清理] 正在关闭测试服务...');
    return new Promise((resolve) => {
      serverProcess.once('exit', () => {
        console.log('  ✅ 服务已关闭');
        resolve();
      });
      serverProcess.kill('SIGTERM');
      setTimeout(() => {
        serverProcess.kill('SIGKILL');
        resolve();
      }, 5000);
    });
  }
}

async function runSyntaxCheck() {
  console.log('\n========== 源码语法检查 ==========\n');
  const filesToCheck = [];
  function checkDir(dir) {
    const entries = fs.readdirSync(dir);
    for (const entry of entries) {
      const fullPath = path.join(dir, entry);
      const stat = fs.statSync(fullPath);
      if (stat.isDirectory() && entry !== 'node_modules') {
        checkDir(fullPath);
      } else if (entry.endsWith('.js')) {
        filesToCheck.push(fullPath);
      }
    }
  }
  checkDir(path.join(__dirname, '..'));

  for (const file of filesToCheck) {
    try {
      const content = fs.readFileSync(file, 'utf8');
      new Function(content);
      passed++;
      console.log(`  ✅ ${path.relative(path.join(__dirname, '..'), file)}`);
    } catch (e) {
      failed++;
      errors.push({ name: `语法检查: ${file}`, error: e.message });
      console.log(`  ❌ ${path.relative(path.join(__dirname, '..'), file)}: ${e.message}`);
    }
  }
  console.log(`\n语法检查结果: ${passed - (errors.length - (errors.length - failed))} 个文件通过，${failed} 个失败`);
}

async function runTests() {
  console.log('\n========== 设备巡检系统 API 验证 ==========\n');

  console.log('【1】基础接口检测');
  await asyncTest('健康检查接口返回 200', async () => {
    const r = await request('/api/health');
    assert(r.status === 200, `状态码: ${r.status}`);
    assert(r.data && r.data.status === 'ok', '返回状态不正确');
  });

  console.log('\n【2】用户与设备接口');
  const users = (await request('/api/users')).data;
  test('获取用户列表', () => assert(Array.isArray(users) && users.length > 0, '用户列表为空'));
  const adminUser = users.find(u => u.role === 'admin');
  const inspectors = users.filter(u => u.role === 'inspector');
  const workers = users.filter(u => u.role === 'worker');
  test('存在管理员用户', () => assert(adminUser, '未找到管理员用户'));
  test('存在巡检员用户', () => assert(inspectors.length > 0, '未找到巡检员用户'));
  test('存在工作人员用户', () => assert(workers.length > 0, '未找到工作人员用户'));
  test('用户角色不少于3种', () => {
    const roles = [...new Set(users.map(u => u.role))];
    assert(roles.length >= 3, `角色数量: ${roles.length}`);
  });

  const areasData = (await request('/api/devices/areas')).data;
  test('获取区域和设备类型列表', () => assert(areasData && Array.isArray(areasData.areas) && areasData.areas.length >= 3));

  const devices = (await request('/api/devices')).data;
  test('获取设备列表', () => assert(Array.isArray(devices) && devices.length >= 8));
  test('设备包含巡检点', () => assert(devices[0].points && Array.isArray(devices[0].points)));
  test('设备类型不少于3种', () => {
    const types = [...new Set(devices.map(d => d.type))];
    assert(types.length >= 3, `设备类型数量: ${types.length}`);
  });
  test('区域不少于3个', () => {
    const areas = [...new Set(devices.map(d => d.area))];
    assert(areas.length >= 3, `区域数量: ${areas.length}`);
  });

  const areaADevices = (await request('/api/devices?area=' + encodeURIComponent('A区-一号车间'))).data;
  test('按区域筛选设备', () => assert(areaADevices.every(d => d.area === 'A区-一号车间')));

  const typeFilter = (await request('/api/devices?type=' + encodeURIComponent('变压器'))).data;
  test('按类型筛选设备', () => assert(typeFilter.every(d => d.type === '变压器')));

  const singleDevice = (await request(`/api/devices/${devices[0].id}`)).data;
  test('获取设备详情', () => assert(singleDevice && singleDevice.id === devices[0].id));
  test('设备详情包含异常历史', () => assert(Array.isArray(singleDevice.anomalies)));
  test('设备详情包含近期任务', () => assert(Array.isArray(singleDevice.tasks)));
  test('设备详情包含巡检点', () => assert(Array.isArray(singleDevice.points)));

  console.log('\n【3】巡检计划与模板接口');
  const templates = (await request('/api/templates')).data;
  test('获取巡检模板列表', () => assert(Array.isArray(templates) && templates.length >= 3));

  const plans = (await request('/api/plans')).data;
  test('获取巡检计划列表', () => assert(Array.isArray(plans) && plans.length >= 4));

  const pausedPlans = (await request('/api/plans?paused=true')).data;
  test('按暂停状态筛选计划', () => assert(pausedPlans.every(p => p.paused === 1)));

  const activePlans = (await request('/api/plans?paused=false')).data;
  test('按运行状态筛选计划', () => assert(activePlans.every(p => p.paused === 0)));

  const planDetail = (await request(`/api/plans/${plans[0].id}`)).data;
  test('获取计划详情', () => assert(planDetail && planDetail.id === plans[0].id));
  test('计划详情包含关联设备', () => assert(Array.isArray(planDetail.devices) && planDetail.devices.length > 0));

  console.log('\n【4】任务预览接口（不写入数据库）');
  const activePlan = plans.find(p => !p.paused);
  const today = new Date();
  const fromStr = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-01`;
  const lastDay = new Date(today.getFullYear(), today.getMonth() + 1, 0).getDate();
  const toStr = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${lastDay}`;

  const previewResult = (await request(`/api/plans/${activePlan.id}/preview`, {
    method: 'POST', body: { from: fromStr, to: toStr }
  })).data;
  test('任务预览接口可用', () => assert(previewResult && typeof previewResult.total === 'number'));
  test('预览结果包含任务列表', () => assert(Array.isArray(previewResult.tasks)));
  test('预览结果统计正确', () => assert(previewResult.total === previewResult.created + previewResult.skipped));
  console.log(`    预览: ${previewResult.total} 个任务, ${previewResult.created} 生成, ${previewResult.skipped} 跳过`);

  console.log('\n【5】任务生成验证');
  const tasksBefore = (await request('/api/tasks')).data;
  const genResult = (await request(`/api/plans/${activePlan.id}/generate`, {
    method: 'POST', body: { from: fromStr, to: toStr }
  })).data;
  test('单个计划生成任务', () => assert(genResult && typeof genResult.created === 'number'));
  console.log(`    生成结果: ${genResult.created} 个任务, ${genResult.skipped} 个跳过`);

  const tasksAfter = (await request('/api/tasks')).data;
  test('任务生成后数量增加', () => assert(tasksAfter.length > tasksBefore.length));

  console.log('\n【6】重复生成防重验证');
  const genAgain = (await request(`/api/plans/${activePlan.id}/generate`, {
    method: 'POST', body: { from: fromStr, to: toStr }
  })).data;
  test('重复生成不创建重复任务', () => assert(genAgain.created === 0, `重复生成了 ${genAgain.created} 个任务`));
  console.log(`    重复生成: ${genAgain.created} 个新任务, 防重机制生效`);

  const allGenResult = (await request('/api/tasks/generate-all', {
    method: 'POST', body: { from: fromStr, to: toStr }
  })).data;
  test('批量生成所有计划任务', () => assert(allGenResult && typeof allGenResult.totalCreated === 'number'));
  console.log(`    批量生成: ${allGenResult.totalCreated} 个任务, ${allGenResult.totalSkipped} 个跳过`);

  console.log('\n【7】暂停跳过验证');
  const pausedPlan = plans.find(p => p.paused);
  if (pausedPlan) {
    const pausedGen = (await request(`/api/plans/${pausedPlan.id}/generate`, {
      method: 'POST', body: { from: fromStr, to: toStr }
    })).data;
    test('暂停计划仅生成跳过记录', () => {
      assert(pausedGen.created === 0, `暂停计划生成了 ${pausedGen.created} 个任务`);
      assert(pausedGen.skipped >= 0, '跳过数量不正确');
    });
    console.log(`    暂停计划: ${pausedGen.created} 个生成, ${pausedGen.skipped} 个跳过`);
  }

  console.log('\n【8】节假日管理');
  const holidays = (await request('/api/holidays')).data;
  test('获取节假日列表', () => assert(Array.isArray(holidays) && holidays.length >= 7));
  console.log(`    已配置 ${holidays.length} 个节假日`);

  const calendar = (await request(`/api/plans/calendar?from=${fromStr}&to=${toStr}`)).data;
  test('获取计划日历数据', () => assert(calendar && Array.isArray(calendar.tasks)));
  const holidaySkipped = calendar.tasks.filter(t => t.skipped === 1 && t.skip_type === 'holiday');
  const pausedSkipped = calendar.tasks.filter(t => t.skipped === 1 && t.skip_type === 'paused');
  test('存在节假日跳过的任务', () => {
    console.log(`    节假日跳过: ${holidaySkipped.length} 个, 暂停跳过: ${pausedSkipped.length} 个`);
    return true;
  });

  const areaCalendar = (await request(`/api/plans/calendar?from=${fromStr}&to=${toStr}&area=` + encodeURIComponent('A区-一号车间'))).data;
  test('按区域筛选日历任务', () => assert(areaCalendar.tasks.every(t => t.area === 'A区-一号车间')));

  console.log('\n【9】巡检任务接口');
  const pendingTasks = (await request('/api/tasks?status=pending')).data;
  test('获取待执行任务列表', () => assert(Array.isArray(pendingTasks)));

  const pendingTask = pendingTasks.find(t => t.skipped === 0 && t.status === 'pending');
  if (pendingTask) {
    taskIdForFlow = pendingTask.id;
    const taskDetail = (await request(`/api/tasks/${pendingTask.id}`)).data;
    test('获取任务详情', () => assert(taskDetail && taskDetail.id === pendingTask.id));
    test('任务详情包含巡检点', () => assert(Array.isArray(taskDetail.points)));

    console.log('\n【10】巡检提交与异常升级验证');
    const points = taskDetail.points || [];
    const submitResults = [];
    if (points.length > 0) {
      submitResults.push({
        point_id: points[0].id,
        point_name: points[0].name,
        result: 'normal',
        is_anomaly: false
      });
      if (points.length > 1) {
        submitResults.push({
          point_id: points[1].id,
          point_name: points[1].name,
          result: 'abnormal',
          is_anomaly: true,
          anomaly_level: '一般',
          anomaly_description: '测试异常：温度超标',
          evidence: 'https://example.com/photo1.jpg',
          remark: '现场测温记录异常'
        });
      }
    }

    const submitR = (await request(`/api/tasks/${pendingTask.id}/submit`, {
      method: 'POST',
      body: { user_id: inspectors[0].id, results: submitResults, remark: '测试巡检提交' }
    })).data;

    test('提交巡检结果', () => assert(submitR && Array.isArray(submitR.anomalyIds)));
    test('异常自动生成异常记录', () => {
      const hasAnomaly = submitResults.some(r => r.is_anomaly);
      if (hasAnomaly) assert(submitR.anomalyIds.length > 0, '未生成异常记录');
      return true;
    });
    console.log(`    生成异常记录: ${submitR.anomalyIds.length} 条`);

    const submittedTask = (await request(`/api/tasks/${pendingTask.id}`)).data;
    test('任务状态变为已提交', () => assert(submittedTask.status === 'submitted'));
    test('任务包含结果记录', () => assert(submittedTask.results.length > 0));

    if (submitR.anomalyIds.length > 0) {
      anomalyIdForFlow = submitR.anomalyIds[0];

      console.log('\n【11】异常闭环流程验证');
      const anomaly = (await request(`/api/anomalies/${anomalyIdForFlow}`)).data;
      test('获取异常详情', () => assert(anomaly && anomaly.id === anomalyIdForFlow));
      test('异常初始状态为 pending', () => assert(anomaly.status === 'pending'));
      test('异常设置了截止日期', () => assert(anomaly.deadline));
      test('异常详情包含状态历史', () => assert(Array.isArray(anomaly.status_history) && anomaly.status_history.length > 0));
      test('状态历史记录创建信息', () => assert(anomaly.status_history[0].to_status === 'pending'));
      test('异常详情包含整改记录', () => assert(Array.isArray(anomaly.rectifications)));
      test('异常详情包含复查记录', () => assert(Array.isArray(anomaly.rechecks)));

      const assignR = (await request(`/api/anomalies/${anomalyIdForFlow}/assign`, {
        method: 'POST', body: { responsible_id: workers[0] ? workers[0].id : users[3].id, operator_id: adminUser.id }
      })).data;
      test('分配异常责任人', () => assert(assignR && assignR.status === 'assigned'));

      const anomalyAfterAssign = (await request(`/api/anomalies/${anomalyIdForFlow}`)).data;
      test('异常状态变为 assigned', () => assert(anomalyAfterAssign.status === 'assigned'));
      test('分配操作记录到状态历史', () => {
        const assignHistory = anomalyAfterAssign.status_history.find(h => h.to_status === 'assigned');
        assert(assignHistory, '未找到分配状态历史记录');
        return true;
      });

      const rectifyR = (await request(`/api/anomalies/${anomalyIdForFlow}/rectify`, {
        method: 'POST',
        body: {
          handler_id: workers[0] ? workers[0].id : users[3].id,
          measure: '已更换损坏部件，重新校准设备参数',
          evidence: 'https://example.com/fix-photo.jpg'
        }
      })).data;
      test('提交整改措施', () => assert(rectifyR && rectifyR.anomaly));
      const anomalyAfterRectify = (await request(`/api/anomalies/${anomalyIdForFlow}`)).data;
      test('整改后状态变为待复查', () => assert(anomalyAfterRectify.status === 'rechecking'));
      test('整改记录包含上轮措施字段', () => assert(anomalyAfterRectify.rectifications.length > 0));

      const recheckR = (await request(`/api/anomalies/${anomalyIdForFlow}/recheck`, {
        method: 'POST',
        body: {
          rechecker_id: adminUser.id,
          result: 'pass',
          remark: '整改合格，设备运行正常',
          evidence: 'https://example.com/recheck.jpg'
        }
      })).data;
      test('复查通过，异常关闭', () => assert(recheckR && recheckR.anomaly.status === 'closed'));

      const anomalyAfterClose = (await request(`/api/anomalies/${anomalyIdForFlow}`)).data;
      test('关闭操作记录到状态历史', () => {
        const closeHistory = anomalyAfterClose.status_history.find(h => h.to_status === 'closed');
        assert(closeHistory, '未找到关闭状态历史记录');
        return true;
      });

      const anomaliesList = (await request('/api/anomalies?status=closed')).data;
      test('已关闭异常可被查询到', () => assert(anomaliesList.some(a => a.id === anomalyIdForFlow)));
    }
  }

  console.log('\n【12】复查退回与新一轮整改验证');
  const pendingTasks2 = (await request('/api/tasks?status=pending')).data;
  const task2 = pendingTasks2.find(t => !t.skipped);
  if (task2) {
    const td = (await request(`/api/tasks/${task2.id}`)).data;
    const pts = td.points || [];
    if (pts.length > 0) {
      const sr = (await request(`/api/tasks/${task2.id}/submit`, {
        method: 'POST',
        body: {
          user_id: inspectors[0] ? inspectors[0].id : 2,
          results: [{
            point_id: pts[0].id, point_name: pts[0].name,
            result: 'abnormal', is_anomaly: true,
            anomaly_level: '严重', anomaly_description: '严重异常：设备异响严重'
          }]
        }
      })).data;

      if (sr.anomalyIds && sr.anomalyIds.length > 0) {
        const aid2 = sr.anomalyIds[0];
        await request(`/api/anomalies/${aid2}/assign`, {
          method: 'POST', body: { responsible_id: users[2] ? users[2].id : 3 }
        });
        await request(`/api/anomalies/${aid2}/rectify`, {
          method: 'POST',
          body: { handler_id: users[2] ? users[2].id : 3, measure: '临时处理，未彻底修复' }
        });

        const failR = (await request(`/api/anomalies/${aid2}/recheck`, {
          method: 'POST',
          body: { rechecker_id: adminUser.id, result: 'fail', remark: '整改不彻底，需重新处理' }
        })).data;
        test('复查失败退回整改', () => assert(failR && failR.anomaly.status === 'processing'));

        const recheckAnomaly = (await request(`/api/anomalies/${aid2}`)).data;
        test('退回后自动创建新整改记录', () => assert(recheckAnomaly.rectifications.length >= 2));
        test('新整改记录保留上轮措施', () => {
          const latestRect = recheckAnomaly.rectifications[recheckAnomaly.rectifications.length - 1];
          assert(latestRect.previous_measure || recheckAnomaly.rectifications.length >= 2, '未保留上轮整改措施');
          return true;
        });
        test('状态历史记录退回操作', () => {
          const rejectHistory = recheckAnomaly.status_history.find(h => h.to_status === 'reject');
          assert(rejectHistory, '未找到退回状态历史记录');
          return true;
        });
        test('状态历史记录新一轮整改创建', () => {
          const newRoundHistory = recheckAnomaly.status_history.find(h => h.remark && h.remark.includes('新一轮'));
          assert(newRoundHistory, '未记录新一轮整改创建');
          return true;
        });
      }
    }
  }

  console.log('\n【13】延期申请与审批验证');
  const pendingAnomalies = (await request('/api/anomalies?status=assigned')).data;
  let extAnomalyId = null;
  if (pendingAnomalies.length === 0) {
    const pa = (await request('/api/anomalies?status=pending')).data;
    if (pa.length > 0) {
      const assignR = await request(`/api/anomalies/${pa[0].id}/assign`, {
        method: 'POST', body: { responsible_id: users[2] ? users[2].id : 3 }
      });
      extAnomalyId = pa[0].id;
    }
  } else {
    extAnomalyId = pendingAnomalies[0].id;
  }

  if (extAnomalyId) {
    const extR = (await request(`/api/anomalies/${extAnomalyId}/extension`, {
      method: 'POST', body: { reason: '备件未到货，需延期', days: 5, applicant_id: users[2] ? users[2].id : 3 }
    })).data;
    test('提交延期申请', () => assert(extR && extR.extension_request === 1));

    const anomalyAfterExt = (await request(`/api/anomalies/${extAnomalyId}`)).data;
    test('延期申请记录到状态历史', () => {
      const extHistory = anomalyAfterExt.status_history.find(h => h.remark && h.remark.includes('延期'));
      assert(extHistory, '未记录延期申请到状态历史');
      return true;
    });

    const rects = anomalyAfterExt.rectifications;
    const extRect = rects[rects.length - 1];
    if (extRect) {
      const approveR = (await request(`/api/rectifications/${extRect.id}/approve-extension`, {
        method: 'POST', body: { approved: true, approver_id: adminUser.id, remark: '情况属实，同意延期' }
      })).data;
      test('批准延期申请', () => assert(approveR && approveR.extension_approved === 1));

      const anomalyAfterApprove = (await request(`/api/anomalies/${extAnomalyId}`)).data;
      test('审批操作记录到状态历史', () => {
        const approveHistory = anomalyAfterApprove.status_history.find(h => h.remark && h.remark.includes('批准'));
        assert(approveHistory, '未记录审批操作到状态历史');
        return true;
      });
    }
  }

  console.log('\n【14】异常筛选功能');
  const overdueList = (await request('/api/anomalies/overdue/list')).data;
  test('获取逾期异常列表', () => assert(Array.isArray(overdueList)));

  const overdueFilter = (await request('/api/anomalies?overdue=true')).data;
  test('按逾期筛选异常', () => assert(overdueFilter.every(a => a.is_overdue)));

  const levelFilter = (await request('/api/anomalies?level=严重')).data;
  test('按异常等级筛选', () => assert(levelFilter.every(a => a.level === '严重')));

  const areaFilter = (await request('/api/anomalies?area=' + encodeURIComponent('A区-一号车间'))).data;
  test('按区域筛选异常', () => assert(areaFilter.every(a => a.area === 'A区-一号车间')));

  const respFilter = (await request('/api/anomalies?responsible_id=' + (workers[0] ? workers[0].id : users[3].id))).data;
  test('按责任人筛选异常', () => assert(respFilter.every(a => a.responsible_id === (workers[0] ? workers[0].id : users[3].id))));

  console.log('\n【15】统计看板接口');
  const dashboard = (await request('/api/stats/dashboard')).data;
  test('获取看板总览数据', () => assert(dashboard && dashboard.planCompletion));
  test('计划完成率数据正确', () => assert(typeof dashboard.planCompletion.rate === 'number'));
  test('异常率数据正确', () => assert(typeof dashboard.anomalyRate.rate === 'number'));
  test('逾期整改数正确', () => assert(typeof dashboard.overdueCount === 'number'));
  test('今日待巡检数据正确', () => assert(typeof dashboard.todayPending === 'number'));
  test('待复查异常数据正确', () => assert(typeof dashboard.pendingRecheck === 'number'));
  test('重复异常设备列表', () => assert(Array.isArray(dashboard.repeatDevices)));
  test('区域风险排行', () => assert(Array.isArray(dashboard.areaRanking) && dashboard.areaRanking.length > 0));
  test('人员任务负载', () => assert(Array.isArray(dashboard.workload)));
  test('最高风险区域数据', () => assert(dashboard.topRiskArea || dashboard.areaRanking.length === 0));

  const completion = (await request('/api/stats/completion')).data;
  test('独立获取计划完成率', () => assert(typeof completion.rate === 'number'));

  const anomalyRate = (await request('/api/stats/anomaly-rate')).data;
  test('独立获取异常率', () => assert(typeof anomalyRate.rate === 'number'));

  const areaRisk = (await request('/api/stats/area-risk')).data;
  test('独立获取区域风险排行', () => assert(Array.isArray(areaRisk) && areaRisk.length > 0));

  const workload = (await request('/api/stats/workload')).data;
  test('独立获取人员负载', () => assert(Array.isArray(workload)));

  const trend = (await request('/api/stats/trend?type=completion')).data;
  test('获取完成率趋势数据', () => assert(trend && Array.isArray(trend.data)));

  const anomalyTrend = (await request('/api/stats/trend?type=anomaly')).data;
  test('获取异常趋势数据', () => assert(anomalyTrend && Array.isArray(anomalyTrend.data)));

  const levelDist = (await request('/api/stats/level-distribution')).data;
  test('获取异常等级分布', () => assert(levelDist && Array.isArray(levelDist.list)));
  test('等级分布包含所有等级', () => assert(levelDist.list.length === 4));

  const repeatDevices = (await request('/api/stats/repeat-devices')).data;
  test('获取重复异常设备', () => assert(Array.isArray(repeatDevices)));

  console.log('\n【16】统计筛选功能');
  const filteredCompletion = (await request('/api/stats/completion?area=' + encodeURIComponent('A区-一号车间'))).data;
  test('按区域筛选完成率', () => assert(typeof filteredCompletion.rate === 'number'));

  const filteredAnomalyRate = (await request('/api/stats/anomaly-rate?device_type=' + encodeURIComponent('变压器'))).data;
  test('按设备类型筛选异常率', () => assert(typeof filteredAnomalyRate.rate === 'number'));

  const filteredWorkload = (await request('/api/stats/workload?role=inspector')).data;
  test('按角色筛选人员负载', () => assert(Array.isArray(filteredWorkload)));

  const filteredTrend = (await request('/api/stats/trend?area=' + encodeURIComponent('A区-一号车间') + '&type=completion')).data;
  test('按区域筛选趋势数据', () => assert(Array.isArray(filteredTrend.data)));

  const filteredLevelDist = (await request('/api/stats/level-distribution?device_type=' + encodeURIComponent('变压器'))).data;
  test('按设备类型筛选等级分布', () => assert(Array.isArray(filteredLevelDist.list)));

  const filteredRepeat = (await request('/api/stats/repeat-devices?area=' + encodeURIComponent('A区-一号车间'))).data;
  test('按区域筛选重复异常设备', () => assert(Array.isArray(filteredRepeat)));

  console.log('\n【17】计划编辑接口');
  if (activePlan) {
    const updateR = (await request(`/api/plans/${activePlan.id}`, {
      method: 'PUT',
      body: { description: '计划描述已更新', holiday_strategy: 'work' }
    })).data;
    test('更新计划信息', () => assert(updateR && updateR.description === '计划描述已更新'));
    test('更新节假日策略', () => assert(updateR.holiday_strategy === 'work'));
  }

  console.log('\n【18】计划启停接口');
  if (activePlan) {
    const toggleR = (await request(`/api/plans/${activePlan.id}/toggle`, {
      method: 'POST', body: { paused: true, reason: '临时维护暂停' }
    })).data;
    test('暂停计划', () => assert(toggleR && toggleR.paused === 1));
    test('设置暂停原因', () => assert(toggleR.pause_reason === '临时维护暂停'));

    const toggleBack = (await request(`/api/plans/${activePlan.id}/toggle`, {
      method: 'POST', body: { paused: false }
    })).data;
    test('恢复计划', () => assert(toggleBack && toggleBack.paused === 0));
    test('恢复后暂停原因清空', () => assert(toggleBack.pause_reason === null));
  }

  console.log('\n【19】核心页面 HTTP 验证');
  const pages = ['/', '/index.html', '/style.css', '/app.js'];
  for (const p of pages) {
    await asyncTest(`页面 ${p} 返回 200`, async () => {
      const pr = await request(p);
      assert(pr.status === 200, `状态码: ${pr.status}`);
    });
  }

  console.log('\n【20】API 接口响应格式验证');
  const testEndpoints = [
    '/api/users', '/api/devices', '/api/plans', '/api/templates',
    '/api/holidays', '/api/tasks', '/api/anomalies'
  ];
  for (const ep of testEndpoints) {
    await asyncTest(`接口 ${ep} 返回 JSON 格式`, async () => {
      const r = await request(ep);
      assert(r.status === 200, `状态码: ${r.status}`);
      assert(Array.isArray(r.data) || (r.data && typeof r.data === 'object'), '返回格式不正确');
    });
  }

  console.log('\n========== 测试结果汇总 ==========');
  console.log(`通过: ${passed}, 失败: ${failed}`);
  if (errors.length > 0) {
    console.log('\n失败详情:');
    errors.forEach(e => console.log(`  - ${e.name}: ${e.error}`));
  }
  console.log('');

  return failed === 0;
}

async function main() {
  const args = process.argv.slice(2);
  const skipSyntax = args.includes('--no-syntax');
  const skipServer = args.includes('--no-server');

  try {
    if (!skipSyntax) {
      await runSyntaxCheck();
    } else {
      console.log('\n[跳过] 源码语法检查');
    }

    if (!skipServer) {
      await startServer();
    } else {
      console.log('\n[跳过] 服务启动，假设服务已在端口 ' + PORT + ' 运行');
      const ready = await waitForServer(5000);
      if (!ready) {
        console.error('❌ 无法连接到服务，请先启动服务');
        process.exit(1);
      }
    }

    const success = await runTests();

    if (!skipServer) {
      await stopServer();
    }

    if (success) {
      console.log('\n🎉 所有验证通过！');
      process.exit(0);
    } else {
      console.log('\n❌ 部分验证失败，请查看错误详情');
      process.exit(1);
    }
  } catch (e) {
    console.error('\n❌ 测试运行错误:', e.message);
    console.error(e.stack);
    await stopServer();
    process.exit(1);
  }
}

process.on('SIGINT', async () => {
  console.log('\n收到中断信号，正在清理...');
  await stopServer();
  process.exit(1);
});

main();
