# Local-first Security Notes

## Threat model

Liukong is designed as a local developer project, not a hosted multi-user cloud product.

- No central account system.
- No cloud database.
- No cloud sync by default.
- The only default external dependency is the model API chosen by the user. DeepSeek is the default provider; OpenAI-compatible OpenAI can be selected explicitly. Local Ollama can be selected to keep model inference on the user's machine.

## Secrets

- Never commit `.env.local`, `.env`, database files, logs, tokens, or provider credentials.
- `DEEPSEEK_API_KEY` or `OPENAI_API_KEY` may be stored in local `.env.local` or typed into the UI as provider-scoped BYOK. Ollama usually needs no API key.
- UI-entered BYOK keys are sent only to `localhost` chat endpoints and stored only in browser `sessionStorage`, keyed by selected provider. Provider choice is non-secret and may be stored in `localStorage`.
- The backend must never write API keys to SQLite, audit logs, prompt hashes, or error bodies. Provider base URLs are server-side environment configuration in this minimal patch, not browser-supplied values.
- `npm run check:secrets` scans tracked files for common key patterns.

## Local token

The local server creates `~/.liukong/local_token` and injects it into the served page. Protected APIs require `x-liukong-local-token` by default.

This is not an account login. It is a localhost CSRF guard so unrelated websites cannot casually call the local API from the user's browser.

## Network binding

The executable server defaults to `LIUKONG_HOST=127.0.0.1` and refuses non-loopback hosts unless `LIUKONG_ALLOW_NON_LOOPBACK=true` is explicitly set. Use that only inside trusted container/sandbox packaging and bind the host port to loopback when possible.

The desktop launcher keeps the same localhost model: it starts the local API server and opens an app-mode browser window against `http://127.0.0.1:<port>/`. It does not embed provider API keys, local tokens, or database contents into the `.desktop` file.

## User data

- Long-term memories are local SQLite rows.
- Heuristic long-term memory extraction stores concise third-person summaries for durable preferences instead of raw chat sentences when possible; duplicate entries are skipped and newer durable preferences can replace older matching preference slots.
- Lightweight emotional state is stored locally as mood/intensity/support-need metadata, not raw emotional diary text.
- Sensitive memories are stored as pending candidates only and require explicit confirmation.
- Users can view, delete, export, import/restore, and reset local data.
- Editable character cards are validated before saving or import; romance cards must remain adult-coded and must forbid claiming to be human or replacing real relationships.
- Audit logs store prompt hashes, memory IDs, tool call IDs, usage and flags — not full prompts.
- Local import restores only the currently authenticated profile; imported `profile_id` / `user_id` values are ignored and rewritten locally. API keys and local tokens are never part of import/export. Character-card import is limited to the validated default local card.

## Tools

Only low-risk tools are allowlisted in v1. Shell, full filesystem, contacts, payment, browser history and auto-send-message style tools are denied.

If future local file tools are added, they must use explicit directory selection, read-only default, and second confirmation for write/delete.
