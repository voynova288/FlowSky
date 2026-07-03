#!/usr/bin/env node
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { DeepSeekProvider } from "../packages/agent-gateway/src/providers/DeepSeekProvider.ts";
import { modelConfigForMode } from "../packages/agent-gateway/src/providers/model-config.ts";

loadEnvLocal();

if (!process.env.DEEPSEEK_API_KEY) {
  console.error("DEEPSEEK_API_KEY is required. Put it in .env.local or export it in this shell.");
  process.exit(1);
}

const provider = new DeepSeekProvider();
const normal = await provider.complete({
  ...modelConfigForMode("girlfriend_chat"),
  messages: [{ role: "user", content: "用中文回复两个字：你好" }],
});
console.log(JSON.stringify({ normal_ok: normal.text.length > 0, normal_text: normal.text.slice(0, 20), usage: normal.usage }, null, 2));

const json = await provider.complete({
  ...modelConfigForMode("memory_extraction"),
  messages: [
    { role: "system", content: 'Return json only: {"ok":true}. json' },
    { role: "user", content: "test" },
  ],
});
console.log(JSON.stringify({ json_ok: JSON.parse(json.text).ok === true }, null, 2));

let streamed = "";
let sawUsage = false;
for await (const chunk of provider.stream({
  ...modelConfigForMode("girlfriend_chat"),
  stream: true,
  messages: [{ role: "user", content: "用中文回复四个字：测试成功" }],
})) {
  streamed += chunk.delta ?? "";
  if (chunk.usage) sawUsage = true;
}
console.log(JSON.stringify({ stream_ok: streamed.length > 0, streamed: streamed.slice(0, 40), saw_usage: sawUsage }, null, 2));

function loadEnvLocal(): void {
  const path = resolve(process.cwd(), ".env.local");
  if (!existsSync(path)) return;
  for (const line of readFileSync(path, "utf8").split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq <= 0) continue;
    const key = trimmed.slice(0, eq).trim();
    const value = trimmed.slice(eq + 1).trim().replace(/^['"]|['"]$/g, "");
    if (!process.env[key]) process.env[key] = value;
  }
}
