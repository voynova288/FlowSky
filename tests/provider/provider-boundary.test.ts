import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";

test("test_no_deepseek_import_outside_provider", () => {
  const files = execFileSync("find", ["packages", "apps", "-type", "f", "-name", "*.ts"], { encoding: "utf8" })
    .split("\n")
    .filter(Boolean);
  const offenders = files.filter((file) => {
    if (file.includes("packages/agent-gateway/src/providers/")) return false;
    const text = readFileSync(file, "utf8");
    return /api\.deepseek\.com|DeepSeekProvider/.test(text);
  });
  assert.deepEqual(offenders, []);
});
