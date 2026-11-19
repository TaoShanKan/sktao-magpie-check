# 模型共享检测设置 · 验收

| 场景 | 需求 ID | 操作与预期 | 证据／检查入口 | 结果 |
| --- | --- | --- | --- | --- |
| A-001 | MS-001、MS-006 | 单卡勾选共享参数，自动保存／失败重试；无选择禁用运行 | scripts/browser-check.js、settings.png | 通过 |
| A-002 | MS-002、MS-004 | 整组原子提交、同模型串行、两模型并发、重复拒绝、失败继续 | tests/shared-settings.test.js | 通过 |
| A-003 | MS-003、MS-004 | 快照不随暂停／取消勾选变化，移除取消，超长组无补跑 | tests/shared-settings.test.js | 通过 |
| A-004 | MS-005 | 旧参数直接转换：唯一启用项优先，否则奶牛；保留启用项、历史和证据 | tests/shared-settings.test.js | 通过 |
| A-005 | MS-006 | 明暗、375–1440、横屏、放大文字、键盘勾选 | scripts/browser-check.js、settings-shared-mobile.png、settings-shared-dark.png | 通过 |
| A-006 | MS-006 | 隔离 Magpie 安装、侧栏、代理、共享卡片及奶牛调用／矫正与指纹历史 | scripts/magpie-check.js | 通过 |
| A-007 | MS-001–006 | 日常原生 Magpie 页面和真实供应商 | 用户体验确认 | 未执行 |

## 执行记录

2026-11-19：`bun test`，84 通过、0 失败、333 断言；`bun run test:browser` 通过，含两项一起运行、共享快照、零选择与自动保存失败重试。`bun run test:magpie` 使用临时 HOME／配置／数据库与模拟网关通过；最终参数直接转换版本再次执行通过；该轮首次在读取指纹时间线时出现 Failed to fetch，立即重跑通过，瞬时连接失败原因未确认。明暗及移动截图已人工检查，无错误提示或横向溢出。未调用真实模型、未重载日常服务。

## 待验收

用户日常原生页面、真实供应商与远程部署未验收。测试仅使用模拟网关及离线指纹执行器／排名夹具。
