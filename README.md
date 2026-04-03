# MCP Hub Local

**English** | **[中文](#mcp-hub-local-1)**

A local hub for centrally managing and orchestrating [Model Context Protocol (MCP)](https://modelcontextprotocol.io/) servers. Connect multiple AI clients to a single endpoint that aggregates tools, resources, and prompts from all your MCP servers.

```
 Cursor ──┐                           ┌── File Search MCP
 Claude ──┤                           ├── Web Fetch MCP
  Codex ──┼── MCP Hub Local (/w/ws) ──┼── Database MCP
 Gemini ──┤                           ├── Git MCP
   ...  ──┘                           └── ...
```

## Screenshots

> **Dashboard** - Manage MCPs, workspaces, sessions, and logs all in one place.

**Sessions**
![Sessions](docs/screenshots/sessions.png)

**MCPs**
![MCPs](docs/screenshots/mcps.png)

**Workspaces**
![Workspaces](docs/screenshots/workspaces.png)

**Logs**
![Logs](docs/screenshots/logs.png)

**Settings**
![Settings](docs/screenshots/settings.png)


## Features

- **Unified MCP Gateway** - Aggregate multiple remote and local MCP servers behind a single endpoint
- **Workspace-based Management** - Each workspace can have its own set of MCPs, accessible at `/w/<slug>`
- **Auto-Sync Client Configs** - Automatically write MCP configurations to client config files; supports Cursor, Claude Desktop, Codex, and Gemini
- **Flexible Instance Modes** - Local MCPs support multiple instantiation strategies: `singleton`, `per-workspace`, `per-session`
- **Session Monitoring** - Monitor MCP usage per client session in real time
- **Web Dashboard** - Manage everything from `http://localhost:3000/app`

## Quick Start

### Prerequisites

- **Node.js** >= 20

### Install & Run

```bash
# Run directly with npx (no install needed)
npx mcp-hub-local

# Or install globally
npm install -g mcp-hub-local
mcp-hub-local
```

The hub starts at **[http://localhost:3000](http://localhost:3000)** by default.


| URL                              | Description               |
| -------------------------------- | ------------------------- |
| `http://localhost:3000/app`      | Web Dashboard             |
| `http://localhost:3000/api`      | REST API                  |
| `http://localhost:3000/w/<slug>` | MCP Proxy (per workspace) |


### Development (from source)

```bash
git clone https://github.com/<your-org>/mcp-hub-local.git
cd mcp-hub-local
npm install
npm run build

# Server with hot-reload
npm run dev

# Web UI dev server (separate terminal)
npm run dev:web
```

### CLI Options

```bash
mcp-hub-local --port 5000
mcp-hub-local --config ./my-config.json
```

## How It Works

```mermaid
flowchart LR
    subgraph Clients
        C1[Cursor]
        C2[Claude]
        C3[Codex]
    end

    subgraph Hub["MCP Hub Local :3000"]
        direction TB
        WS1["Workspace A<br/>/w/project-a"]
        WS2["Workspace B<br/>/w/project-b"]
        AS[Auto-Sync<br/>Client Configs]
    end

    subgraph MCPs["MCP Servers"]
        M1["File Search<br/>(stdio)"]
        M2["Web Fetch<br/>(stdio)"]
        M3["Remote API<br/>(http)"]
    end

    C1 & C2 & C3 -->|"MCP Protocol"| Hub
    AS -.->|"write configs"| C1 & C2 & C3
    WS1 -->|"singleton"| M1
    WS1 -->|"per-workspace"| M2
    WS1 -->|"per-session"| M3
    WS2 -->|"singleton"| M1
    WS2 -->|"per-workspace"| M3

    style Hub fill:#1a1a2e,stroke:#6c63ff,color:#fff
    style Clients fill:#0d1117,stroke:#58a6ff,color:#fff
    style MCPs fill:#0d1117,stroke:#3fb950,color:#fff
```

## Architecture

```
local-mcp-hub/
├── apps/
│   ├── server/          # Fastify backend + MCP aggregator
│   └── web/             # React + Vite dashboard
├── packages/
│   ├── shared/          # Types, constants, slug utils
│   ├── config-kit/      # Config format & validation
│   └── client-profiles/ # Client-specific config generators
└── data/
    └── hub.db           # SQLite database
```

### Tech Stack


| Layer    | Technology                                                                                                                      |
| -------- | ------------------------------------------------------------------------------------------------------------------------------- |
| Server   | [Fastify](https://fastify.dev/) 5, Node.js 20+                                                                                  |
| Database | SQLite 3 ([better-sqlite3](https://github.com/WiseLibs/better-sqlite3)) + [Drizzle ORM](https://orm.drizzle.team/)              |
| Frontend | [React](https://react.dev/) 19 + [Vite](https://vite.dev/) 6                                                                    |
| Protocol | [MCP Streamable HTTP](https://modelcontextprotocol.io/specification/2025-03-26/basic/transports#streamable-http) + JSON-RPC 2.0 |


### Instance Modes


| Mode            | Behavior                                          | Use Case                |
| --------------- | ------------------------------------------------- | ----------------------- |
| `singleton`     | One process shared across all workspaces          | Heavy / stateless tools |
| `per-workspace` | One process per workspace, shared across sessions | Workspace-scoped state  |
| `per-session`   | One process per client connection                 | Full isolation          |


Shared instances use **reference counting** - they stay alive while any session references them and are stopped when the last reference is released.

## API Reference

**MCPs**


| Method   | Endpoint              | Description               |
| -------- | --------------------- | ------------------------- |
| `GET`    | `/api/mcps`           | List all MCP definitions  |
| `POST`   | `/api/mcps`           | Create MCP                |
| `PATCH`  | `/api/mcps/:id`       | Update MCP                |
| `DELETE` | `/api/mcps/:id`       | Delete MCP                |
| `POST`   | `/api/mcps/:id/test`  | Test MCP connectivity     |
| `POST`   | `/api/mcps/:id/start` | Start MCP instance        |
| `GET`    | `/api/mcps/health`    | Health status of all MCPs |




**Workspaces**


| Method   | Endpoint              | Description      |
| -------- | --------------------- | ---------------- |
| `GET`    | `/api/workspaces`     | List workspaces  |
| `POST`   | `/api/workspaces`     | Create workspace |
| `GET`    | `/api/workspaces/:id` | Get workspace    |
| `PATCH`  | `/api/workspaces/:id` | Update workspace |
| `DELETE` | `/api/workspaces/:id` | Delete workspace |




**Bindings**


| Method   | Endpoint                              | Description    |
| -------- | ------------------------------------- | -------------- |
| `GET`    | `/api/workspaces/:id/bindings`        | List bindings  |
| `PUT`    | `/api/workspaces/:id/bindings`        | Set binding    |
| `DELETE` | `/api/workspaces/:id/bindings/:mcpId` | Remove binding |




**Sessions**


| Method   | Endpoint                    | Description          |
| -------- | --------------------------- | -------------------- |
| `GET`    | `/api/sessions`             | List active sessions |
| `DELETE` | `/api/sessions/:id`         | Destroy session      |
| `POST`   | `/api/sessions/:id/restart` | Restart session      |




**Logs**


| Method   | Endpoint           | Description                                                          |
| -------- | ------------------ | -------------------------------------------------------------------- |
| `GET`    | `/api/logs`        | Query logs (supports `tab`, `sessionId`, `mcpId`, `level`, `cursor`) |
| `DELETE` | `/api/logs`        | Clear all logs                                                       |
| `GET`    | `/api/logs/stream` | SSE stream (supports `tab`, `sessionId`, `mcpId`)                    |




**Settings & Config**


| Method  | Endpoint             | Description            |
| ------- | -------------------- | ---------------------- |
| `GET`   | `/api/settings`      | Get settings           |
| `PATCH` | `/api/settings`      | Update settings        |
| `GET`   | `/api/settings/info` | Server info (data dir) |
| `GET`   | `/api/config/export` | Export full config     |
| `POST`  | `/api/config/import` | Import config          |




**MCP Proxy**


| Method   | Endpoint   | Description                                      |
| -------- | ---------- | ------------------------------------------------ |
| `POST`   | `/w/:slug` | JSON-RPC requests (initialize, tools/call, etc.) |
| `GET`    | `/w/:slug` | SSE notification stream                          |
| `DELETE` | `/w/:slug` | Destroy session                                  |




## Web Dashboard

Access the dashboard at **[http://localhost:3000/app](http://localhost:3000/app)**.


| Page           | Description                                                                 |
| -------------- | --------------------------------------------------------------------------- |
| **Sessions**   | View active client connections, restart or destroy sessions                 |
| **MCPs**       | Define MCP servers, test connectivity, view runtime instances               |
| **Workspaces** | Create workspaces, manage MCP bindings, sync client configs                 |
| **Logs**       | Browse logs by category (Session / MCP / Hub), filter by level, live stream |
| **Settings**   | Configure port, log retention, auto-sync clients, clear logs, import/export |


## Configuration

### Settings


| Key                        | Default | Description                                                  |
| -------------------------- | ------- | ------------------------------------------------------------ |
| `port`                     | `3000`  | Server port (requires restart)                               |
| `syncClients`              | `[]`    | Clients to auto-sync (`cursor`, `claude`, `codex`, `gemini`) |
| `logOptions.pageSize`      | `50`    | Log entries per page                                         |
| `logOptions.retentionDays` | `30`    | Log retention period                                         |


### Data Storage

All data is stored in a SQLite database at `./data/hub.db` relative to the project root. The database is created automatically on first run.

## License

[MIT](./LICENSE)

---

# MCP Hub Local

**[English](#mcp-hub-local)** | **中文**

一个本地化的 MCP 服务器集中管理与编排中心。将多个 AI 客户端连接到统一端点，聚合所有 MCP 服务器的工具、资源和提示词。

```
 Cursor ──┐                           ┌── 文件搜索 MCP
 Claude ──┤                           ├── 网络请求 MCP
  Codex ──┼── MCP Hub Local (/w/ws) ──┼── 数据库 MCP
 Gemini ──┤                           ├── Git MCP
   ...  ──┘                           └── ...
```

## 截图

> **控制面板** - 在一个界面中管理 MCP、工作区、会话和日志。

**Sessions**
![Sessions](docs/screenshots/sessions.png)

**MCPs**
![MCPs](docs/screenshots/mcps.png)

**Workspaces**
![Workspaces](docs/screenshots/workspaces.png)

**Logs**
![Logs](docs/screenshots/logs.png)

**Settings**
![Settings](docs/screenshots/settings.png)


## 功能特性

- **统一 MCP 入口** - 将多个远程和本地 MCP 服务器聚合在一起，通过单一端点访问
- **按 Workspace 管理** - 每个 Workspace 可以设置不同的 MCP 组合，独立端点 `/w/<slug>`
- **自动配置客户端** - 自动将 MCP 配置写入各客户端配置文件，支持 Cursor、Claude Desktop、Codex 和 Gemini
- **灵活的实例模式** - 本地 MCP 支持多种实例化模式：`singleton`（全局单例）、`per-workspace`（按工作区）、`per-session`（按会话）
- **会话监控** - 实时监控每个客户端会话的 MCP 使用情况
- **Web 控制面板** - 通过 `http://localhost:3000/app` 统一管理

## 快速开始

### 前置要求

- **Node.js** >= 20

### 安装与运行

```bash
# 使用 npx 直接运行（无需安装）
npx mcp-hub-local

# 或全局安装
npm install -g mcp-hub-local
mcp-hub-local
```

默认启动地址为 **[http://localhost:3000](http://localhost:3000)**。


| 地址                               | 说明           |
| -------------------------------- | ------------ |
| `http://localhost:3000/app`      | Web 控制面板     |
| `http://localhost:3000/api`      | REST API     |
| `http://localhost:3000/w/<slug>` | MCP 代理（按工作区） |


### 开发模式（从源码）

```bash
git clone https://github.com/<your-org>/mcp-hub-local.git
cd mcp-hub-local
npm install
npm run build

# 服务端热重载
npm run dev

# Web UI 开发服务器（另开终端）
npm run dev:web
```

### 命令行参数

```bash
mcp-hub-local --port 5000
mcp-hub-local --config ./my-config.json
```

## 工作原理

```mermaid
flowchart LR
    subgraph Clients
        C1[Cursor]
        C2[Claude]
        C3[Codex]
    end

    subgraph Hub["MCP Hub Local :3000"]
        direction TB
        WS1["Workspace A<br/>/w/project-a"]
        WS2["Workspace B<br/>/w/project-b"]
        AS[Auto-Sync<br/>Client Configs]
    end

    subgraph MCPs["MCP Servers"]
        M1["File Search<br/>(stdio)"]
        M2["Web Fetch<br/>(stdio)"]
        M3["Remote API<br/>(http)"]
    end

    C1 & C2 & C3 -->|"MCP Protocol"| Hub
    AS -.->|"write configs"| C1 & C2 & C3
    WS1 -->|"singleton"| M1
    WS1 -->|"per-workspace"| M2
    WS1 -->|"per-session"| M3
    WS2 -->|"singleton"| M1
    WS2 -->|"per-workspace"| M3

    style Hub fill:#1a1a2e,stroke:#6c63ff,color:#fff
    style Clients fill:#0d1117,stroke:#58a6ff,color:#fff
    style MCPs fill:#0d1117,stroke:#3fb950,color:#fff
```

## 项目结构

```
local-mcp-hub/
├── apps/
│   ├── server/          # Fastify 后端 + MCP 聚合器
│   └── web/             # React + Vite 控制面板
├── packages/
│   ├── shared/          # 共享类型、常量、slug 工具
│   ├── config-kit/      # 配置格式与校验
│   └── client-profiles/ # 客户端配置生成器
└── data/
    └── hub.db           # SQLite 数据库
```

### 技术栈


| 层级  | 技术                                                                                                                              |
| --- | ------------------------------------------------------------------------------------------------------------------------------- |
| 服务端 | [Fastify](https://fastify.dev/) 5, Node.js 20+                                                                                  |
| 数据库 | SQLite 3 ([better-sqlite3](https://github.com/WiseLibs/better-sqlite3)) + [Drizzle ORM](https://orm.drizzle.team/)              |
| 前端  | [React](https://react.dev/) 19 + [Vite](https://vite.dev/) 6                                                                    |
| 协议  | [MCP Streamable HTTP](https://modelcontextprotocol.io/specification/2025-03-26/basic/transports#streamable-http) + JSON-RPC 2.0 |


### 实例模式


| 模式              | 行为              | 适用场景     |
| --------------- | --------------- | -------- |
| `singleton`     | 全局共享一个进程        | 重型/无状态工具 |
| `per-workspace` | 每个工作区一个进程，跨会话共享 | 工作区级别状态  |
| `per-session`   | 每个客户端连接一个进程     | 完全隔离     |


共享实例使用**引用计数**——只要有会话引用就保持存活，最后一个引用释放时自动停止。

## API 参考

**MCP 管理**


| 方法       | 端点                    | 说明          |
| -------- | --------------------- | ----------- |
| `GET`    | `/api/mcps`           | 列出所有 MCP 定义 |
| `POST`   | `/api/mcps`           | 创建 MCP      |
| `PATCH`  | `/api/mcps/:id`       | 更新 MCP      |
| `DELETE` | `/api/mcps/:id`       | 删除 MCP      |
| `POST`   | `/api/mcps/:id/test`  | 测试 MCP 连通性  |
| `POST`   | `/api/mcps/:id/start` | 启动 MCP 实例   |
| `GET`    | `/api/mcps/health`    | 所有 MCP 健康状态 |




**工作区**


| 方法       | 端点                    | 说明      |
| -------- | --------------------- | ------- |
| `GET`    | `/api/workspaces`     | 列出工作区   |
| `POST`   | `/api/workspaces`     | 创建工作区   |
| `GET`    | `/api/workspaces/:id` | 获取工作区详情 |
| `PATCH`  | `/api/workspaces/:id` | 更新工作区   |
| `DELETE` | `/api/workspaces/:id` | 删除工作区   |




**绑定**


| 方法       | 端点                                    | 说明   |
| -------- | ------------------------------------- | ---- |
| `GET`    | `/api/workspaces/:id/bindings`        | 列出绑定 |
| `PUT`    | `/api/workspaces/:id/bindings`        | 设置绑定 |
| `DELETE` | `/api/workspaces/:id/bindings/:mcpId` | 移除绑定 |




**会话**


| 方法       | 端点                          | 说明     |
| -------- | --------------------------- | ------ |
| `GET`    | `/api/sessions`             | 列出活跃会话 |
| `DELETE` | `/api/sessions/:id`         | 销毁会话   |
| `POST`   | `/api/sessions/:id/restart` | 重启会话   |




**日志**


| 方法       | 端点                 | 说明                                                  |
| -------- | ------------------ | --------------------------------------------------- |
| `GET`    | `/api/logs`        | 查询日志（支持 `tab`、`sessionId`、`mcpId`、`level`、`cursor`） |
| `DELETE` | `/api/logs`        | 清空所有日志                                              |
| `GET`    | `/api/logs/stream` | SSE 实时推送（支持 `tab`、`sessionId`、`mcpId`）              |




**设置与配置**


| 方法      | 端点                   | 说明          |
| ------- | -------------------- | ----------- |
| `GET`   | `/api/settings`      | 获取设置        |
| `PATCH` | `/api/settings`      | 更新设置        |
| `GET`   | `/api/settings/info` | 服务器信息（数据目录） |
| `GET`   | `/api/config/export` | 导出完整配置      |
| `POST`  | `/api/config/import` | 导入配置        |




**MCP 代理**


| 方法       | 端点         | 说明                                   |
| -------- | ---------- | ------------------------------------ |
| `POST`   | `/w/:slug` | JSON-RPC 请求（initialize、tools/call 等） |
| `GET`    | `/w/:slug` | SSE 通知推送流                            |
| `DELETE` | `/w/:slug` | 销毁会话                                 |




## Web 控制面板

访问 **[http://localhost:3000/app](http://localhost:3000/app)** 打开控制面板。


| 页面      | 说明                                      |
| ------- | --------------------------------------- |
| **会话**  | 查看活跃客户端连接，重启或销毁会话                       |
| **MCP** | 定义 MCP 服务器，测试连通性，查看运行实例                 |
| **工作区** | 创建工作区，管理 MCP 绑定，同步客户端配置                 |
| **日志**  | 按分类浏览日志（Session / MCP / Hub），按级别筛选，实时推送 |
| **设置**  | 配置端口、日志保留策略、自动同步客户端、清空日志、导入导出           |


## 配置项


| 配置键                        | 默认值    | 说明                                           |
| -------------------------- | ------ | -------------------------------------------- |
| `port`                     | `3000` | 服务端口（需重启）                                    |
| `syncClients`              | `[]`   | 自动同步的客户端（`cursor`、`claude`、`codex`、`gemini`） |
| `logOptions.pageSize`      | `50`   | 每页日志条数                                       |
| `logOptions.retentionDays` | `30`   | 日志保留天数                                       |


### 数据存储

所有数据存储在项目根目录下的 `./data/hub.db` SQLite 数据库中，首次运行时自动创建。

## 开源协议

[MIT](./LICENSE)