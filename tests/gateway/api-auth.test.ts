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

    const missingImport = await fetch(`${baseUrl}/local/import?profile_id=default`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    });
    assert.equal(missingImport.status, 401);

    const ok = await fetch(`${baseUrl}/settings?profile_id=default`, { headers: { "x-liukong-local-token": token } });
    assert.equal(ok.status, 200);
    assert.equal((await ok.json()).memory_enabled, true);
  });
});

test("BYOK header is required and is passed only to chat gateway factory", async () => {
  const previousDeepSeek = process.env.DEEPSEEK_API_KEY;
  delete process.env.DEEPSEEK_API_KEY;
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
    if (previousDeepSeek === undefined) delete process.env.DEEPSEEK_API_KEY;
    else process.env.DEEPSEEK_API_KEY = previousDeepSeek;
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


test("server env DeepSeek key is accepted without browser BYOK header", async () => {
  const previous = process.env.DEEPSEEK_API_KEY;
  process.env.DEEPSEEK_API_KEY = "server-env-test-key";
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
    const ok = await fetch(`${baseUrl}/chat`, {
      method: "POST",
      headers: { "x-liukong-local-token": token, "content-type": "application/json" },
      body: JSON.stringify({ profile_id: "default", session_id: "s1", input: { type: "text", text: "hi" } }),
    });
    const body = await ok.json();
    assert.equal(ok.status, 200);
    assert.equal(seenKey, "server-env-test-key");
    assert.equal(JSON.stringify(body).includes("server-env-test-key"), false);

    seenKey = "";
    const stream = await fetch(`${baseUrl}/chat/stream`, {
      method: "POST",
      headers: { "x-liukong-local-token": token, "content-type": "application/json" },
      body: JSON.stringify({ profile_id: "default", session_id: "s1", input: { type: "text", text: "hi" } }),
    });
    const streamBody = await stream.text();
    assert.equal(stream.status, 200);
    assert.equal(seenKey, "server-env-test-key");
    assert.match(streamBody, /event: done/);
    assert.equal(streamBody.includes("server-env-test-key"), false);
    assert.equal(JSON.stringify(stateStore.auditEntries()).includes("server-env-test-key"), false);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
    stateStore.close();
    if (previous === undefined) delete process.env.DEEPSEEK_API_KEY;
    else process.env.DEEPSEEK_API_KEY = previous;
  }
});

test("provider header selects OpenAI gateway without persisting BYOK key", async () => {
  const token = "local-test-token";
  const stateStore = new SqliteStateStore(":memory:");
  let seenKey = "";
  let seenProvider = "";
  const server = createApiServer({
    stateStore,
    localToken: token,
    requireLocalToken: true,
    gatewayFactory: (apiKey, selection) => {
      seenKey = apiKey;
      seenProvider = selection?.providerName ?? "";
      return new AgentGateway({ provider: new FakeProvider(), modelProviderName: selection?.providerName });
    },
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.equal(typeof address, "object");
  const baseUrl = `http://127.0.0.1:${address!.port}`;
  try {
    const ok = await fetch(`${baseUrl}/chat`, {
      method: "POST",
      headers: { "x-liukong-local-token": token, "x-liukong-provider": "openai", "x-liukong-api-key": "openai-byok-test-key", "content-type": "application/json" },
      body: JSON.stringify({ profile_id: "default", session_id: "s1", input: { type: "text", text: "hi" } }),
    });
    assert.equal(ok.status, 200);
    assert.equal(seenKey, "openai-byok-test-key");
    assert.equal(seenProvider, "openai");
    assert.equal(JSON.stringify(await ok.json()).includes("openai-byok-test-key"), false);
    assert.equal(JSON.stringify(stateStore.auditEntries()).includes("openai-byok-test-key"), false);

    seenProvider = "";
    const stream = await fetch(`${baseUrl}/chat/stream`, {
      method: "POST",
      headers: { "x-liukong-local-token": token, "x-liukong-provider": "openai", "x-liukong-api-key": "openai-byok-test-key", "content-type": "application/json" },
      body: JSON.stringify({ profile_id: "default", session_id: "s1", input: { type: "text", text: "hi" } }),
    });
    assert.equal(stream.status, 200);
    assert.equal(seenProvider, "openai");
    assert.match(await stream.text(), /event: done/);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
    stateStore.close();
  }
});

test("server env OpenAI key is accepted when provider env selects openai", async () => {
  const previousProvider = process.env.LIUKONG_PROVIDER;
  const previousOpenAI = process.env.OPENAI_API_KEY;
  process.env.LIUKONG_PROVIDER = "openai";
  process.env.OPENAI_API_KEY = "server-openai-env-test-key";
  const token = "local-test-token";
  let seenKey = "";
  let seenProvider = "";
  const server = createApiServer({
    localToken: token,
    requireLocalToken: true,
    gatewayFactory: (apiKey, selection) => {
      seenKey = apiKey;
      seenProvider = selection?.providerName ?? "";
      return new AgentGateway({ provider: new FakeProvider(), modelProviderName: selection?.providerName });
    },
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.equal(typeof address, "object");
  const baseUrl = `http://127.0.0.1:${address!.port}`;
  try {
    const ok = await fetch(`${baseUrl}/chat`, {
      method: "POST",
      headers: { "x-liukong-local-token": token, "content-type": "application/json" },
      body: JSON.stringify({ profile_id: "default", session_id: "s1", input: { type: "text", text: "hi" } }),
    });
    assert.equal(ok.status, 200);
    assert.equal(seenKey, "server-openai-env-test-key");
    assert.equal(seenProvider, "openai");
    assert.equal(JSON.stringify(await ok.json()).includes("server-openai-env-test-key"), false);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
    if (previousProvider === undefined) delete process.env.LIUKONG_PROVIDER;
    else process.env.LIUKONG_PROVIDER = previousProvider;
    if (previousOpenAI === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = previousOpenAI;
  }
});

test("provider header selects local Ollama without requiring api key", async () => {
  const token = "local-test-token";
  const stateStore = new SqliteStateStore(":memory:");
  const provider = new FakeProvider();
  let seenKey = "unset";
  let seenProvider = "";
  let seenModelOverride = "";
  const server = createApiServer({
    stateStore,
    localToken: token,
    requireLocalToken: true,
    gatewayFactory: (apiKey, selection) => {
      seenKey = apiKey;
      seenProvider = selection?.providerName ?? "";
      seenModelOverride = selection?.modelOverride ?? "";
      return new AgentGateway({ provider, modelProviderName: selection?.providerName, modelOverride: selection?.modelOverride });
    },
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.equal(typeof address, "object");
  const baseUrl = `http://127.0.0.1:${address!.port}`;
  try {
    const ok = await fetch(`${baseUrl}/chat`, {
      method: "POST",
      headers: { "x-liukong-local-token": token, "x-liukong-provider": "ollama", "x-liukong-model": "llama3.2", "content-type": "application/json" },
      body: JSON.stringify({ profile_id: "default", session_id: "s1", input: { type: "text", text: "hi" } }),
    });
    assert.equal(ok.status, 200);
    assert.equal(seenKey, "");
    assert.equal(seenProvider, "ollama");
    assert.equal(seenModelOverride, "llama3.2");
    assert.equal(provider.lastRequest?.model, "llama3.2");
    assert.equal(JSON.stringify(await ok.json()).includes("api_key"), false);
    assert.equal(JSON.stringify(stateStore.auditEntries()).includes("api_key"), false);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
    stateStore.close();
  }
});

test("invalid ollama model override returns bad_request", async () => {
  const token = "local-test-token";
  const server = createApiServer({
    localToken: token,
    requireLocalToken: true,
    gatewayFactory: () => new AgentGateway({ provider: new FakeProvider() }),
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.equal(typeof address, "object");
  const baseUrl = `http://127.0.0.1:${address!.port}`;
  try {
    const response = await fetch(`${baseUrl}/chat`, {
      method: "POST",
      headers: { "x-liukong-local-token": token, "x-liukong-provider": "ollama", "x-liukong-model": "bad model with spaces", "content-type": "application/json" },
      body: JSON.stringify({ profile_id: "default", session_id: "s1", input: { type: "text", text: "hi" } }),
    });
    assert.equal(response.status, 400);
    assert.deepEqual(await response.json(), { error: "bad_request" });
  } finally {
    await new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
  }
});

test("invalid provider header returns bad_provider", async () => {
  const token = "local-test-token";
  const server = createApiServer({
    localToken: token,
    requireLocalToken: true,
    gatewayFactory: () => new AgentGateway({ provider: new FakeProvider() }),
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.equal(typeof address, "object");
  const baseUrl = `http://127.0.0.1:${address!.port}`;
  try {
    const response = await fetch(`${baseUrl}/chat`, {
      method: "POST",
      headers: { "x-liukong-local-token": token, "x-liukong-provider": "anthropic", "x-liukong-api-key": "test-key", "content-type": "application/json" },
      body: JSON.stringify({ profile_id: "default", session_id: "s1", input: { type: "text", text: "hi" } }),
    });
    assert.equal(response.status, 400);
    assert.deepEqual(await response.json(), { error: "bad_provider" });
  } finally {
    await new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
  }
});
