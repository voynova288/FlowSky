# Local-first Security Notes

## Threat model

Liukong is designed as a local developer project, not a hosted multi-user cloud product.

- No central account system.
- No cloud database.
- No cloud sync by default.
- The only default external dependency is the model API chosen by the user, currently DeepSeek.

## Secrets

- Never commit `.env.local`, `.env`, database files, logs, tokens, or provider credentials.
- `DEEPSEEK_API_KEY` may be stored in local `.env.local` or typed into the UI as BYOK.
- UI-entered BYOK keys are sent only to `localhost` chat endpoints and stored only in browser `sessionStorage`.
- The backend must never write API keys to SQLite, audit logs, prompt hashes, or error bodies.
- `npm run check:secrets` scans tracked files for common key patterns.

## Local token

The local server creates `~/.liukong/local_token` and injects it into the served page. Protected APIs require `x-liukong-local-token` by default.

This is not an account login. It is a localhost CSRF guard so unrelated websites cannot casually call the local API from the user's browser.

## Network binding

The executable server defaults to `LIUKONG_HOST=127.0.0.1` and refuses non-loopback hosts unless `LIUKONG_ALLOW_NON_LOOPBACK=true` is explicitly set. Use that only inside trusted container/sandbox packaging and bind the host port to loopback when possible.

## User data

- Long-term memories are local SQLite rows.
- Sensitive memories are stored as pending candidates only and require explicit confirmation.
- Users can view, delete, export, and reset local data.
- Audit logs store prompt hashes, memory IDs, tool call IDs, usage and flags — not full prompts.

## Tools

Only low-risk tools are allowlisted in v1. Shell, full filesystem, contacts, payment, browser history and auto-send-message style tools are denied.

If future local file tools are added, they must use explicit directory selection, read-only default, and second confirmation for write/delete.
