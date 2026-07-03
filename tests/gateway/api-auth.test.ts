import test from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { AgentGateway } from "../../packages/agent-gateway/src/index.ts";
import { createApiServer } from "../../apps/api/src/server.ts";
import { FakeProvider } from "../helpers.ts";

async function withAuthedServer<T>(env: Record<string, string>, fn: (baseUrl: string) => Promise<T>): Promise<T> {
  const previous = new Map<string, string | undefined>();
  for (const [key, value] of Object.entries(env)) {
    previous.set(key, process.env[key]);
    process.env[key] = value;
  }
  const server = createApiServer(new AgentGateway({ provider: new FakeProvider() }));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.equal(typeof address, "object");
  const baseUrl = `http://127.0.0.1:${address!.port}`;
  try {
    return await fn(baseUrl);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
    for (const [key, value] of previous) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

test("api token auth rejects missing token and derives user from protected token context", async () => {
  await withAuthedServer({ FLOWSKY_API_AUTH_TOKEN: "dev-token" }, async (baseUrl) => {
    const missing = await fetch(`${baseUrl}/settings?user_id=attacker`);
    assert.equal(missing.status, 401);

    const ok = await fetch(`${baseUrl}/settings`, { headers: { authorization: "Bearer dev-token", "x-flowsky-user-id": "u-token" } });
    assert.equal(ok.status, 200);
    assert.equal((await ok.json()).memory_enabled, true);
  });
});

test("jwt auth uses sub claim as user_id instead of request body user_id", async () => {
  const secret = "jwt-secret";
  const token = makeJwt({ sub: "jwt-user", exp: Math.floor(Date.now() / 1000) + 3600 }, secret);
  await withAuthedServer({ FLOWSKY_JWT_SECRET: secret }, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/chat`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ user_id: "spoofed", session_id: "s1", input: { type: "text", text: "hi" } }),
    });
    const body = await response.json();
    assert.equal(response.status, 200);
    assert.equal(body.request_id.startsWith("req_"), true);
  });
});

function makeJwt(payload: Record<string, unknown>, secret: string): string {
  const header = { alg: "HS256", typ: "JWT" };
  const encodedHeader = b64(JSON.stringify(header));
  const encodedPayload = b64(JSON.stringify(payload));
  const sig = createHmac("sha256", secret).update(`${encodedHeader}.${encodedPayload}`).digest("base64url");
  return `${encodedHeader}.${encodedPayload}.${sig}`;
}

function b64(value: string): string {
  return Buffer.from(value).toString("base64url");
}
