# 流空 Liukong

流空是一个 **local-first / BYOK / 无账号** 的 AI companion / AI girlfriend 框架。

- 无需注册，clone 后本地运行
- 用户自带 DeepSeek 或 OpenAI API key，也可用 `.env.local` 本地配置
- 聊天、记忆、设置、角色卡、日志默认保存在本机
- 默认不上传遥测，不提供云同步
- 默认绑定 `127.0.0.1`，不开放局域网访问
- 高风险工具默认关闭；所有模型调用必须经过本地 Agent Gateway

## Quick Start

```bash
git clone git@github.com:voynova288/FlowSky.git
cd FlowSky
cp .env.example .env.local
# 编辑 .env.local，填入 DEEPSEEK_API_KEY 或 OPENAI_API_KEY；也可以在网页里临时选择 provider 并填 BYOK key
npm run dev:api
```

打开：

```text
http://127.0.0.1:3000/
```

常用检查：

```bash
npm test
npm run check:secrets
npm run smoke:deepseek   # 仅 DeepSeek live smoke；读取 .env.local 或当前 shell 的 DEEPSEEK_API_KEY
```

## 本地数据

默认数据目录：

```text
~/.liukong/
  liukong.db
  local_token
  characters/default_girlfriend.json
```

可用环境变量覆盖：

```bash
LIUKONG_DATA_DIR=./.local npm run dev:api
```

`.env.local`、`.local/`、数据库、日志和密钥文件都不会提交到 Git。

## 架构

```text
Browser/Desktop UI
  ↓ localhost + local token
Local API Server
  ↓
Local Pi/Agent Gateway
  ├── DeepSeekProvider / OpenAI-compatible providers
  ├── PromptAssembler
  ├── CharacterEngine
  ├── MemoryController
  ├── Safety/Romance gates
  └── LocalToolRouter
  ↓
DeepSeek 或 OpenAI API（用户自带 key）
```

没有中心化账号、中心化数据库、中心化聊天记录或服务端托管 API key。

## HTTP API v1

所有本地 API 默认需要 `x-liukong-local-token`，该 token 由本地 server 注入页面，用来防止其他网页随意请求你的 localhost 服务。

- `GET /` — minimal local web UI
- `GET /health`
- `POST /chat` — 需要 `x-liukong-api-key` 或本机 `.env.local` 的 provider key；可用 `x-liukong-provider: deepseek|openai` 选择 provider，默认 deepseek
- `POST /chat/stream` — SSE: `text_delta` / `avatar_signal` / `memory_candidate` / `done` / `error`
- `GET /character?profile_id=default`
- `PATCH /character?profile_id=default`
- `POST /character/reset?profile_id=default`
- `GET /sessions?profile_id=default`
- `POST /sessions?profile_id=default`
- `GET /sessions/:id/messages?profile_id=default`
- `PATCH /sessions/:id?profile_id=default`
- `DELETE /sessions/:id?profile_id=default` — archive session
- `GET /settings?profile_id=default`
- `PATCH /settings?profile_id=default`
- `GET /memories?profile_id=default`
- `PATCH /memories/:id?profile_id=default`
- `POST /memories/:id/confirm?profile_id=default`
- `POST /memories/:id/reject?profile_id=default`
- `DELETE /memories/:id?profile_id=default`
- `GET /local/export?profile_id=default`
- `POST /local/reset?profile_id=default`

## 当前范围

- Provider：DeepSeek 默认，OpenAI 可选；均走 OpenAI-compatible chat completions、stream、JSON output、tool calls、API key 脱敏
- AgentGateway：统一 `ChatRequest` / `AgentResponse`、streaming events、request_id、usage/latency/safety 记录
- PromptAssembler：文件化 system/compliance/output policy、JSON 角色卡、关系状态、用户设置、记忆注入
- MemoryController：记忆抽取、写入 gate、pending/confirm/reject/edit、检索、删除、敏感信息确认逻辑
- SQLite 本地持久化：settings、memories、sessions/messages、relationship、tool_calls、local_audit_logs view
- Local token：默认保护 localhost API
- 本地角色卡：首次启动复制默认角色卡到 `~/.liukong/characters/`，支持查看、编辑、恢复默认
- 本地导出/清空：JSON export + reset profile data
- 最小 Web UI：聊天、session 管理、settings、character、memory、local export/reset
- CI / Docker / security notes

## 安全原则

- API key 永远不进前端 bundle，不写入 SQLite，不进入日志
- 前端 BYOK key 仅保存在 `sessionStorage`
- 默认不保存完整 prompt，只保存 prompt hash、usage、latency、safety flags
- 默认允许低风险工具：时间、进程内本地 timer、会话总结、读取/更新本地设置
- 默认禁止 shell、完整文件系统、浏览器历史、联系人、邮件、支付、自动发消息等高风险工具

## 目录

```text
apps/api/                         # 本地 API server
apps/web/                         # 最小 Web UI
packages/agent-gateway/src/       # LLM / Agent Gateway 核心
tests/                            # node:test 单元测试
```
