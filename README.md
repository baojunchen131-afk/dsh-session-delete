# @baojun/dsh-session-delete

> 真正删除 DeepSeek Harness 的会话 —— **包括你此刻正在看、有 agent 正在运行的那个**。

侧边栏右键任意会话 → **删除会话** → 确认。目录移入 `sessions-trash`（可手工恢复），列表即时摘行、不整页刷新；删的是当前会话时，主视图退回空状态。

[English](#english) | 中文

---

## 功能

- **正在使用的会话也能删**：先按官方路径停止活动并等 agent 静默，再从进程内注册表摘除，最后才动磁盘。
- **不刷新页面**：Host 触发官方 `api-session/removed` 事件，侧边栏行即时消失。
- **清空主视图**：删的是当前打开的会话时，工作区退回"没有会话"的空状态。
- **可恢复**：目录移动到 `<sessions-root>-trash/<时间戳>__<会话id>`，不是彻底粉碎。
- **移动带重试**：目录被短暂占用（flush/索引服务）时重试约 6 秒，仍失败则报具体错误码。
- **确认对话框**：渲染在应用 `shell.overlay` 弹窗层，桌面端可见，支持明暗主题、中英文。

## 环境要求

- DSH `>= 0.2.1-alpha.1`（**开发与验证基于 `0.2.2-rc.5`**）。
- Node.js `>= 22.19.0`（仅运行测试时需要；插件本身随 DSH 运行时加载，无需独立安装依赖）。
- 插件触达 DSH 内部服务（`sessions`、`agents`、`workspaceRegistry`、`sessionPersistence`），全部做了特性探测。**DSH 升级改动这些内部结构时能力可能降级**——升级后请先看 `/diag`（见下文）。

## 安装

### 方式一：从 Git 仓库安装（推荐用于本仓库）

DSH 支持按 commit 锁定的 Git 安装。把本仓库 push 到 GitHub/GitLab 后：

```bash
# 插件在仓库根目录：
dsh plugin --profile <profile名> add "git+https://github.com/<你>/<仓库>.git#<40位commitSHA>"

# 插件在仓库子目录（例如 packages/dsh-session-delete）：
dsh plugin --profile <profile名> add "git+https://github.com/<你>/<仓库>.git#<commit>&path:/packages/dsh-session-delete"
```

或在 DSH **插件**页面用 `install_bundle`，target 填同样的 `git+https…#commit` 规格。

- `#` 后是 **40 位小写 commit SHA**（Git 安装按提交锁定，可复现；更新需指向新 commit）。
- 仓库 URL 用规范 `https`，不带账号密码/query/fragment。
- 无需构建：纯 JS，clone 后直接可用。

### 方式二：从 npm 安装（发布后）

```bash
dsh plugin --profile <profile名> add @baojun/dsh-session-delete
```

### 方式三：从本地目录安装（开发/试用）

DSH **插件**页面 → **Add plugin** → 选择本目录；或：

```bash
dsh plugin --profile <profile名> add /绝对路径/dsh-session-delete
```

> 本地目录是**链接式**安装：插件指向该目录，**请勿删除或移动它**，否则插件失效。

### 方式四：插件市场索引

把本插件登记进一个 DSH 插件索引（format 1 JSON），市场 Discover 页即可安装。条目示例见 [上架](#上架发布)。

## 激活（重要）

- **Host 半侧**在进程内注册 HTTP 路由：安装/替换后需**重启 DSH**，或在插件页面**停用再启用**。
- **浏览器半侧**在**下次页面加载**时生效。
- ⚠️ **打包版桌面端**：应用开着时改了前端代码，HMR **不会**自动重建，必须 `Cmd+R` 刷新或重开应用才加载新代码。**正常重启会自动加载最新代码，无需额外操作。**
- 端口每次重启会变，但插件用**相对路径 + 路径路由**，自动适配当前端口，**不受端口变化影响**。

## 使用

1. 在侧边栏**右键**任意会话（运行中的、打开着的、闲置的都行）。
2. 选择 **删除会话**。
3. 在弹出的确认对话框里点红色 **删除**。
4. 行立刻消失，目录被移入 `sessions-trash`。

界面上没有撤销。

## 恢复会话

先退出 DSH，再把目录从 `sessions-trash` 搬回 `sessions/` 对应项目 slug 下，然后重开：

```bash
# 路径以实际为准
mv "<DSH_HOME>/sessions-trash/2026-11-22T12-00-00-000Z__session-abc" \
   "<DSH_HOME>/sessions/<项目slug>/session-abc"
```

`<DSH_HOME>` 通常是 `~/.dsh`。

## 排查接口

Host 半侧在 `/dsh-session-delete` 下提供：

| 路由 | 说明 |
|---|---|
| `GET /dsh-session-delete` | 存活探针，返回 revision |
| `GET /dsh-session-delete/list` | 会话清单（id/标题/cwd/大小/归档/置顶/路径） |
| `GET /dsh-session-delete/diag` | revision + 内部钩子可用性 + **最近删除尝试的完整步骤追踪** |
| `POST /dsh-session-delete/delete` | `{ sessionId }` → `{ ok, sessionId, title, movedTo, wasLive }` |

删除失败时，先看 `/diag` 的 `attempts`：每次尝试记录了 `sessionKnown → located → live → stop-activity → whenIdle → detach-agent → scope-dispose → detach-session → bookkeeping → rename → broadcast` 各步骤与错误堆栈，能定位卡在哪一步。

> 端口以运行时 GUI URL 为准（每次重启会变）。 destructive POST 仅允许 loopback 来源。

## 实现方式

Host 半侧（[`index.js`](./index.js)）删除流程：

1. **停止活动 + 等静默（在 registry 操作链之外）**：`ctx.parallel('workspace/session-stop', {sessionId})` 官方停止（取消 turn、kill jobs、取消子代理、停计划），再 `agent.cancel({kind:'user'})` + 有上限的 `whenIdle()`。
   > 关键：`whenIdle()` **不能**放进 `registry.enqueueOperation` 链里——agent 静默所需的 idle checkpoint 会排到本次删除之后，造成死锁。
2. **摘除运行时 entry（链外，agent 先于 session）**：`agents.detachEntered` → `agent/disposed`；`scope.dispose`；`sessions.detachEntered` → `session/disposed`（持久层 flush + 关句柄 + 控制器广播 `api-session/removed`）。
3. **记账 + 移目录（链内）**：从各工作区 `detachSession`、清 archived/pinned，`fs.rename` 移入 trash（带重试），清投影缓存。
4. 仅当 store 未派发 disposal 时补发一次 `api-session/removed`，避免重复摘行。

浏览器半侧（[`client.js`](./client.js)）：`contextMenus.register` 加菜单项；确认对话框作为 React 组件注册进 `shell.overlay` 插槽（应用帧级弹窗层，桌面端可见），模块级 store 驱动显隐；删除成功后若删的是当前聚焦会话，调用 `uiWorkspace.clearMain()`。

## 开发

```bash
npm test   # 宿主模拟测试：闲置/存活删除序列、死锁回归、agent 先于 session 释放、错误分支
```

文件结构：

```
dsh-session-delete/
├── index.js            # Host 半侧：删除逻辑 + HTTP 路由
├── client.js           # 浏览器半侧：右键菜单 + shell.overlay 确认对话框
├── cordis.patch.yml    # bundle 挂载补丁
├── package.json        # 清单（dsh.bundle.patch + dsh.client）
├── locale/             # en.json / zh.json（meta.title/description/detail）
├── icon.svg            # 图标（原创，≤256KiB）
├── docs/DETAIL.md      # 插件详情页文档
├── tests/              # 宿主模拟测试
├── LICENSE             # MIT
└── README.md
```

## 上架发布

### 发到 npm

1. 确认 `package.json` 的 `name`（`@baojun/dsh-session-delete`，需你拥有该作用域）、`version`、`repository`/`homepage`/`bugs`（**改成你的实际仓库地址**）。
2. 已去掉 `private: true`，可发布。
3. 打包并核对文件清单：

```bash
npm pack --dry-run   # 确认 index.js/client.js/cordis.patch.yml/locale/icon.svg/docs/README/LICENSE 都在
npm publish --access public
```

### 登记到插件市场索引（format 1）

在你的索引 JSON 的 `plugins[].versions[]` 加一条（Git 源示例）：

```json
{
  "version": "1.0.0",
  "publishTimestamp": "2026-11-24T00:00:00Z",
  "engines": { "dsh": ">=0.2.1-alpha.1" },
  "source": {
    "type": "git",
    "url": "https://github.com/<你>/<仓库>",
    "commit": "<40位小写commitSHA>",
    "path": "packages/dsh-session-delete"
  }
}
```

`path` 仅在插件位于仓库子目录时需要；根目录则省略。npm 源则用 `"source": {"type":"npm"}`，安装规格为 `name@version`。索引生成器可用 `@deepseek-ai/dsh-plugin-market-index` 的 `parseMarketIndex` 校验。

> 若提交到带预检的索引（如某些商城的 `check-plugin-submission.mjs`），遵守其规则：`cordis.patch.yml` 的 `id`/`name` 行不要写行尾注释，`name` 与 `package.json` 逐字一致。

## 兼容性说明

本插件依赖 DSH **内部**服务而非稳定公开 API，虽全部特性探测，但 DSH 升级可能使其降级。`engines.dsh` 声明的是宽泛下界，**实际验证版本为 `0.2.2-rc.5`**。升级 DSH 后请先查 `/diag` 的 `supports` 字段确认钩子仍可用。

## 许可证

[MIT](./LICENSE) © 2026 baojun

---

<a id="english"></a>
## English

Really delete a DeepSeek Harness session — including the one currently open with a running agent. Right-click a session → **Delete session** → confirm. The directory is moved into `sessions-trash` (restorable by hand), the sidebar row drops without a page reload, and the main view returns to the empty state when the deleted session was on screen.

- **Install from Git:** `dsh plugin --profile <name> add "git+https://github.com/<you>/<repo>.git#<40-hex-commit>"` (append `&path:/subdir` if the package is in a subdirectory).
- **Install from npm:** `dsh plugin --profile <name> add @baojun/dsh-session-delete`.
- **Install local:** Plugins → Add plugin → select this directory (linked install; keep the directory).
- **Activate:** restart DSH (or disable/enable the plugin) for the Host half; refresh the page for the browser half. Packaged desktop does not hot-rebuild client code — refresh after editing.
- **Use:** right-click a session → Delete session → confirm in the dialog.
- **Restore:** quit DSH, move the directory back from `sessions-trash` into `sessions/<project-slug>/`, reopen.
- **Troubleshoot:** `GET /dsh-session-delete/diag` shows internal-hook availability and recent delete attempt traces.
- **Requires:** DSH `>=0.2.1-alpha.1` (verified on `0.2.2-rc.5`), Node `>=22.19.0` for tests. Relies on feature-detected DSH internals; may degrade after DSH upgrades.
- **Dev:** `npm test`. **License:** MIT.
