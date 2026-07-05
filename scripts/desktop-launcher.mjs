#!/usr/bin/env node
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import { homedir, platform } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(scriptDir, "..");

export function desktopPort(env = process.env) {
  return Number(env.LIUKONG_PORT ?? env.PORT ?? 3000);
}

export function desktopHost(env = process.env) {
  return env.LIUKONG_HOST ?? "127.0.0.1";
}

export function desktopUrl(env = process.env) {
  return `http://127.0.0.1:${desktopPort(env)}/`;
}

export function healthUrl(env = process.env) {
  const host = desktopHost(env);
  const healthHost = host === "localhost" || host === "::1" ? "127.0.0.1" : host;
  return `http://${healthHost}:${desktopPort(env)}/health`;
}

export function browserCandidates(env = process.env) {
  if (env.LIUKONG_DESKTOP_BROWSER) return [env.LIUKONG_DESKTOP_BROWSER];
  if (platform() === "darwin") return ["/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", "/Applications/Chromium.app/Contents/MacOS/Chromium"];
  if (platform() === "win32") return ["msedge", "chrome", "chromium"];
  return ["google-chrome", "google-chrome-stable", "chromium", "chromium-browser", "brave-browser", "microsoft-edge", "vivaldi"];
}

export function commandExists(command) {
  if (command.includes("/")) return existsSync(command);
  const probe = platform() === "win32" ? "where" : "command";
  const args = platform() === "win32" ? [command] : ["-v", command];
  return spawnSync(probe, args, { stdio: "ignore", shell: platform() !== "win32" }).status === 0;
}

export function detectBrowser(env = process.env) {
  return browserCandidates(env).find(commandExists);
}

export function desktopProfileDir(env = process.env) {
  return resolve(env.LIUKONG_DATA_DIR?.replace(/^~(?=$|\/)/, homedir()) ?? resolve(homedir(), ".liukong"), "desktop-browser-profile");
}

export async function waitForHealth(url, timeoutMs = 15_000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    try {
      const response = await fetch(url);
      if (response.ok) return true;
    } catch {
      // Server is not ready yet.
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  return false;
}

export function startLocalServer(env = process.env) {
  return spawn(process.execPath, ["--experimental-strip-types", "apps/api/src/server.ts"], {
    cwd: repoRoot,
    env: {
      ...env,
      LIUKONG_HOST: desktopHost(env),
      LIUKONG_PORT: String(desktopPort(env)),
    },
    stdio: "inherit",
  });
}

export function launchAppWindow(url, env = process.env) {
  const browser = detectBrowser(env);
  if (browser) {
    const profileDir = desktopProfileDir(env);
    mkdirSync(profileDir, { recursive: true, mode: 0o700 });
    const args = [`--app=${url}`, `--user-data-dir=${profileDir}`, "--no-first-run", "--disable-features=Translate"];
    return spawn(browser, args, { stdio: "ignore", detached: false });
  }
  if (platform() === "darwin") return spawn("open", [url], { stdio: "ignore" });
  if (platform() === "win32") return spawn("cmd", ["/c", "start", "", url], { stdio: "ignore" });
  return spawn("xdg-open", [url], { stdio: "ignore" });
}

export async function runDesktopApp(env = process.env) {
  const url = desktopUrl(env);
  const health = healthUrl(env);
  let server;
  if (!(await waitForHealth(health, 750))) {
    server = startLocalServer(env);
    if (!(await waitForHealth(health))) {
      server.kill("SIGTERM");
      throw new Error(`Liukong local server did not become ready at ${health}`);
    }
  }

  const app = launchAppWindow(url, env);
  const keepServerAlive = env.LIUKONG_DESKTOP_KEEP_SERVER_ALIVE !== "false";
  const shutdown = () => {
    if (server && !server.killed) server.kill("SIGTERM");
  };
  process.once("SIGINT", () => { shutdown(); process.exit(0); });
  process.once("SIGTERM", () => { shutdown(); process.exit(0); });

  // Chrome/Edge on Linux often hands --app URLs to an existing browser process
  // and exits the spawned child immediately. Keep the local server alive by
  // default so the desktop window remains usable even when that handoff happens.
  if (server && keepServerAlive) await new Promise(() => {});
  await new Promise((resolve) => app.once("exit", resolve));
  shutdown();
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  runDesktopApp().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
}
