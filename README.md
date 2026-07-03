# FlowSky / 流空

FlowSky 是一个 AI 陪伴 / AI 女友项目的 v1 工程骨架。当前版本把 DeepSeek API 放在模型能力层，把 `packages/agent-gateway` 作为项目后端与模型之间的唯一 LLM / Agent Gateway。

## 当前范围

v1 只实现：

- DeepSeekProvider：OpenAI-compatible chat completions、stream、JSON output、thinking 配置、API key 脱敏
- AgentGateway：统一 `ChatRequest` / `AgentResponse`、streaming events、request_id、usage/latency/safety 记录
- PromptAssembler：文件化 system/compliance/output policy、JSON 角色卡、关系状态、用户设置、记忆注入
- CharacterEngine：成年角色卡、关系阶段推进 gate
- MemoryController：记忆抽取、写入 gate、检索、删除、敏感信息确认逻辑
- SafetyGate：input/output/memory/tool/romance realism gates
- ToolRouter：仅开放低风险工具
- Node 内置测试套件
- Node 内置 SQLite 持久化（实验特性）：默认写入 `.flowsky/state.db`，可用 `FLOWSKY_STATE_DB` 覆盖
- 最小 Web 聊天页：`GET /`，消费 `/chat/stream` SSE

## 安全与密钥

本仓库不应提交任何 API key。

本地已有 `API.txt` 仅用于开发测试，已在 `.gitignore` 中忽略。运行真实 DeepSeek 调用前，请在当前 shell 中手动导出：

```bash
export DEEPSEEK_API_KEY="$(cat API.txt)"
```

不要把 `API.txt`、`.env` 或任何 key push 到 GitHub。

## 常用命令

```bash
npm test
npm run check:secrets
npm run smoke:deepseek   # uses DEEPSEEK_API_KEY or local gitignored API.txt
npm run dev:api           # open http://127.0.0.1:3000/
```

持久化默认位置：

```bash
FLOWSKY_STATE_DB=.flowsky/state.db npm run dev:api
```

## GitHub

目标远端：

```text
git@github.com:voynova288/FlowSky.git
```

当前开发规则：可以本地 init / commit，但不要自动 push；push 前先跑测试和 secret check。

## HTTP API v1

- `GET /health`
- `POST /chat`
- `POST /chat/stream` — SSE: `text_delta` / `avatar_signal` / `memory_candidate` / `done` / `error`
- `GET /settings?user_id=...`
- `PATCH /settings?user_id=...`
- `GET /memories?user_id=...`
- `DELETE /memories/:id?user_id=...`

## 目录

```text
apps/api/                         # 最小 API server 示例
packages/agent-gateway/src/       # LLM / Agent Gateway 核心
tests/                            # node:test 单元测试
```
