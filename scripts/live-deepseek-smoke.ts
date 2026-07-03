#!/usr/bin/env node
import { existsSync, readFileSync } from "node:fs";
import { DeepSeekProvider } from "../packages/agent-gateway/src/providers/DeepSeekProvider.ts";
import { modelConfigForMode } from "../packages/agent-gateway/src/providers/model-config.ts";

if (!process.env.DEEPSEEK_API_KEY && existsSync("API.txt")) {
  process.env.DEEPSEEK_API_KEY = readFileSync("API.txt", "utf8").trim();
}

if (!process.env.DEEPSEEK_API_KEY) {
  console.error("DEEPSEEK_API_KEY is required. Export it or provide local API.txt (gitignored). ");
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
