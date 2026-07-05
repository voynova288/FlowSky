# Local Run / Packaging

## Local

```bash
cp .env.example .env.local
# edit .env.local and set DEEPSEEK_API_KEY / OPENAI_API_KEY,
# or set LIUKONG_PROVIDER=ollama for local Ollama, or type a provider-scoped BYOK key in the UI
npm run dev:api
```

Open `http://127.0.0.1:3000/`.

For a desktop app-style window without adding Electron/Tauri dependencies:

```bash
npm run desktop
```

To install a launcher into the Linux application menu and the desktop folder when present:

```bash
npm run desktop:install
```

The launcher starts the same localhost server, then opens a Chromium/Chrome-compatible `--app=` window with a separate browser profile under `~/.liukong/desktop-browser-profile`.

Default local state (SQLite includes settings, memories, lightweight emotional state, sessions/messages, persisted reminder timers, tool calls, and audit metadata; export/import also includes the default character card and works through the local web UI or `/local/export` + `/local/import`):

```text
~/.liukong/liukong.db
~/.liukong/local_token
~/.liukong/characters/default_girlfriend.json
```

For repo-local development state:

```bash
LIUKONG_DATA_DIR=./.local npm run dev:api
```

## Desktop launcher notes

- The desktop launcher does not bundle secrets and does not change the local-first threat model.
- It uses `LIUKONG_PORT`, `LIUKONG_HOST`, `LIUKONG_DATA_DIR`, and provider env vars exactly like `npm run dev:api`.
- Set `LIUKONG_DESKTOP_BROWSER=/path/to/browser` if Chrome/Chromium is not auto-detected.
- If no app-mode browser is found, it falls back to `xdg-open` / platform default browser.

## Docker

```bash
docker build -t liukong:local .
docker run --rm -p 127.0.0.1:3000:3000 \
  -e LIUKONG_PROVIDER=deepseek \
  -e DEEPSEEK_API_KEY \
  -e OPENAI_API_KEY \
  -e OLLAMA_BASE_URL=http://host.docker.internal:11434/v1 \
  -e LIUKONG_HOST=0.0.0.0 \
  -e LIUKONG_ALLOW_NON_LOOPBACK=true \
  -v liukong-data:/data \
  liukong:local
```

The container stores SQLite state under `/data` by default. Bind the published port to `127.0.0.1` unless you have added an external security layer.

## Required local settings

- `LIUKONG_PROVIDER`: `deepseek` by default, or `openai` / `ollama`.
- `DEEPSEEK_API_KEY` / `OPENAI_API_KEY`: optional if the user types BYOK in the UI, required for headless use for those providers. `OLLAMA_API_KEY` is optional and usually blank.
- `DEEPSEEK_BASE_URL` / `OPENAI_BASE_URL` / `OLLAMA_BASE_URL`: server-side OpenAI-compatible endpoints; do not expose arbitrary base URL selection to the browser.
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
