# Security Notes

## Secrets

- Never commit `API.txt`, `.env`, database files, or provider credentials.
- Use `DEEPSEEK_API_KEY` from the deployment secret manager.
- `npm run check:secrets` scans tracked files for common key patterns.

## API auth modes

FlowSky supports three modes:

1. `FLOWSKY_JWT_SECRET` set: all protected APIs require a Bearer HS256 JWT; `sub` becomes `user_id`.
2. `FLOWSKY_API_AUTH_TOKEN` set: all protected APIs require that Bearer token; `x-flowsky-user-id` selects the user inside that trusted token context.
3. Neither set: local dev mode; request `user_id` is accepted for convenience. The executable server defaults to `HOST=127.0.0.1` and refuses non-loopback binds without one of the auth settings.

Use mode 1 for real users. Mode 2 is only for trusted internal demos.

## User data

- Long-term memories are minimized and can be listed/deleted.
- Sensitive memories are stored as pending candidates only and require explicit confirmation.
- Audit logs store prompt hashes, memory IDs, tool call IDs, usage and flags — not full prompts.

## Tools

Only low-risk tools are allowlisted in v1. Shell, full filesystem, contacts, payment, browser history and auto-send-message style tools are denied.
