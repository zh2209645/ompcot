# Ompcot

[English](./README.md) | **中文**

本地桌面 GUI，专为 [Oh My Pi (OMP)](https://github.com/can1357/oh-my-pi) 编程 Agent 打造。无需云端，无需账号，完全在本机运行。界面支持 **English / 简体中文**（可在设置中切换）。

Ompcot **不再内置 omp**——它为每个工作区启动**系统 PATH 中的 `omp`**（或通过 `OMP_BIN` 环境变量指定），因此可以独立于应用升级 omp，始终运行你选定的版本。

> **Fork 自 [Picot](https://github.com/shixin-guo/picot)**（Picot 又是 Tau 的 fork），适配 OMP 替代 Pi。

---

## 安装

[从 GitHub Releases 下载](https://github.com/zh2209645/ompcot/releases)

**需要先安装 `omp`** —— Ompcot 使用系统 omp，应用内不再打包：

```bash
brew install omp   # macOS；其他平台见上游仓库
```

安装方式与详情：[can1357/oh-my-pi](https://github.com/can1357/oh-my-pi)。如需指定特定二进制，可设置 `OMP_BIN` 环境变量。

### macOS 未签名提示

Ompcot 目前发布的 macOS 版本未经 Apple 开发者 ID 签名/公证，系统可能弹出：

`"Ompcot" 无法打开，因为无法验证开发者。`

**解决方法：**

1. 将 `Ompcot.app` 拖入 `/Applications`
2. 右键点击 → **打开**
3. 若仍被阻止：**系统设置 → 隐私与安全性 → 仍要打开**

---

## 它能做什么

Ompcot 为 OMP 提供完整的可视化界面。打开任意项目文件夹，与 Agent 对话，浏览会话和文件——无需打开终端。多个项目可以并行运行，每个项目有独立窗口和独立 Agent 进程。

---

## 功能特性

### 💬 对话

- **流式响应**，完整 Markdown 渲染，代码块语法高亮
- **工具调用卡片**，含内联 Diff 视图（红绿行对比）与实时渲染的**思考块**
- **模型下拉选择**与按模型区分的**思考深度菜单** —— 深度选项跟随每个模型的能力，不支持时自动锁定
- **斜杠命令自动补全**（输入框中输入 `/`），覆盖 omp 全部命令
- Agent 工作时的**消息队列** —— 每条消息可选**排队**或**立即插话**送达
- 图片附件（粘贴、拖放或按钮）、一键复制、中止、未读提示

### 🗂️ 会话 & Agent

- 会话历史：**全文搜索**、收藏、归档、重命名、批量删除、**导出 HTML**
- 从任意消息**分叉对话**（已接线；当你的 omp 版本支持时自动生效）
- 从 Claude Code / Codex **导入**会话 —— 引导式入口
- **并行会话** —— 每个新会话启动独立的 headless Agent 进程；已有会话继续运行，不弹新窗口
- **Agent Hub** —— 实时查看运行中的子 Agent 名册、状态与只读转录

### 🗃️ 项目与工作区

- **多项目** —— 每个项目独立窗口、工作目录、会话历史和 Agent
- 项目头部显示**当前 Git 分支**；**在外部编辑器中打开**（VS Code、Cursor 等）
- 原生文件夹选择器，以及**文件浏览器**侧边栏（懒加载目录树，可拖拽到输入框）

### 🔌 MCP & 交互

- **MCP 服务器管理** —— 添加/编辑（stdio / HTTP / SSE）、启用/停用并持久化，由 omp 自身的规则校验
- **交互式 Agent 对话框** —— Agent 的 select / confirm / input 请求以对话框呈现，可重放、有截止时间

### ⚙️ 设置

- **通用** —— 外观主题与界面语言
- **扩展** —— 包浏览器，支持自定义注册表与离线缓存
- **用量** —— 账户用量配额与本地**费用面板**（按会话 Token/费用、趋势、按模型分类、上下文窗口可视化）
- **配置** —— Providers（API 密钥 + 通过 `omp login` 的 **OAuth 登录**）、**Models & Reasoning**（默认模型与思考深度、15 个模型角色、按 Agent 的模型覆盖）、MCP，以及 Advanced 原始 `config.yml`

### 🎨 主题

- 六款内置主题、九款 VS Code 配色，支持**导入 Windows Terminal 主题**（windowsterminalthemes.dev JSON）

### 🎤 语音输入

- 麦克风按钮，本地语音识别，实时转录到输入框

### 📱 移动端 & 局域网访问

- **局域网二维码** —— 扫码即可在同网络的任意设备上访问 Ompcot；移动端优化，可作为 PWA 安装

### 🔄 更新

- **内置自动更新** —— 应用自动保持最新，跟随 GitHub 上发布的版本

---

## 集成的 OMP 能力

Ompcot 不重新实现 Agent 逻辑——它驱动你已安装的 omp CLI，并通过原生 UI 暴露其运行时能力。

- **系统 `omp --mode rpc` 运行时** —— 每个工作区一个受管进程，从 PATH 解析（`OMP_BIN` 可覆盖）；omp 可独立于 Ompcot 升级
- **流式 RPC 桥接** —— 逐 Token 输出、工具调用事件和思考块实时渲染
- **会话生命周期 API** —— 创建、切换、恢复会话，完整的按项目历史
- **多客户端会话** —— 多个 UI 客户端（桌面窗口、局域网移动端）可同时接入同一个 Agent
- **扩展兼容** —— 自动加载 `~/.omp/agent/extensions/` 和 `.omp/extensions/` 中的用户扩展
- **凭证经由 omp 本身处理** —— API 密钥与 OAuth 登录直接写入 omp 自己的 `~/.omp/agent/auth.json`

---

## 工作原理

```
┌──────────────────────────────────────────────────────┐
│ Ompcot .app                                          │
│                                                      │
│   Tauri + OmpManager (Rust)                          │
│      ├─► 启动  omp --mode rpc  (项目 A, :3001)       │
│      ├─► 启动  omp --mode rpc  (项目 B, :3002)       │
│      └─► 每个项目一个 OS 窗口 ──► WebView ──► HTTP   │
│                                                      │
│   resources/                                         │
│      ├─ public/             (前端)                   │
│      └─ extensions/         (embedded-server.mjs)    │
└──────────────────────────────────────────────────────┘
          │  omp 从 PATH 解析（或 OMP_BIN）
          ▼ 读取 / 写入
~/.omp/agent/
   ├─ sessions/   (对话历史)
   ├─ auth.json   (API 密钥)
   └─ settings.json
```

每个 omp 进程启动时加载 `embedded-server.mjs`。该扩展负责 Tauri WebView 所通信的 HTTP + WebSocket 层：静态资源、会话 API、提示词 RPC 桥接等。Rust 层负责进程生命周期、端口分配和窗口管理。

---

## 使用方法

1. 确保已安装 `omp`（终端运行 `omp --version` 验证）
2. 启动 **Ompcot** 并选择一个文件夹
3. 开始对话 —— Ompcot 会自动为该工作区启动 omp Agent

通过**设置 → 配置 → Providers**（API 密钥或 OAuth 登录）或终端中的 `omp /login` 提供模型凭证。Ompcot 将所有凭证处理委托给 omp 本身。

---

## 文档

- [自动更新与发布](docs/AUTO_UPDATER.md) —— 更新器架构、发布流水线、事故处理手册
- [OMP 功能差距审计](docs/omp-feature-gaps.md) —— GUI 覆盖了哪些 omp 能力、还缺什么
- [macOS 发布策略](docs/release-macos.md) —— 本地打包签名策略检查

---

## 从源码构建

```bash
git clone https://github.com/zh2209645/ompcot.git
cd ompcot
bun install --frozen-lockfile
bun run dev      # 启动 tauri dev 热重载
```

发布构建：

```bash
bun run build    # 编译扩展 + tauri build
```

修改 `src-tauri/` 下的文件后：

```bash
bun run check:rust   # cargo check + clippy + fmt（快速，无需完整构建）
```

---

## 上游关系

Ompcot 是 [Picot](https://github.com/shixin-guo/picot)（Picot 又是 Tau 的 fork）的 fork，适配 OMP。主要改动：

- **Pi → OMP 迁移** —— 所有二进制引用、包名、路径、环境变量已更新
- **系统 omp 运行时** —— 从 PATH 启动系统 omp（`OMP_BIN` 可覆盖）；`brew upgrade omp` 即可升级，无需重建应用
- **OMP SDK 包** —— `@oh-my-pi/pi-coding-agent` 及相关包

---

## License

MIT
