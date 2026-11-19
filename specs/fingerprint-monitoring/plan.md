# 定期指纹检测 · 实施方案

## 方案

Store 使用 model + test_id 的复合键保存配置，records 保存 test_id 与独立 fingerprint JSON。Engine 按复合键去重、按模型串行，统一两并发。Fingerprint 使用 vendored SDK 的挑战生成、请求构造、数字解析和 analyze；服务端适配器负责有界 HTTP 响应、AbortSignal 和路由证据。使用非流式 Chat Completions，由 Magpie 处理供应商协议。

ReferenceBank 使用 SDK 读取／下载数据，ttl Infinity 禁止 SDK 隐式更新；独立每分钟检查 24 小时刷新期限。无缓存不后台下载；首次运行或手动更新获取数据。刷新暂存、核对完整 detector SHA-256 后原子替换，失败保持旧内存与磁盘对象。参考源优先 SDK 官网，其次 SDK 默认镜像；bankSource 可指定测试／离线数据源。每轮持有 reference 对象不受后续更新影响。

页面仍为两个 Tab；指纹为分组时间线，奶牛保持热力图。模型设置按组列出两个计划，分别自动保存。主题变量以宿主 token 为优先，独立运行提供浅深色默认值。

## 兼容与历史

SQLite user_version=2，v1 配置迁移到 milk 并补 fingerprint。原始快照和人工记录不重写。列表只抽取摘要字段，详情读取完整证据。新接口 testId 缺省为 milk；删除模型配置仍删除所有类型。服务身份版本升级为 0.2.0，旧服务需退出后再加载。

SDK 上游声明 Bun >=1.4.2；本机 1.2.20 已做本地数据加载、分析入口、挑战／请求构造与项目适配采样验证，因此项目最低版本维持 1.2.20。完整生产参考库评分及真实模型仍需独立验收。

## 验证

自动范围见 [验收](contracts/acceptance.md)。使用本地空库夹具检查 SDK 数据兼容性，注入明确标记的候选夹具验证评分传播／页面，而不把模拟排名当成真实模型证据。
