# Local Run / Packaging

## Local

```bash
cp .env.example .env.local
# edit .env.local and set DEEPSEEK_API_KEY, or type a BYOK key in the UI
npm run dev:api
```

Open `http://127.0.0.1:3000/`.

Default local state (SQLite includes settings, memories, sessions/messages, tool calls, and audit metadata):

```text
~/.liukong/liukong.db
~/.liukong/local_token
~/.liukong/characters/default_girlfriend.json
```

For repo-local development state:

```bash
LIUKONG_DATA_DIR=./.local npm run dev:api
```

## Docker

```bash
docker build -t liukong:local .
docker run --rm -p 127.0.0.1:3000:3000 \
  -e DEEPSEEK_API_KEY \
  -e LIUKONG_HOST=0.0.0.0 \
  -e LIUKONG_ALLOW_NON_LOOPBACK=true \
  -v liukong-data:/data \
  liukong:local
```

The container stores SQLite state under `/data` by default. Bind the published port to `127.0.0.1` unless you have added an external security layer.

## Required local settings

- `DEEPSEEK_API_KEY`: optional if the user types BYOK in the UI, required for headless/smoke use.
- `LIUKONG_DATA_DIR`: persistent local data directory, default `~/.liukong` and `/data` in Docker.
- `LIUKONG_HOST`: defaults to `127.0.0.1`; non-loopback requires `LIUKONG_ALLOW_NON_LOOPBACK=true` and should be used only inside trusted container/sandbox packaging.
- `LIUKONG_REQUIRE_LOCAL_TOKEN`: defaults to `true`.

## CI

GitHub Actions runs:

```bash
npm test
npm run check:secrets
docker build -t liukong-ci .
```
