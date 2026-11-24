# 接口与数据

实现依据：[server.js](../src/server.js)、[store.js](../src/store.js)、[config.js](../src/config.js)、[gateway.js](../src/gateway.js)。以下记录当前接口，不替代代码校验。

## 页面服务接口

表中路径相对于页面服务根地址；Magpie web 可能在其前面加代理前缀。`api/*` 需要 `Authorization: Bearer <页面服务令牌>`，该令牌由 HTML 的 `api-token` meta 注入。它不是网关密钥，重启后会变化。

| 方法与路径 | 输入 | 输出／语义 |
| --- | --- | --- |
| `GET api/state` | 无 | `configs`、历史 `models`、`active`、`timeZone`；无上游模型探测 |
| `GET api/models` | 无 | `{id,name,provider,efforts}` 数组；实际读取网关目录 |
| `POST api/configs` | `model` 及可选 `enabled/intervalMinutes/timeoutSeconds/effort` | 新增或更新后的配置；新模型须存在于目录 |
| `DELETE api/configs/:model` | URL 编码的完整模型 ID | 取消未完成任务并删除配置，保留历史 |
| `POST api/run` | `{model}` | HTTP 202，`{id,model,state}`；重复任务返回 409 |
| `GET api/history` | `model`，可选 `page/day/slot` | `{items,total,page,pageSize}`；每页 20 条，`day` 为日期，`slot` 为 0–3 |
| `GET api/heatmap` | `model` | `{dates,cells,timeZone}`；30 个日期、120 个时段格 |
| `GET api/records/:id` | 记录 ID | 完整详情、快照、回答、原始自动判断及矫正日志 |
| `POST api/records/:id/correction` | `{result,note?}` | 保存并返回详情；`result` 为 `passed/failed/unknown`，`null` 恢复自动判断 |
| `DELETE api/history` | `{model}` | `{deleted}`；删除该模型全部已结束记录，不受列表筛选限制 |

`GET /_check/health` 供受管宿主识别服务，仅返回应用、版本及配置指纹。接口校验 Host、Origin 和页面令牌；静态 HTML 不授予跨源读取令牌的 CORS 权限。页面使用 `Origin: null` 的沙盒场景已纳入接口设计。

客户端请求 JSON 上限为 16 KiB，人工备注上限 2000 字符；网关目录和回答的读取上限各为 4 MiB。错误响应包含 `error`；已删除记录返回 404，未结束记录的矫正返回 409。

## 字段与状态

| 数据 | 当前字段 |
| --- | --- |
| 模型配置 | `model,name,efforts,enabled,intervalMinutes,timeoutSeconds,effort,nextAt` |
| 历史摘要 | `id,model,name,startedAt,finishedAt,duration,state,source,result,corrected` |
| 详情补充 | `snapshot,answer,automatic,callError,manualResult,manualNote,manualAt,corrections` |
| 自动判断 | `result,extracted,reason` |
| 矫正日志 | `at,previous,next,note`；`previous/next` 为人工覆盖值，`null` 表示没有人工覆盖 |
| 热力格 | `day,slot,result,count,passed,failed,unknown,error,pending` |

持久化时间使用 Unix 毫秒，`duration` 为毫秒。日期、时段筛选按服务 `timeZone` 换算，包含夏令时边界处理；客户端显示使用同一时区。

调用状态 `state` 为 `queued/running/completed/error/cancelled/interrupted`；触发来源 `source` 为 `manual/scheduled`。自动判断仅为 `passed/failed/unknown`。

有效结果的取值顺序：有人工覆盖就采用人工结果；否则 `completed` 采用自动判断，`queued/running` 保留进行中状态，其余调用终态归为 `error`。热力格自身使用 `passed/failed/error/empty`，其中 `error` 聚合调用异常和无法判定。

`snapshot` 保留入队时的模型配置，并补充 `testId/testName/prompt/promptVersion/ruleVersion/expected/maxTokens`。列表不返回长回答；详情才读取证据。改变代码中的规则版本并不会自动重新判定历史。

## SQLite

| 表 | 内容与约束 |
| --- | --- |
| `configurations` | 完整模型 ID 为主键，配置序列化保存 |
| `records` | 请求快照、回答、调用状态、自动判断及当前人工覆盖；按模型和时间索引 |
| `corrections` | 矫正／恢复日志；外键关联记录，清空记录时级联删除 |
| `service_owner` | 本机数据目录的拥有者，防止重复调度 |

首期 `user_version` 为 1（当前版本 2 见下方扩展），使用 WAL 与外键。首期建表用于初始化；当前增加了显式 v1→v2 事务迁移，后续结构变化仍须定义独立迁移步骤。备份及目录位置见 [使用说明](../README.md)。

## 配置与网关

运行参数由插件选项优先，其次 `SKTAO_CHECK_*` 环境变量；最终回退见 `src/config.js`。网关地址另有宿主探测链：`MAGPIE_ADDR` → Magpie `settings.json` 端口 → 默认回环地址。时区默认取服务所在系统，外部配置可覆盖。

`apiKey` 在服务端向网关发请求时使用。配置指纹用数据目录内的 `.service-secret` 生成 HMAC；公开健康响应不返回配置内容。页面服务令牌不写进测试快照。

`src/config.js` 在启动时校验网关地址。只有 `localhost`、`127.0.0.1`、`[::1]` 可用 HTTP；其他地址必须使用 HTTPS 并配置密钥。`src/gateway.js` 不跟随网关重定向。

模型请求为 `POST /v1/chat/completions`：`stream:false`、当前固定的输出上限、单条用户题目；仅当已指定推理强度时发送 `reasoning_effort`。完整且正常结束的非空回答才进入题目判定。不同供应商的转换由 Magpie 负责，本项目的模拟测试不证明所有真实供应商兼容。

## 指纹扩展（版本 0.2.0）

配置／运行请求及历史查询支持 `testId: milk | fingerprint`，缺省 milk。state.configs 每模型两条配置，各带 testId；active 包含 testId。指纹 intervalMinutes 可为 null（仅暂停时），启用必须填写。DELETE configs/:model 删除两种计划并取消任务。

GET api/history 查询参数 testId，DELETE api/history 请求体 testId，只作用于指定类型。摘要增加 prediction/predictionId/probability/decision/usedOutputs/bankId/bankBuiltAt/sdk/callError；时间线额外返回 bankChanged/candidateChanged。详情 fingerprint 包含 bank/sdk/challenges/samples/analysis/error。样本保存无凭证请求体、回答、状态和 provenance；列表不返回这些长证据。correction 对指纹返回 400。heatmap 固定 milk。

GET api/bank 返回 state/bank/lastAttempt/updatedAt/error，POST api/bank/update 合并并发更新；GET api/state 同时包含 bank。无缓存状态读取不触发下载。

SQLite 当前 user_version=2；configurations 主键 (model,test_id)，records 新增 test_id 和 fingerprint JSON，索引 (model,test_id,started_at)。构造器只在旧版本执行事务迁移；高于版本 2 拒绝。旧快照原样保留，其类型由 records.test_id=milk 识别。

GET api/state 另返回 apiVersion=2、serviceVersion；UI 校验协议、配置 testId 和 bank 状态，拒绝把 v1 返回作为新数据展示。旧进程仍可能从磁盘读取新静态文件，因此本地源码更新后须重载插件后台。

## 界面优化扩展（版本 0.3.0）

state 新增 uiVersion=1。UI 在 apiVersion=2 之外校验该能力版本，旧服务需重载，避免新页面对旧后台的统计接口持续重试。

GET api/history 的 fingerprint 查询增加可选 changes=1：在 LIMIT/OFFSET 前筛选 candidateChanged 或 bankChanged；total 为变化记录总数，pageSize 仍为 20。奶牛不受该参数影响。指纹摘要新增 previousPrediction（前一完整评分候选名）、samplesFinished（已结束采样数量）、samplingIndex（当前 waiting 样本序号，1–3；无则 null）。不返回长回答、请求或凭证。部分排名的 candidateChanged 明确为 false。

GET api/fingerprint-summary?model=… 返回 {total,scored,partial,changes,bankChanges,from,to}，区间为服务当前时间前 30×24 小时至当前；不随分页和变化筛选变化。changes 仍按同 SDK／参考快照的相邻完整评分比较，允许前一条位于区间之前。奶牛统计直接汇总 heatmap 的 30 个服务日期，采用人工优先的有效结果，进行中单列。

未增加表或迁移；SQLite 仍为 v2，判定规则与原始证据不变。

## 指纹汇总图（版本 0.4.0）

state.uiVersion=2。新增 GET api/fingerprint-overview?model=…&days=1|7|30，默认 7；其他范围返回 400。返回 {from,to,days,total,omitted,items}，范围为服务当前时间前 days×24 小时，按 startedAt 包含端点。items 为升序摘要，最多最新 10000 轮；omitted 明示省略数量。与历史分页、changes 筛选独立。记录含 id/startedAt/state/prediction/predictionId/probability/decision/usedOutputs/bankId/bankBuiltAt/sdk/bankChanged/sdkChanged/candidateChanged/callError，无长回答、原始请求、样本或凭证。SDK 变化与前一有参考快照的记录比较，参考库变化仍独立计算。无数据库结构或历史判定变化。

## 共享模型配置（版本 0.5.0）

state.uiVersion=3，新增 modelConfigs：每模型一项。shared=true 时包含 selectedTests、enabled（总开关）、intervalMinutes、timeoutSeconds、effort、efforts、nextAt；旧配置在引擎启动时直接转换。旧 configs 类型视图继续返回。

POST api/model-configs 接收 model 与可选 selectedTests、enabled、intervalMinutes、timeoutSeconds、effort。完整校验后在事务中同步两行。已共享模型拒绝 POST api/configs 的旧分项写入，返回 409。

POST api/run-selected 接收 {model}，以事务生成所选项的记录，返回 202 {items:[{id,model,testId,state}]}。任意该模型任务未完成则 409；无选择则 400，均无部分入队。历史页 POST api/run 保留单类型测试。

SQLite 仍为 v2，沿用 configurations 的两行及 JSON：shared 标记、selected 测试项选择、automaticEnabled 总开关。enabled=selected&&automaticEnabled，所选启用项 nextAt 相同。不改 records、判定版本或历史快照。state.active 新增 state=queued|running。旧参数转换优先唯一启用项，否则采用奶牛；全部暂停预选奶牛且保持暂停。

## 界面一致性与增量读取（0.5.1）

`apiVersion=2, uiVersion=4`。`GET api/state` 增加 `historyRevisions: [{model,testId,revision}]`，缺项视为 0。修订号只在同一个服务实例内比较，不是记录数或历史版本。服务拥有者连接的 SQLite TEMP 触发器随记录增删改在同一事务内更新计数，回滚不产生变化；不增加持久表，也不迁移或重判历史。服务重启后页面需要新令牌。

`PATCH api/model-configs` 仅修改已有模型（移除后返回 404），接受 `{model, ...改动字段}`；`testSelection: {milk?: boolean, fingerprint?: boolean}` 只修改指定复选项，不能与替换整个选择的 `selectedTests` 同用。保留 POST 新增和旧版接口。零选择仍原子关闭定期计划。多个窗口修改同一字段时，以服务端后提交的值为准。

UI 将列表、统计、分布图分开缓存，切换上下文丢弃旧缓存；修订号变化刷新同模型同类型的数据。奶牛日期窗在服务日期换日时更新，指纹滚动区间每分钟更新，不依赖记录写入才推进。
