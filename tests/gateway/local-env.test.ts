import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { loadLocalEnv } from "../../apps/api/src/localEnv.ts";

function withTempDir<T>(fn: (dir: string) => T): T {
  const dir = mkdtempSync(join(tmpdir(), "liukong-env-"));
  try {
    return fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function withoutDeepSeekEnv<T>(fn: () => T): T {
  const previous = process.env.DEEPSEEK_API_KEY;
  try {
    delete process.env.DEEPSEEK_API_KEY;
    return fn();
  } finally {
    if (previous === undefined) delete process.env.DEEPSEEK_API_KEY;
    else process.env.DEEPSEEK_API_KEY = previous;
  }
}

test("local env loads raw API.txt as local DeepSeek key", () => {
  withoutDeepSeekEnv(() => withTempDir((dir) => {
    writeFileSync(join(dir, "API.txt"), "local-api-key-from-file\n");
    loadLocalEnv(dir);
    assert.equal(process.env.DEEPSEEK_API_KEY, "local-api-key-from-file");
  }));
});

test("local env keeps .env.local priority over API.txt", () => {
  withoutDeepSeekEnv(() => withTempDir((dir) => {
    writeFileSync(join(dir, ".env.local"), "DEEPSEEK_API_KEY=env-local-key\n");
    writeFileSync(join(dir, "API.txt"), "api-txt-key\n");
    loadLocalEnv(dir);
    assert.equal(process.env.DEEPSEEK_API_KEY, "env-local-key");
  }));
});
