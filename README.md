# 设备巡检计划与异常闭环系统

基于 Node.js + Express + SQLite 的设备巡检计划管理与异常闭环处理系统。

## 功能特性

- **设备档案管理**：设备信息、巡检点配置、分类与区域管理
- **巡检计划管理**：支持按日/周/月周期创建巡检计划，可配置设备类型、区域、模板和负责人
- **任务自动生成**：根据计划自动生成巡检任务，支持节假日跳过、计划暂停、重复防重
- **任务预览**：可预览指定计划在日期范围内的任务生成情况，不写入数据库
- **异常闭环管理**：异常上报、分配、整改、延期申请、复查、退回全流程
- **状态历史追溯**：完整记录异常状态变更历史，包含操作人、操作时间、备注
- **统计看板**：计划完成率、异常率、逾期整改、区域风险、重复异常、人员负载等多维度统计
- **趋势分析**：支持按日期范围查看统计趋势，支持按区域、设备类型、负责人、计划筛选

## 目录结构

```
gsb-0049/
├── public/              # 前端静态文件
│   ├── index.html       # 主页面
│   ├── app.js           # 前端逻辑
│   └── style.css        # 样式文件
├── scripts/             # 数据库脚本
│   ├── init-db.js       # 数据库初始化（建表）
│   ├── seed.js          # 写入示例数据
│   ├── reset-db.js      # 重置数据库（清空+初始化+示例数据）
│   └── verify-data.js   # 验证数据完整性
├── test/                # 测试脚本
│   └── api-test.js      # API 接口验证脚本
├── db.js                # 数据库连接与初始化
├── server.js            # Express 服务主入口
├── taskGenerator.js     # 任务生成逻辑
├── anomalyFlow.js       # 异常闭环流程
├── statistics.js        # 统计分析模块
├── package.json         # 项目依赖配置
└── README.md            # 项目说明文档
```

## 环境要求

- Node.js >= 14.x
- npm >= 6.x
- 操作系统：Windows / macOS / Linux

## 安装步骤

### 1. 安装依赖

```bash
npm ci
```

> 使用 `npm ci` 确保安装与 package-lock.json 完全一致的依赖版本，适用于干净环境和 CI/CD 场景。

### 2. 数据库初始化

```bash
# 仅初始化数据库表结构
npm run init-db

# 写入示例数据（幂等，重复执行不会产生重复数据）
npm run seed

# 一键重置数据库（清空 + 初始化 + 示例数据）
npm run reset-db

# 验证示例数据完整性
npm run verify-data
```

### 3. 启动服务

```bash
npm start
```

服务默认运行在 `http://localhost:3000`

可通过环境变量指定端口：

```bash
PORT=8080 npm start
```

## 数据库与数据文件

- **数据库文件**：`inspection.db`（项目根目录，SQLite 格式）
- **数据位置**：所有运行时数据存储在 `inspection.db` 文件中
- **备份方式**：直接复制 `inspection.db` 文件即可完成备份

> 注意：数据库文件属于运行产物，不纳入版本管理。

## 验证命令

### 语法检查

```bash
npm run lint
```

### API 接口验证

```bash
# 确保服务已启动后执行
npm test
```

验证脚本会自动检测服务状态，覆盖以下场景：

- 基础接口健康检查
- 用户与设备管理
- 巡检计划 CRUD
- 任务生成与预览
- 暂停/节假日跳过
- 重复生成防重
- 巡检提交
- 异常分配、整改、延期、复查
- 复查退回与新整改生成
- 状态历史追溯
- 统计看板与筛选
- 核心页面 HTTP 访问

验证失败时脚本以非 0 状态码退出。

## 常见故障

### 1. 依赖安装失败

- 确保网络连接正常
- 尝试清除 npm 缓存：`npm cache clean --force`
- 删除 `node_modules` 和 `package-lock.json` 后重新执行 `npm install`

### 2. 数据库文件损坏

- 执行 `npm run reset-db` 重置数据库
- 注意：重置会丢失所有业务数据，请先备份

### 3. 端口被占用

- 修改启动端口：`PORT=3001 npm start`
- 或查找并关闭占用端口的进程

### 4. 任务未生成

- 检查计划是否已暂停
- 检查计划的开始/结束日期
- 检查计划是否关联了设备
- 检查日期是否为节假日

### 5. 示例数据重复

- 示例数据脚本设计为幂等，重复执行 `npm run seed` 不会产生重复数据
- 如仍有问题，可执行 `npm run reset-db` 恢复干净状态

## API 接口概览

### 基础接口
- `GET /api/health` - 健康检查

### 用户管理
- `GET /api/users` - 用户列表

### 设备管理
- `GET /api/devices` - 设备列表（支持筛选）
- `GET /api/devices/:id` - 设备详情
- `POST /api/devices` - 创建设备
- `GET /api/devices/areas` - 区域与设备类型

### 巡检模板
- `GET /api/templates` - 模板列表

### 巡检计划
- `GET /api/plans` - 计划列表
- `GET /api/plans/:id` - 计划详情
- `POST /api/plans` - 创建计划
- `POST /api/plans/:id/toggle` - 启用/暂停计划
- `POST /api/plans/:id/generate` - 生成计划任务
- `POST /api/plans/:id/preview` - 预览任务（不写入）
- `GET /api/plans/calendar` - 计划日历视图
- `POST /api/tasks/generate-all` - 批量生成所有计划任务

### 巡检任务
- `GET /api/tasks` - 任务列表
- `GET /api/tasks/:id` - 任务详情
- `POST /api/tasks/:id/submit` - 提交巡检结果

### 异常管理
- `GET /api/anomalies` - 异常列表
- `GET /api/anomalies/:id` - 异常详情（含状态历史）
- `POST /api/anomalies/:id/assign` - 分配异常
- `POST /api/anomalies/:id/rectify` - 提交整改
- `POST /api/anomalies/:id/extension` - 申请延期
- `POST /api/rectifications/:id/approve-extension` - 审批延期
- `POST /api/anomalies/:id/recheck` - 复查异常
- `GET /api/anomalies/overdue/list` - 逾期异常列表

### 节假日管理
- `GET /api/holidays` - 节假日列表
- `POST /api/holidays` - 新增节假日
- `DELETE /api/holidays/:id` - 删除节假日

### 统计看板
- `GET /api/stats/dashboard` - 看板总览
- `GET /api/stats/completion` - 计划完成率
- `GET /api/stats/anomaly-rate` - 异常率
- `GET /api/stats/area-risk` - 区域风险排行
- `GET /api/stats/workload` - 人员任务负载
- `GET /api/stats/trend` - 趋势分析
- `GET /api/stats/level-distribution` - 异常等级分布
- `GET /api/stats/repeat-devices` - 重复异常设备

## 开发说明

- 前端为纯静态页面，使用原生 JavaScript，无需构建工具
- 后端使用 Express 框架，RESTful API 设计
- 数据库使用 SQLite，无需单独安装数据库服务
- 所有数据操作封装在 `db.js` 和各业务模块中
