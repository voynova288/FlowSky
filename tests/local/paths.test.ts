import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { defaultLocalDbPath, defaultLocalProfileId, SqliteStateStore } from "../../packages/agent-gateway/src/index.ts";

test("test_local_data_dir_created_and_sqlite_default_path", () => {
  const previous = process.env.LIUKONG_DATA_DIR;
  const dir = mkdtempSync(join(tmpdir(), "liukong-data-"));
  try {
    process.env.LIUKONG_DATA_DIR = dir;
    assert.equal(defaultLocalDbPath(), join(dir, "liukong.db"));
    const store = new SqliteStateStore();
    store.close();
  } finally {
    if (previous === undefined) delete process.env.LIUKONG_DATA_DIR;
    else process.env.LIUKONG_DATA_DIR = previous;
    rmSync(dir, { recursive: true, force: true });
  }
});

test("test_default_profile_created", () => {
  assert.equal(defaultLocalProfileId(), "default");
});
