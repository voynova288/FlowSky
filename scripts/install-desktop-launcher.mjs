#!/usr/bin/env node
import { chmodSync, copyFileSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(scriptDir, "..");

export function shellQuote(value) {
  return `'${String(value).replace(/'/g, `'\\''`)}'`;
}

export function launcherScript({ repo = repoRoot, nodePath = process.execPath } = {}) {
  return `#!/usr/bin/env sh
set -eu
cd ${shellQuote(repo)}
exec ${shellQuote(nodePath)} ${shellQuote(resolve(repo, "scripts/desktop-launcher.mjs"))} "$@"
`;
}

export function desktopEntry({ execPath, iconName = "liukong" }) {
  return `[Desktop Entry]
Type=Application
Name=流空 Liukong
GenericName=Local AI Companion
Comment=Local-first BYOK AI companion running on localhost
Exec=${execPath}
Icon=${iconName}
Terminal=false
Categories=Utility;Chat;
StartupNotify=true
StartupWMClass=Liukong
`;
}

export function desktopFileTargets(home = homedir()) {
  const targets = [resolve(home, ".local/share/applications/liukong.desktop")];
  for (const desktopDir of [resolve(home, "Desktop"), resolve(home, "桌面")]) {
    if (existsSync(desktopDir)) targets.push(resolve(desktopDir, "liukong.desktop"));
  }
  return targets;
}

export function installDesktopLauncher({ home = homedir(), repo = repoRoot, nodePath = process.execPath } = {}) {
  const binDir = resolve(home, ".local/bin");
  const iconDir = resolve(home, ".local/share/icons/hicolor/scalable/apps");
  const launcherPath = resolve(binDir, "liukong-desktop");
  const iconPath = resolve(iconDir, "liukong.svg");

  mkdirSync(binDir, { recursive: true, mode: 0o755 });
  mkdirSync(iconDir, { recursive: true, mode: 0o755 });
  writeFileSync(launcherPath, launcherScript({ repo, nodePath }), { mode: 0o755 });
  chmodSync(launcherPath, 0o755);
  copyFileSync(resolve(repo, "apps/desktop/liukong.svg"), iconPath);

  const entry = desktopEntry({ execPath: launcherPath });
  const targets = desktopFileTargets(home);
  for (const target of targets) {
    mkdirSync(dirname(target), { recursive: true, mode: 0o755 });
    writeFileSync(target, entry, { mode: 0o755 });
    chmodSync(target, 0o755);
  }
  return { launcherPath, iconPath, desktopFiles: targets };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const result = installDesktopLauncher();
  console.log("Liukong desktop launcher installed:");
  console.log(`- command: ${result.launcherPath}`);
  console.log(`- icon: ${result.iconPath}`);
  for (const file of result.desktopFiles) console.log(`- desktop entry: ${file}`);
}
