import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { browserCandidates, desktopProfileDir, desktopUrl, healthUrl } from "../../scripts/desktop-launcher.mjs";
import { desktopEntry, desktopFileTargets, installDesktopLauncher, launcherScript, shellQuote } from "../../scripts/install-desktop-launcher.mjs";

test("desktop launcher builds local-only URLs and browser app candidates", () => {
  const env = { LIUKONG_PORT: "3456", LIUKONG_HOST: "127.0.0.1", HOST: "0.0.0.0", LIUKONG_DATA_DIR: "/tmp/liukong-data" };
  assert.equal(desktopUrl(env), "http://127.0.0.1:3456/");
  assert.equal(healthUrl(env), "http://127.0.0.1:3456/health");
  assert.equal(desktopProfileDir(env), "/tmp/liukong-data/desktop-browser-profile");
  assert.ok(browserCandidates().length > 0);
  assert.deepEqual(browserCandidates({ LIUKONG_DESKTOP_BROWSER: "custom-browser" }), ["custom-browser"]);
});

test("desktop installer writes launcher, icon, and desktop entry", () => {
  const home = mkdtempSync(join(tmpdir(), "liukong-desktop-home-"));
  const repo = mkdtempSync(join(tmpdir(), "流空 desktop repo-"));
  try {
    writeFileSync(join(repo, "dummy"), "");
    const iconDir = join(repo, "apps", "desktop");
    const scriptsDir = join(repo, "scripts");
    mkdirSync(iconDir, { recursive: true });
    mkdirSync(scriptsDir, { recursive: true });
    writeFileSync(join(iconDir, "liukong.svg"), "<svg/>");
    writeFileSync(join(scriptsDir, "desktop-launcher.mjs"), "");

    const result = installDesktopLauncher({ home, repo, nodePath: "/usr/bin/node" });
    assert.equal(result.desktopFiles[0], join(home, ".local/share/applications/liukong.desktop"));
    assert.match(readFileSync(result.launcherPath, "utf8"), /desktop-launcher\.mjs/);
    assert.match(readFileSync(result.desktopFiles[0], "utf8"), /Name=流空 Liukong/);
    assert.equal(readFileSync(result.iconPath, "utf8"), "<svg/>");
  } finally {
    rmSync(home, { recursive: true, force: true });
    rmSync(repo, { recursive: true, force: true });
  }
});

test("desktop entry and shell launcher avoid secrets and quote unicode paths", () => {
  assert.equal(shellQuote("/tmp/流空 repo"), "'/tmp/流空 repo'");
  const launcher = launcherScript({ repo: "/tmp/流空 repo", nodePath: "/usr/bin/node" });
  assert.match(launcher, /cd '\/tmp\/流空 repo'/);
  assert.doesNotMatch(launcher, /API_KEY|TOKEN|sk-/i);

  const entry = desktopEntry({ execPath: "/home/user/.local/bin/liukong-desktop" });
  assert.match(entry, /Type=Application/);
  assert.match(entry, /Exec=\/home\/user\/\.local\/bin\/liukong-desktop/);
  assert.match(entry, /Icon=liukong/);
  assert.doesNotMatch(entry, /API_KEY|TOKEN|sk-/i);
  assert.deepEqual(desktopFileTargets("/tmp/home-no-desktop"), ["/tmp/home-no-desktop/.local/share/applications/liukong.desktop"]);
});
