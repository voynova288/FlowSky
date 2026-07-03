import test from "node:test";
import assert from "node:assert/strict";
import { AgentGateway } from "../../packages/agent-gateway/src/index.ts";
import { createApiServer } from "../../apps/api/src/server.ts";
import { FakeProvider } from "../helpers.ts";

async function withServer<T>(fn: (baseUrl: string) => Promise<T>): Promise<T> {
  const server = createApiServer({ gateway: new AgentGateway({ provider: new FakeProvider() }), requireLocalToken: false });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.equal(typeof address, "object");
  const baseUrl = `http://127.0.0.1:${address!.port}`;
  try {
    return await fn(baseUrl);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
  }
}

test("api health, web root, and chat routes", async () => {
  await withServer(async (baseUrl) => {
    const root = await fetch(`${baseUrl}/`);
    const rootHtml = await root.text();
    assert.match(rootHtml, /流空 Liukong/);
    assert.match(rootHtml, /__LIUKONG_LOCAL__/);

    const health = await fetch(`${baseUrl}/health`);
    const healthBody = await health.json();
    assert.equal(healthBody.ok, true);
    assert.equal(healthBody.mode, "local");

    const chat = await fetch(`${baseUrl}/chat`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ profile_id: "u1", session_id: "s1", input: { type: "text", text: "今天有点累" } }),
    });
    const body = await chat.json();
    assert.equal(chat.status, 200);
    assert.match(body.text, /辛苦/);
  });
});

test("api stream route emits SSE", async () => {
  await withServer(async (baseUrl) => {
    const response = await fetch(`${baseUrl}/chat/stream`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ profile_id: "u1", session_id: "s1", input: { type: "text", text: "今天有点累" } }),
    });
    const text = await response.text();
    assert.equal(response.status, 200);
    assert.match(text, /event: text_delta/);
    assert.match(text, /event: done/);
  });
});

test("api settings and memory routes", async () => {
  await withServer(async (baseUrl) => {
    const settings = await fetch(`${baseUrl}/settings?profile_id=u1`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ preferred_name: "主人" }),
    });
    const settingsBody = await settings.json();
    assert.equal(settingsBody.preferred_name, "主人");

    const badSettings = await fetch(`${baseUrl}/settings?profile_id=u1`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ romance_realism_level: 99 }),
    });
    assert.equal(badSettings.status, 400);

    await fetch(`${baseUrl}/chat`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ profile_id: "u1", session_id: "s1", input: { type: "text", text: "请记住我喜欢短句回复。" } }),
    });
    const memories = await fetch(`${baseUrl}/memories?profile_id=u1`);
    const body = await memories.json();
    assert.equal(body.memories.length, 1);

    const id = body.memories[0].id;
    const badMemory = await fetch(`${baseUrl}/memories/${id}?profile_id=u1`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ memory_type: "script" }),
    });
    assert.equal(badMemory.status, 400);

    const deleted = await fetch(`${baseUrl}/memories/${id}?profile_id=u1`, { method: "DELETE" });
    assert.deepEqual(await deleted.json(), { deleted: true });
  });
});
