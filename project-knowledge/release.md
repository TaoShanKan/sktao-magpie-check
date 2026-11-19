# GitHub 发布清单

## 首次公开前

1. 确认 [项目许可证与署名](../LICENSE)，保留 [第三方声明](../THIRD_PARTY_NOTICES.md)。
2. 核对 [忽略规则](../.gitignore)。运行数据库、模型回答、Magpie 设置和密钥留在仓库外。不要从日常 Magpie 数据目录打包文件。
3. 如果尚未初始化 Git，运行 `git init -b main`。只暂存准备公开的文件。用 `git diff --cached --name-only` 和 `git diff --cached --check` 核对，再在本地审查暂存内容与截图。不要把未经审查的差异发到 Issue。
4. 如果复用其他仓库的历史，检查待推送分支与标签中可达的历史。忽略规则不会清除已跟踪文件或旧提交。若发现真实密钥已进入历史，先撤销或轮换，不要推送该历史。
5. 创建并绑定目标 GitHub 仓库。若不确定公开文件范围，可先设为私有，检查从 GitHub 克隆、README 安装和 Actions 状态，再公开。

## 发布验证

- 无 `node_modules` 的干净副本可以执行 `bun test`。浏览器与 Magpie 验证另见 [开发与验证](development.md)。
- 记录实测平台和 Magpie 版本；不把一次成功当作最低版本、跨平台或生产网关承诺。
- 本项目无需发布 npm 包。`package.json` 的 `private: true` 防止误发 npm，不影响 GitHub 公开或从本地目录安装。

### 2026-11-19 本地验证记录

- 临时 Git 索引审查通过：拟提交 93 个文件，13 项忽略样例命中，`git diff --cached --check` 通过。文本未命中所查个人路径和常见密钥格式；这不是完整凭证审计。
- 干净副本的冻结锁文件安装、75 项 Bun 测试、三轮 Chromium 和隔离 Magpie Web 安装均通过。工作流通过 `actionlint`，尚未在 GitHub 托管运行器执行。
- 上述检查在首次提交前完成；真实目标仓库的克隆与 CI 需要在推送后验证。
