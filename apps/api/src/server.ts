import { readFileSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { AgentGateway, createDefaultAgentGateway, type ChatRequest, type StreamEvent, type UserSettings } from "../../../packages/agent-gateway/src/index.ts";

const WEB_INDEX = new URL("../../web/index.html", import.meta.url);

function html(res: ServerResponse, status: number, body: string): void {
  res.writeHead(status, {
    "content-type": "text/html; charset=utf-8",
    "content-length": Buffer.byteLength(body),
  });
  res.end(body);
}

function json(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(payload),
  });
  res.end(payload);
}

async function readJson<T>(req: IncomingMessage): Promise<T> {
  let raw = "";
  for await (const chunk of req) raw += chunk;
  if (!raw.trim()) return {} as T;
  return JSON.parse(raw) as T;
}

function sseWrite(res: ServerResponse, event: StreamEvent): void {
  res.write(`event: ${event.event}\n`);
  res.write(`data: ${JSON.stringify(event.data)}\n\n`);
}

function requireUserId(url: URL): string | null {
  return url.searchParams.get("user_id");
}

export function createApiServer(gateway: AgentGateway = createDefaultAgentGateway()) {
  return createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? "/", "http://127.0.0.1");

      if (req.method === "GET" && url.pathname === "/") {
        return html(res, 200, readFileSync(WEB_INDEX, "utf8"));
      }

      if (req.method === "GET" && url.pathname === "/health") {
        return json(res, 200, { ok: true });
      }

      if (req.method === "POST" && url.pathname === "/chat") {
        const body = await readJson<ChatRequest>(req);
        const response = await gateway.chat(body);
        return json(res, 200, response);
      }

      if (req.method === "POST" && url.pathname === "/chat/stream") {
        const body = await readJson<ChatRequest>(req);
        res.writeHead(200, {
          "content-type": "text/event-stream; charset=utf-8",
          "cache-control": "no-cache, no-transform",
          connection: "keep-alive",
          "x-accel-buffering": "no",
        });
        for await (const event of gateway.stream(body)) sseWrite(res, event);
        return res.end();
      }

      if (req.method === "GET" && url.pathname === "/memories") {
        const userId = requireUserId(url);
        if (!userId) return json(res, 400, { error: "missing_user_id" });
        return json(res, 200, { memories: gateway.listMemories(userId) });
      }

      const memoryMatch = url.pathname.match(/^\/memories\/([^/]+)$/);
      if (req.method === "DELETE" && memoryMatch) {
        const userId = requireUserId(url);
        if (!userId) return json(res, 400, { error: "missing_user_id" });
        const deleted = gateway.deleteMemory(userId, decodeURIComponent(memoryMatch[1]));
        return json(res, deleted ? 200 : 404, { deleted });
      }

      if (req.method === "GET" && url.pathname === "/settings") {
        const userId = requireUserId(url);
        if (!userId) return json(res, 400, { error: "missing_user_id" });
        return json(res, 200, gateway.getUserSettings(userId));
      }

      if ((req.method === "PATCH" || req.method === "POST") && url.pathname === "/settings") {
        const userId = requireUserId(url);
        if (!userId) return json(res, 400, { error: "missing_user_id" });
        const patch = await readJson<Partial<UserSettings>>(req);
        return json(res, 200, gateway.updateUserSettings(userId, patch));
      }

      return json(res, 404, { error: "not_found" });
    } catch (error) {
      return json(res, 500, {
        error: "internal_error",
        message: error instanceof Error ? error.message : String(error),
      });
    }
  });
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const port = Number(process.env.PORT ?? 3000);
  createApiServer().listen(port, () => {
    console.log(`FlowSky API listening on http://127.0.0.1:${port}`);
  });
}
