import test from "node:test";
import assert from "node:assert/strict";
import { AgentGateway, SqliteStateStore } from "../../packages/agent-gateway/src/index.ts";
import { createApiServer } from "../../apps/api/src/server.ts";
import { FakeProvider } from "../helpers.ts";

async function withLocalServer<T>(fn: (baseUrl: string, token: string) => Promise<T>): Promise<T> {
  const token = "local-test-token";
  const server = createApiServer({
    gateway: new AgentGateway({ provider: new FakeProvider() }),
    localToken: token,
    requireLocalToken: true,
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.equal(typeof address, "object");
  const baseUrl = `http://127.0.0.1:${address!.port}`;
  try {
    return await fn(baseUrl, token);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
  }
}

test("local token protects local profile APIs", async () => {
  await withLocalServer(async (baseUrl, token) => {
    const missing = await fetch(`${baseUrl}/settings?profile_id=default`);
    assert.equal(missing.status, 401);

    const ok = await fetch(`${baseUrl}/settings?profile_id=default`, { headers: { "x-liukong-local-token": token } });
    assert.equal(ok.status, 200);
    assert.equal((await ok.json()).memory_enabled, true);
  });
});

test("BYOK header is required and is passed only to chat gateway factory", async () => {
  const token = "local-test-token";
  const stateStore = new SqliteStateStore(":memory:");
  let seenKey = "";
  const server = createApiServer({
    stateStore,
    localToken: token,
    requireLocalToken: true,
    gatewayFactory: (apiKey) => {
      seenKey = apiKey;
      return new AgentGateway({ provider: new FakeProvider() });
    },
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.equal(typeof address, "object");
  const baseUrl = `http://127.0.0.1:${address!.port}`;
  try {
    const missing = await fetch(`${baseUrl}/chat`, {
      method: "POST",
      headers: { "x-liukong-local-token": token, "content-type": "application/json" },
      body: JSON.stringify({ profile_id: "default", session_id: "s1", input: { type: "text", text: "hi" } }),
    });
    assert.equal(missing.status, 400);
    assert.equal((await missing.json()).error, "missing_provider_key");

    const ok = await fetch(`${baseUrl}/chat`, {
      method: "POST",
      headers: { "x-liukong-local-token": token, "x-liukong-api-key": "byok-test-key", "content-type": "application/json" },
      body: JSON.stringify({ profile_id: "default", session_id: "s1", input: { type: "text", text: "hi" } }),
    });
    assert.equal(ok.status, 200);
    assert.equal(seenKey, "byok-test-key");
    assert.equal(JSON.stringify(stateStore.auditEntries()).includes("byok-test-key"), false);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
    stateStore.close();
  }
});

test("local profile header scopes settings without login", async () => {
  await withLocalServer(async (baseUrl, token) => {
    const headers = { "x-liukong-local-token": token, "x-liukong-profile-id": "local-a", "content-type": "application/json" };
    const response = await fetch(`${baseUrl}/settings`, {
      method: "PATCH",
      headers,
      body: JSON.stringify({ preferred_name: "本地 A" }),
    });
    assert.equal(response.status, 200);

    const profileA = await fetch(`${baseUrl}/settings`, { headers });
    assert.equal((await profileA.json()).preferred_name, "本地 A");

    const profileB = await fetch(`${baseUrl}/settings`, {
      headers: { "x-liukong-local-token": token, "x-liukong-profile-id": "local-b" },
    });
    assert.equal((await profileB.json()).preferred_name, undefined);
  });
});
