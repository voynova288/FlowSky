import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { AgentGateway, createDefaultAgentGateway, LocalCharacterStore, SqliteStateStore } from "../../packages/agent-gateway/src/index.ts";
import { createApiServer } from "../../apps/api/src/server.ts";
import { FakeProvider } from "../helpers.ts";

async function withServer<T>(fn: (baseUrl: string) => Promise<T>): Promise<T> {
  const dir = mkdtempSync(join(tmpdir(), "liukong-api-"));
  const server = createApiServer({
    gateway: new AgentGateway({ provider: new FakeProvider() }),
    characterStore: new LocalCharacterStore({ dataDir: dir }),
    requireLocalToken: false,
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.equal(typeof address, "object");
  const baseUrl = `http://127.0.0.1:${address!.port}`;
  try {
    return await fn(baseUrl);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
    rmSync(dir, { recursive: true, force: true });
  }
}

async function withStatefulServer<T>(fn: (baseUrl: string, store: SqliteStateStore) => Promise<T>): Promise<T> {
  const dir = mkdtempSync(join(tmpdir(), "liukong-stateful-api-"));
  const store = new SqliteStateStore(join(dir, "state.db"));
  const server = createApiServer({
    stateStore: store,
    characterStore: new LocalCharacterStore({ dataDir: dir }),
    requireLocalToken: false,
    gatewayFactory: () => createDefaultAgentGateway({ provider: new FakeProvider(), stateStore: store }),
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.equal(typeof address, "object");
  const baseUrl = `http://127.0.0.1:${address!.port}`;
  try {
    return await fn(baseUrl, store);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
    store.close();
    rmSync(dir, { recursive: true, force: true });
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

test("api character route reads, updates, and validates local character card", async () => {
  await withServer(async (baseUrl) => {
    const loaded = await fetch(`${baseUrl}/character?profile_id=u1`);
    const body = await loaded.json();
    assert.equal(body.character.name, "Mika");

    const updated = await fetch(`${baseUrl}/character?profile_id=u1`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ character: { ...body.character, name: "本地 Mika" } }),
    });
    assert.equal(updated.status, 200);
    assert.equal((await updated.json()).character.name, "本地 Mika");

    const invalid = await fetch(`${baseUrl}/character?profile_id=u1`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ character: { ...body.character, boundaries: { ...body.character.boundaries, do_not_claim_to_be_human: false } } }),
    });
    assert.equal(invalid.status, 400);
  });
});

test("api session routes create, list, rename, load messages, and archive sessions", async () => {
  await withStatefulServer(async (baseUrl, store) => {
    const created = await fetch(`${baseUrl}/sessions?profile_id=u1`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ id: "s-api-1", title: "初始标题" }),
    });
    assert.equal(created.status, 200);
    assert.equal((await created.json()).session.title, "初始标题");

    await fetch(`${baseUrl}/chat`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-liukong-api-key": "test-byok" },
      body: JSON.stringify({ profile_id: "u1", session_id: "s-api-1", input: { type: "text", text: "第一条消息" } }),
    });
    assert.equal(store.recentMessages("u1", "s-api-1").length, 2);

    const sessions = await fetch(`${baseUrl}/sessions?profile_id=u1`);
    const sessionsBody = await sessions.json();
    assert.equal(sessionsBody.sessions.length, 1);
    assert.equal(sessionsBody.sessions[0].message_count, 2);

    const messages = await fetch(`${baseUrl}/sessions/s-api-1/messages?profile_id=u1`);
    const messagesBody = await messages.json();
    assert.deepEqual(messagesBody.messages.map((message: any) => message.role), ["user", "assistant"]);

    const renamed = await fetch(`${baseUrl}/sessions/s-api-1?profile_id=u1`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ title: "改名后" }),
    });
    assert.equal((await renamed.json()).session.title, "改名后");

    const archived = await fetch(`${baseUrl}/sessions/s-api-1?profile_id=u1`, { method: "DELETE" });
    assert.deepEqual(await archived.json(), { deleted: true });

    const active = await fetch(`${baseUrl}/sessions?profile_id=u1`);
    assert.equal((await active.json()).sessions.length, 0);
    const all = await fetch(`${baseUrl}/sessions?profile_id=u1&include_archived=true`);
    assert.equal((await all.json()).sessions[0].status, "archived");
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


test("web UI allows backend env key path", async () => {
  await withServer(async (baseUrl) => {
    const root = await fetch(`${baseUrl}/`);
    const rootHtml = await root.text();
    assert.equal(rootHtml.includes("if (!apiKey.value.trim())"), false);
    assert.match(rootHtml, /headers\(true, true\)/);
    assert.match(rootHtml, /留空则使用后端/);
  });
});

test("chat routes reject malformed bodies with bad_request before model path", async () => {
  await withServer(async (baseUrl) => {
    const invalidBodies = [
      undefined,
      null,
      {},
      { session_id: "s1" },
      { session_id: 1, input: { type: "text", text: "hi" } },
      { session_id: "s1", input: null },
      { session_id: "s1", input: { type: "image", text: "hi" } },
      { session_id: "s1", input: { type: "text" } },
      { session_id: "s1", input: { type: "text", text: "hi" }, mode: "admin" },
      { session_id: "s1", input: { type: "text", text: "hi" }, client_context: { voice_enabled: "yes" } },
    ];
    for (const route of ["/chat", "/chat/stream"]) {
      for (const body of invalidBodies) {
        const response = await fetch(`${baseUrl}${route}`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: body === undefined ? undefined : JSON.stringify(body),
        });
        assert.equal(response.status, 400, `${route} should reject ${JSON.stringify(body)}`);
        assert.deepEqual(await response.json(), { error: "bad_request" });
      }
    }
  });
});


test("web UI exposes avatar state panel and voice checkbox", () => {
  const rootHtml = readFileSync("apps/web/index.html", "utf8");
  assert.match(rootHtml, /id="avatarStatePanel"/);
  assert.match(rootHtml, /id="avatarEmotion"/);
  assert.match(rootHtml, /id="avatarAction"/);
  assert.match(rootHtml, /id="voiceStatus"/);
  assert.match(rootHtml, /(?:id="voiceEnabled"\s+type="checkbox"|type="checkbox"\s+id="voiceEnabled")/);
});

test("web UI persists voice setting and passes it in client_context", () => {
  const rootHtml = readFileSync("apps/web/index.html", "utf8");
  assert.match(rootHtml, /localStorage\.getItem\('liukong\.voice_enabled'\)/);
  assert.match(rootHtml, /localStorage\.setItem\('liukong\.voice_enabled'/);
  assert.match(rootHtml, /voice_enabled:\s*voiceEnabled\.checked/);
  assert.equal(rootHtml.includes("voice_enabled: false"), false);
});

test("web UI speaks final assistant text through browser speechSynthesis only", () => {
  const rootHtml = readFileSync("apps/web/index.html", "utf8");
  assert.match(rootHtml, /function speakFinalAssistantText/);
  assert.match(rootHtml, /SpeechSynthesisUtterance/);
  assert.match(rootHtml, /speechSynthesis\.speak/);
  assert.match(rootHtml, /speakFinalAssistantText\(aiBox\.textContent\)/);
  assert.doesNotMatch(rootHtml, /\/tts|elevenlabs|api\.openai\.com\/v1\/audio|speech\.googleapis|polly/i);
});
