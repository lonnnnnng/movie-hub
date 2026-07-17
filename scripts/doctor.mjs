import { access, mkdir, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import path from "node:path";

const root = process.cwd();
const require = createRequire(import.meta.url);
const apiPort = readPort("PORT", 8787);
const webPort = readPort("WEB_PORT", 5173);
const requiredFiles = [
  "package.json",
  "index.html",
  "src/App.tsx",
  "src/main.tsx",
  "src/styles.css",
  "server/index.ts",
  "server/store.ts",
  "server/cms.ts",
  "server/downloader.ts",
  "server/library.ts"
];

const requiredDirs = ["media", "server/data", "var"];
const failures = [];
const warnings = [];

function readPort(name, fallback) {
  const value = Number(process.env[name]);
  if (Number.isInteger(value) && value > 0 && value <= 65535) return value;
  return fallback;
}

async function exists(relativePath) {
  try {
    await access(path.join(root, relativePath));
    return true;
  } catch {
    return false;
  }
}

function checkNodeRuntime() {
  const [major, minor] = process.versions.node.split(".").map((part) => Number(part));
  const supportedNode =
    (major === 20 && minor >= 19) ||
    (major === 22 && minor >= 12) ||
    major > 22;
  if (!Number.isInteger(major) || !Number.isInteger(minor) || !supportedNode) {
    failures.push(`Node.js ${process.version} is unsupported. Use Node.js 20.19+ or 22.12+.`);
  }

  try {
    require("better-sqlite3");
    console.log(`node: ${process.version}, platform ${process.platform}/${process.arch}, better-sqlite3 ok`);
  } catch (error) {
    failures.push(`better-sqlite3 is unavailable: ${error.message}. Run npm install on this platform.`);
  }

  const npmCommand =
    process.platform === "win32"
      ? {
          command: process.env.ComSpec ?? "cmd.exe",
          args: ["/d", "/s", "/c", "npm --version"]
        }
      : {
          command: "npm",
          args: ["--version"]
        };
  const npm = spawnSync(npmCommand.command, npmCommand.args, { cwd: root, encoding: "utf8", windowsHide: true });
  if (npm.error || npm.status !== 0) {
    failures.push(`npm is unavailable: ${npm.error?.message ?? npm.stderr?.trim() ?? "unknown error"}`);
  } else {
    console.log(`npm: ${npm.stdout.trim()}`);
  }
}

async function checkRequiredPaths() {
  for (const file of requiredFiles) {
    if (!(await exists(file))) failures.push(`Missing file: ${file}`);
  }

  for (const dir of requiredDirs) {
    if (!(await exists(dir))) failures.push(`Missing directory: ${dir}`);
  }
}

async function checkWritableDirs() {
  for (const dir of requiredDirs) {
    const absolute = path.join(root, dir);
    try {
      await mkdir(absolute, { recursive: true });
      const file = path.join(absolute, ".movie-hub-write-test");
      await writeFile(file, "ok");
      await rm(file, { force: true });
    } catch (error) {
      failures.push(`Directory is not writable: ${dir} (${error.message})`);
    }
  }
}

async function checkStore() {
  if (!(await exists("server/data/movie-hub.sqlite"))) {
    console.log("store: sqlite database not created yet");
    return;
  }

  try {
    const Database = require("better-sqlite3");
    const db = new Database(path.join(root, "server/data/movie-hub.sqlite"), { readonly: true, fileMustExist: true });
    const settings = db.prepare("SELECT COUNT(*) AS count FROM app_settings").get().count;
    const sites = db.prepare("SELECT COUNT(*) AS count FROM app_items WHERE bucket = 'sites'").get().count;
    const trending = db.prepare("SELECT COUNT(*) AS count FROM app_items WHERE bucket = 'trendingCache'").get().count;
    const downloads = db.prepare("SELECT COUNT(*) AS count FROM app_items WHERE bucket = 'downloads'").get().count;
    const health = db.prepare("SELECT COUNT(*) AS count FROM source_health").get().count;
    db.close();
    console.log(`store: sqlite ok, ${settings} settings row, ${sites} sites, ${trending} trending items, ${downloads} downloads, ${health} health rows`);
  } catch (error) {
    failures.push(`Invalid server/data/movie-hub.sqlite: ${error.message}`);
  }
}

async function checkApi() {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 2500);

  try {
    const response = await fetch(`http://localhost:${apiPort}/api/stats`, { signal: controller.signal });
    if (!response.ok) {
      console.log(`api: reachable but returned HTTP ${response.status}`);
      return;
    }

    const stats = await response.json();
    console.log(
      `api: ${stats.enabledSites}/${stats.sites} sources enabled, ${stats.library} local videos, ${stats.unreadNotifications} unread notices`
    );
  } catch {
    console.log(`api: not running on http://localhost:${apiPort}`);
  } finally {
    clearTimeout(timer);
  }
}

async function checkWeb() {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 2500);
  try {
    const response = await fetch(`http://localhost:${webPort}`, { signal: controller.signal });
    console.log(response.ok ? `web: reachable on http://localhost:${webPort}` : `web: HTTP ${response.status} on http://localhost:${webPort}`);
  } catch {
    console.log(`web: not running on http://localhost:${webPort}`);
  } finally {
    clearTimeout(timer);
  }
}

async function checkTools() {
  await checkTool("ffmpeg", [process.env.FFMPEG_PATH, ...localToolCandidates("ffmpeg"), "ffmpeg"], ["-version"]);
  await checkTool("ffprobe", [process.env.FFPROBE_PATH, ...localToolCandidates("ffprobe"), "ffprobe"], ["-version"]);
  await checkTool(
    "N_m3u8DL-RE",
    [
      process.env.N_M3U8DL_RE_PATH,
      process.env.N_M3U8DL_PATH,
      ...localToolCandidates("N_m3u8DL-RE"),
      ...localToolCandidates("n-m3u8dl-re"),
      "N_m3u8DL-RE",
      "n-m3u8dl-re"
    ],
    ["--version"],
    ["--help"]
  );
}

function candidateNames(baseName) {
  if (process.platform === "win32") return [baseName, `${baseName}.exe`, `${baseName}.cmd`, `${baseName}.bat`];
  return [baseName, `${baseName}.exe`];
}

function localToolCandidates(baseName) {
  const dirs = [path.resolve("tools", "ffmpeg", "bin"), path.resolve("tools", "bin"), path.resolve("tools"), path.resolve("server", "bin")];
  return dirs.flatMap((dir) => candidateNames(baseName).map((name) => path.join(dir, name)));
}

async function checkTool(label, candidates, primaryArgs, fallbackArgs) {
  const commands = [...new Set(candidates.filter(Boolean).map((value) => String(value).trim()).filter(Boolean))];
  for (const command of commands) {
    if (path.isAbsolute(command) && !existsSync(command)) continue;
    if (await commandWorks(command, primaryArgs)) {
      console.log(`${label}: ok (${command})`);
      return;
    }
    if (fallbackArgs && (await commandWorks(command, fallbackArgs))) {
      console.log(`${label}: ok (${command})`);
      return;
    }
  }
  warnings.push(`${label} not detected. Put it in tools/, add it to PATH, or configure the path in system settings.`);
  console.log(`${label}: missing`);
}

function commandWorks(command, args) {
  return new Promise((resolve) => {
    const child = spawnSync(command, args, {
      cwd: root,
      stdio: "ignore",
      timeout: 5000,
      windowsHide: true
    });
    resolve(!child.error && child.status === 0);
  });
}

checkNodeRuntime();
await checkRequiredPaths();
await checkWritableDirs();
await checkStore();
await checkApi();
await checkWeb();
await checkTools();

if (warnings.length) {
  console.warn("\nDoctor warnings:");
  for (const warning of warnings) console.warn(`- ${warning}`);
}

if (failures.length) {
  console.error("\nDoctor found problems:");
  for (const failure of failures) console.error(`- ${failure}`);
  process.exitCode = 1;
} else {
  console.log("doctor: ok");
}
