# Deploy

## Local

```bash
export DEEPSEEK_API_KEY="..."
export FLOWSKY_JWT_SECRET="change-me"
npm run dev:api
```

Open `http://127.0.0.1:3000/`.

## Docker

```bash
docker build -t flowsky:local .
docker run --rm -p 3000:3000 \
  -e DEEPSEEK_API_KEY \
  -e FLOWSKY_JWT_SECRET \
  -v flowsky-data:/data \
  flowsky:local
```

The container stores SQLite state at `/data/state.db` by default.

## Required production settings

- `DEEPSEEK_API_KEY`: provided by secret manager, never committed.
- `FLOWSKY_JWT_SECRET`: required for real multi-user deployments.
- `FLOWSKY_STATE_DB`: point to persistent volume if not using Docker default.
- `HOST`: defaults to `127.0.0.1`; set `0.0.0.0` only with JWT/token auth enabled.
- TLS and reverse proxy rate limiting should be configured outside this app.

## CI

GitHub Actions runs:

```bash
npm test
npm run check:secrets
```
