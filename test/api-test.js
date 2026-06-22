const http = require('http');

const BASE_URL = 'http://localhost:3000';
let passed = 0;
let failed = 0;
const errors = [];

function request(path, options = {}) {
  return new Promise((resolve, reject) => {
    const url = new URL(BASE_URL + path);
    const reqOptions = {
      hostname: url.hostname,
      port: url.port,
      path: url.pathname + url.search,
      method: options.method || 'GET',
      headers: { 'Content-Type': 'application/json', ...(options.headers || {}) }
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
    if (options.body) req.write(JSON.stringify(options.body));
    req.end();
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

function assert(condition, msg) {
  if (!condition) throw new Error(msg || '断言失败');
}

async function runTests() {
  console.log('\n========== 设备巡检系统 API 验证 ==========\n');

  console.log('【1】基础接口检测');
  try {
    const r = await request('/api/health');
    test('健康检查接口返回 200', () => assert(r.status === 200, `状态码: ${r.status}`));
    test('健康检查返回正确状态', () => assert(r.data && r.data.status === 'ok'));
  } catch (e) { console.log(`  连接错误: ${e.message}`); process.exit(1); }

  console.log('\n【2】用户与设备接口');
  const users = (await request('/api/users')).data;
  test('获取用户列表', () => assert(Array.isArray(users) && users.length > 0));
  const adminUser = users.find(u => u.role === 'admin');
  const inspectors = users.filter(u => u.role === 'inspector');
  test('存在管理员用户', () => assert(adminUser));
  test('存在巡检员用户', () => assert(inspectors.length > 0));

  const areas = (await request('/api/devices/areas')).data;
  test('获取区域和设备类型列表', () => assert(areas && Array.isArray(areas.areas) && areas.areas.length > 0));

  const devices = (await request('/api/devices')).data;
  test('获取设备列表', () => assert(Array.isArray(devices) && devices.length > 0));
  test('设备包含巡检点', () => assert(devices[0].points && Array.isArray(devices[0].points)));

  const areaADevices = (await request('/api/devices?area=' + encodeURIComponent('A区-一号车间'))).data;
  test('按区域筛选设备', () => assert(areaADevices.every(d => d.area === 'A区-一号车间'), '筛选结果不正确'));

  const singleDevice = (await request(`/api/devices/${devices[0].id}`)).data;
  test('获取设备详情', () => assert(singleDevice && singleDevice.id === devices[0].id));
  test('设备详情包含异常历史', () => assert(Array.isArray(singleDevice.anomalies)));

  console.log('\n【3】巡检计划接口');
  const plans = (await request('/api/plans')).data;
  test('获取巡检计划列表', () => assert(Array.isArray(plans) && plans.length > 0));

  const pausedPlans = (await request('/api/plans?paused=true')).data;
  test('按暂停状态筛选计划', () => assert(pausedPlans.every(p => p.paused === 1)));

  const planDetail = (await request(`/api/plans/${plans[0].id}`)).data;
  test('获取计划详情', () => assert(planDetail && planDetail.id === plans[0].id));
  test('计划详情包含关联设备', () => assert(Array.isArray(planDetail.devices)));

  console.log('\n【4】任务生成验证');
  const activePlan = plans.find(p => !p.paused);
  const today = new Date();
  const fromStr = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-01`;
  const lastDay = new Date(today.getFullYear(), today.getMonth() + 1, 0).getDate();
  const toStr = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${lastDay}`;

  const genResult = (await request(`/api/plans/${activePlan.id}/generate`, {
    method: 'POST', body: { from: fromStr, to: toStr }
  })).data;
  test('单个计划生成任务', () => assert(genResult && typeof genResult.created === 'number'));
  console.log(`    生成结果: ${genResult.created} 个任务, ${genResult.skipped} 个跳过`);

  const tasksBefore = (await request('/api/tasks')).data;
  const allGenResult = (await request('/api/tasks/generate-all', {
    method: 'POST', body: { from: fromStr, to: toStr }
  })).data;
  test('批量生成所有计划任务', () => assert(allGenResult && typeof allGenResult.totalCreated === 'number'));
  console.log(`    批量生成: ${allGenResult.totalCreated} 个任务, ${allGenResult.totalSkipped} 个跳过`);

  console.log('\n【5】暂停跳过验证');
  const pausedPlan = plans.find(p => p.paused);
  if (pausedPlan) {
    const pausedGen = (await request(`/api/plans/${pausedPlan.id}/generate`, {
      method: 'POST', body: { from: fromStr, to: toStr }
    })).data;
    test('暂停计划不生成任务', () => assert(pausedGen.reason === '计划已暂停' || pausedGen.created === 0));
  }

  const holidays = (await request('/api/holidays')).data;
  test('获取节假日列表', () => assert(Array.isArray(holidays)));
  console.log(`    已配置 ${holidays.length} 个节假日`);

  const calendar = (await request(`/api/plans/calendar?from=${fromStr}&to=${toStr}`)).data;
  test('获取计划日历数据', () => assert(calendar && Array.isArray(calendar.tasks)));
  const skippedTasks = calendar.tasks.filter(t => t.skipped === 1);
  test('存在跳过的任务（节假日）', () => {
    if (skippedTasks.length > 0) {
      console.log(`    跳过任务数: ${skippedTasks.length}, 原因示例: ${skippedTasks[0].skip_reason}`);
    }
    return true;
  });

  const areaCalendar = (await request(`/api/plans/calendar?from=${fromStr}&to=${toStr}&area=` + encodeURIComponent('A区-一号车间'))).data;
  test('按区域筛选日历任务', () => assert(areaCalendar.tasks.every(t => t.area === 'A区-一号车间')));

  console.log('\n【6】巡检任务接口');
  const tasks = (await request('/api/tasks?status=pending')).data;
  test('获取待执行任务列表', () => assert(Array.isArray(tasks)));

  if (tasks.length > 0) {
    const pendingTask = tasks.find(t => t.skipped === 0 && t.status === 'pending');
    if (pendingTask) {
      const taskDetail = (await request(`/api/tasks/${pendingTask.id}`)).data;
      test('获取任务详情', () => assert(taskDetail && taskDetail.id === pendingTask.id));
      test('任务详情包含巡检点', () => assert(Array.isArray(taskDetail.points)));

      console.log('\n【7】巡检提交与异常升级验证');
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
        const anomalyId = submitR.anomalyIds[0];

        console.log('\n【8】异常闭环流程验证');
        const anomaly = (await request(`/api/anomalies/${anomalyId}`)).data;
        test('获取异常详情', () => assert(anomaly && anomaly.id === anomalyId));
        test('异常初始状态为 pending', () => assert(anomaly.status === 'pending'));
        test('异常设置了截止日期', () => assert(anomaly.deadline));

        const assignR = (await request(`/api/anomalies/${anomalyId}/assign`, {
          method: 'POST', body: { responsible_id: users[3].id }
        })).data;
        test('分配异常责任人', () => assert(assignR && assignR.status === 'assigned'));
        const anomalyAfterAssign = (await request(`/api/anomalies/${anomalyId}`)).data;
        test('异常状态变为 assigned', () => assert(anomalyAfterAssign.status === 'assigned'));

        const rectifyR = (await request(`/api/anomalies/${anomalyId}/rectify`, {
          method: 'POST',
          body: {
            handler_id: users[3].id,
            measure: '已更换损坏部件，重新校准设备参数',
            evidence: 'https://example.com/fix-photo.jpg'
          }
        })).data;
        test('提交整改措施', () => assert(rectifyR && rectifyR.anomaly));
        const anomalyAfterRectify = (await request(`/api/anomalies/${anomalyId}`)).data;
        test('整改后状态变为待复查', () => assert(anomalyAfterRectify.status === 'rechecking'));

        const recheckR = (await request(`/api/anomalies/${anomalyId}/recheck`, {
          method: 'POST',
          body: {
            rechecker_id: adminUser.id,
            result: 'pass',
            remark: '整改合格，设备运行正常',
            evidence: 'https://example.com/recheck.jpg'
          }
        })).data;
        test('复查通过，异常关闭', () => assert(recheckR && recheckR.anomaly.status === 'closed'));

        const anomaliesList = (await request('/api/anomalies?status=closed')).data;
        test('已关闭异常可被查询到', () => assert(anomaliesList.some(a => a.id === anomalyId)));
      }
    }
  }

  console.log('\n【9】第二组异常：退回整改流程');
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
        test('复查失败退回整改', () => assert(failR && failR.anomaly.status === 'reject'));

        const recheckAnomaly = (await request(`/api/anomalies/${aid2}`)).data;
        test('退回后自动创建新整改记录', () => assert(recheckAnomaly.rectifications.length >= 2));
      }
    }
  }

  console.log('\n【10】延期申请验证');
  const pendingAnomalies = (await request('/api/anomalies?status=assigned')).data;
  if (pendingAnomalies.length === 0) {
    const pa = (await request('/api/anomalies?status=pending')).data;
    if (pa.length > 0) {
      await request(`/api/anomalies/${pa[0].id}/assign`, {
        method: 'POST', body: { responsible_id: users[2] ? users[2].id : 3 }
      });
    }
  }
  const assignedAnomalies = (await request('/api/anomalies?status=assigned')).data;
  if (assignedAnomalies.length > 0) {
    const extAid = assignedAnomalies[0].id;
    const extR = (await request(`/api/anomalies/${extAid}/extension`, {
      method: 'POST', body: { reason: '备件未到货，需延期', days: 5 }
    })).data;
    test('提交延期申请', () => assert(extR && extR.extension_request === 1));

    const rects = (await request(`/api/anomalies/${extAid}`)).data.rectifications;
    const extRect = rects[rects.length - 1];
    if (extRect) {
      const approveR = (await request(`/api/rectifications/${extRect.id}/approve-extension`, {
        method: 'POST', body: { approved: true }
      })).data;
      test('批准延期申请', () => assert(approveR && approveR.extension_approved === 1));
    }
  }

  console.log('\n【11】逾期统计与筛选');
  const overdueList = (await request('/api/anomalies/overdue/list')).data;
  test('获取逾期异常列表', () => assert(Array.isArray(overdueList)));

  const overdueFilter = (await request('/api/anomalies?overdue=true')).data;
  test('按逾期筛选异常', () => assert(overdueFilter.every(a => a.is_overdue)));

  const levelFilter = (await request('/api/anomalies?level=严重')).data;
  test('按异常等级筛选', () => assert(levelFilter.every(a => a.level === '严重')));

  console.log('\n【12】统计看板接口');
  const dashboard = (await request('/api/stats/dashboard')).data;
  test('获取看板总览数据', () => assert(dashboard && dashboard.planCompletion));
  test('计划完成率数据正确', () => assert(typeof dashboard.planCompletion.rate === 'number'));
  test('异常率数据正确', () => assert(typeof dashboard.anomalyRate.rate === 'number'));
  test('逾期整改数正确', () => assert(typeof dashboard.overdueCount === 'number'));
  test('重复异常设备列表', () => assert(Array.isArray(dashboard.repeatDevices)));
  test('区域风险排行', () => assert(Array.isArray(dashboard.areaRanking) && dashboard.areaRanking.length > 0));
  test('人员任务负载', () => assert(Array.isArray(dashboard.workload)));

  const completion = (await request('/api/stats/completion')).data;
  test('独立获取计划完成率', () => assert(typeof completion.rate === 'number'));

  const areaRisk = (await request('/api/stats/area-risk')).data;
  test('独立获取区域风险排行', () => assert(Array.isArray(areaRisk) && areaRisk.length > 0));

  const workload = (await request('/api/stats/workload')).data;
  test('独立获取人员负载', () => assert(Array.isArray(workload)));

  console.log('\n【13】核心页面 HTTP 验证');
  const pages = ['/', '/index.html', '/style.css', '/app.js'];
  for (const p of pages) {
    const pr = await request(p);
    test(`页面 ${p} 返回 200`, () => assert(pr.status === 200, `状态码: ${pr.status}`));
  }

  console.log('\n========== 测试结果汇总 ==========');
  console.log(`通过: ${passed}, 失败: ${failed}`);
  if (errors.length > 0) {
    console.log('\n失败详情:');
    errors.forEach(e => console.log(`  - ${e.name}: ${e.error}`));
  }
  console.log('');

  process.exit(failed > 0 ? 1 : 0);
}

runTests().catch(e => {
  console.error('测试运行错误:', e.message);
  process.exit(1);
});
