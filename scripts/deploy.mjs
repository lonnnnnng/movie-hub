#!/usr/bin/env node
import {
  chmodSync,
  copyFileSync,
  createWriteStream,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync
} from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { fileURLToPath } from "node:url";

const defaultRepo = "https://github.com/lonnnnnng/movie-hub.git";
const defaultBranch = "main";
const gitCommand = process.env.GIT || "git";
const npmCommand = process.env.NPM || "npm";
const ffmpegReleaseApi = "https://api.github.com/repos/BtbN/FFmpeg-Builds/releases/latest";
const nm3u8ReleaseApi = "https://api.github.com/repos/nilaoda/N_m3u8DL-RE/releases/latest";
const macFfmpegFallback = {
  ffmpeg: "https://evermeet.cx/ffmpeg/getrelease/zip",
  ffprobe: "https://evermeet.cx/ffmpeg/getrelease/ffprobe/zip"
};

const options = parseArgs(process.argv.slice(2));
const deployEnv = {
  ...process.env,
  PORT: String(options.port),
  WEB_PORT: String(options.webPort)
};

main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`\nDeploy failed: ${message}`);
  process.exitCode = 1;
});

async function main() {
  if (options.help) {
    printHelp();
    return;
  }

  checkNodeVersion();
  ensureCommand(gitCommand, ["--version"], "git");
  ensureCommand(npmCommand, ["--version"], "npm");

  console.log("Movie Hub deploy");
  console.log(`Repository: ${options.repo}`);
  console.log(`Branch: ${options.branch}`);
  console.log(`Target: ${options.dir}`);
  console.log(`Ports: API ${options.port}, Web ${options.webPort}`);

  ensureRepository();
  ensureRuntimeDirs();
  await ensureExternalTools();
  installDependencies();

  if (!options.skipVerify) {
    run(npmCommand, ["run", "verify"], { cwd: options.dir, env: deployEnv });
  } else {
    console.log("Skipping verify step.");
  }

  if (!options.skipStart) {
    run(npmCommand, ["run", "service:restart"], { cwd: options.dir, env: deployEnv });
    await waitForApplication();
    run(npmCommand, ["run", "service:status"], { cwd: options.dir, env: deployEnv });
  } else {
    console.log("Skipping service start.");
  }

  console.log("\nDeploy complete.");
  console.log(`Web: http://localhost:${options.webPort}`);
  console.log(`API: http://localhost:${options.port}`);
  console.log("Use the service script for later maintenance:");
  console.log("  npm run service:status");
  console.log("  npm run service:logs -- --lines 200");
}

function parseArgs(args) {
  const parsed = {
    repo: process.env.MOVIE_HUB_REPO || defaultRepo,
    branch: process.env.MOVIE_HUB_BRANCH || defaultBranch,
    dir: process.env.MOVIE_HUB_DIR || defaultDeployDir(),
    port: readPort("PORT", 8787),
    webPort: readPort("WEB_PORT", 5173),
    timeoutSeconds: readPositiveInt(process.env.MOVIE_HUB_DEPLOY_TIMEOUT, 90),
    skipPull: false,
    skipVerify: false,
    skipStart: false,
    help: false
  };

  for (let index = 0; index < args.length; index += 1) {
    const value = args[index];
    const next = () => {
      const found = args[index + 1];
      if (!found || found.startsWith("--")) throw new Error(`Missing value for ${value}`);
      index += 1;
      return found;
    };

    if (value === "--help" || value === "-h") parsed.help = true;
    else if (value === "--repo") parsed.repo = next();
    else if (value === "--branch") parsed.branch = next();
    else if (value === "--dir") parsed.dir = next();
    else if (value === "--port") parsed.port = parsePort(next(), "--port");
    else if (value === "--web-port") parsed.webPort = parsePort(next(), "--web-port");
    else if (value === "--timeout") parsed.timeoutSeconds = readPositiveInt(next(), 90);
    else if (value === "--skip-pull" || value === "--no-pull") parsed.skipPull = true;
    else if (value === "--skip-tools") parsed.skipTools = true;
    else if (value === "--skip-verify") parsed.skipVerify = true;
    else if (value === "--skip-start") parsed.skipStart = true;
    else throw new Error(`Unknown option: ${value}`);
  }

  parsed.dir = path.resolve(parsed.dir);
  return parsed;
}

function defaultDeployDir() {
  return isMovieHubRepo(process.cwd()) ? process.cwd() : path.resolve(process.cwd(), "movie-hub");
}

function isMovieHubRepo(dir) {
  try {
    const packageJson = JSON.parse(readFileSync(path.join(dir, "package.json"), "utf8"));
    return packageJson?.name === "movie-hub";
  } catch {
    return false;
  }
}

function readPort(name, fallback) {
  const value = Number(process.env[name]);
  if (Number.isInteger(value) && value > 0 && value <= 65535) return value;
  return fallback;
}

function parsePort(value, label) {
  const port = Number(value);
  if (!Number.isInteger(port) || port <= 0 || port > 65535) throw new Error(`${label} must be a valid TCP port.`);
  return port;
}

function readPositiveInt(value, fallback) {
  const number = Number(value);
  return Number.isInteger(number) && number > 0 ? number : fallback;
}

function checkNodeVersion() {
  const [major, minor] = process.versions.node.split(".").map((part) => Number(part));
  const supported = (major === 20 && minor >= 19) || (major === 22 && minor >= 12) || major > 22;
  if (!supported) throw new Error(`Node.js ${process.version} is unsupported. Use Node.js 20.19+ or 22.12+.`);
}

function ensureCommand(command, args, label) {
  const invocation = commandInvocation(command, args);
  const result = spawnSync(invocation.command, invocation.args, {
    cwd: process.cwd(),
    stdio: "ignore",
    windowsHide: true
  });
  if (result.error || result.status !== 0) {
    throw new Error(`${label} is not available. Install ${label} and try again.`);
  }
}

function ensureRepository() {
  if (!existsSync(options.dir)) {
    mkdirSync(path.dirname(options.dir), { recursive: true });
    run(gitCommand, ["clone", "--branch", options.branch, "--single-branch", options.repo, options.dir], { cwd: process.cwd() });
    return;
  }

  if (isEmptyDirectory(options.dir)) {
    run(gitCommand, ["clone", "--branch", options.branch, "--single-branch", options.repo, options.dir], { cwd: process.cwd() });
    return;
  }

  if (!isGitRepository(options.dir)) {
    throw new Error(`${options.dir} exists but is not a git repository.`);
  }

  if (options.skipPull) {
    console.log("Skipping git pull.");
    return;
  }

  const dirty = capture(gitCommand, ["status", "--porcelain"], { cwd: options.dir }).stdout.trim();
  if (dirty) {
    throw new Error(`Working tree is not clean in ${options.dir}. Commit/stash changes, or rerun with --skip-pull.`);
  }

  run(gitCommand, ["fetch", "--prune", "origin", options.branch], { cwd: options.dir });
  checkoutBranch();
  run(gitCommand, ["pull", "--ff-only", "origin", options.branch], { cwd: options.dir });
}

function isEmptyDirectory(dir) {
  try {
    return readdirSync(dir).length === 0;
  } catch {
    return false;
  }
}

function isGitRepository(dir) {
  const result = spawnSync(gitCommand, ["rev-parse", "--is-inside-work-tree"], {
    cwd: dir,
    encoding: "utf8",
    windowsHide: true
  });
  return !result.error && result.status === 0 && result.stdout.trim() === "true";
}

function checkoutBranch() {
  const hasLocalBranch = spawnSync(gitCommand, ["rev-parse", "--verify", options.branch], {
    cwd: options.dir,
    stdio: "ignore",
    windowsHide: true
  });
  if (hasLocalBranch.status === 0) {
    run(gitCommand, ["checkout", options.branch], { cwd: options.dir });
    return;
  }
  run(gitCommand, ["checkout", "-B", options.branch, `origin/${options.branch}`], { cwd: options.dir });
}

function ensureRuntimeDirs() {
  for (const relativePath of ["media", "server/data", "var", "tools"]) {
    mkdirSync(path.join(options.dir, relativePath), { recursive: true });
  }
}

async function ensureExternalTools() {
  if (options.skipTools) {
    console.log("Skipping external tool download.");
    return;
  }

  await ensureFfmpegTools();
  await ensureNm3u8DlReTool();
}

async function ensureFfmpegTools() {
  const ffmpegPath = toolPath("ffmpeg", "tools", "ffmpeg", "bin");
  const ffprobePath = toolPath("ffprobe", "tools", "ffmpeg", "bin");
  if (existsSync(ffmpegPath) && existsSync(ffprobePath)) {
    console.log("ffmpeg tools already exist.");
    return;
  }

  if (process.platform === "darwin") {
    await installMacFfmpegTools();
    return;
  }

  const asset = await findGithubReleaseAsset(ffmpegReleaseApi, ffmpegAssetMatcher());
  if (!asset) {
    throw new Error("Cannot find a matching FFmpeg-Builds release asset for this platform.");
  }

  const archive = await downloadToTemp(asset.browser_download_url, asset.name);
  const extracted = extractArchive(archive);
  installFfmpegFromDir(extracted);
}

async function installMacFfmpegTools() {
  const binDir = path.join(options.dir, "tools", "ffmpeg", "bin");
  mkdirSync(binDir, { recursive: true });

  if (!existsSync(toolPath("ffmpeg", "tools", "ffmpeg", "bin"))) {
    const archive = await downloadToTemp(macFfmpegFallback.ffmpeg, "ffmpeg-macos.zip");
    const extracted = extractArchive(archive);
    installSingleToolFromDir(extracted, "ffmpeg", binDir);
  }

  if (!existsSync(toolPath("ffprobe", "tools", "ffmpeg", "bin"))) {
    const archive = await downloadToTemp(macFfmpegFallback.ffprobe, "ffprobe-macos.zip");
    const extracted = extractArchive(archive);
    installSingleToolFromDir(extracted, "ffprobe", binDir);
  }
}

async function ensureNm3u8DlReTool() {
  const nm3u8Path = toolPath("N_m3u8DL-RE", "tools");
  if (existsSync(nm3u8Path)) {
    console.log("N_m3u8DL-RE already exists.");
    return;
  }

  const asset = await findGithubReleaseAsset(nm3u8ReleaseApi, nm3u8AssetMatcher());
  if (!asset) {
    throw new Error("Cannot find a matching N_m3u8DL-RE release asset for this platform.");
  }

  const archive = await downloadToTemp(asset.browser_download_url, asset.name);
  const extracted = extractArchive(archive);
  installSingleToolFromDir(extracted, "N_m3u8DL-RE", path.join(options.dir, "tools"), ["n-m3u8dl-re"]);
}

function toolPath(baseName, ...segments) {
  const extension = process.platform === "win32" ? ".exe" : "";
  return path.join(options.dir, ...segments, `${baseName}${extension}`);
}

function ffmpegAssetMatcher() {
  if (process.platform === "win32") {
    return (asset) => {
      const name = asset.name.toLowerCase();
      return name.endsWith(".zip") && name.includes("win64") && name.includes("gpl") && !name.includes("shared") && !name.includes("symbols");
    };
  }
  if (process.platform === "linux") {
    const arch = process.arch === "arm64" ? "linuxarm64" : "linux64";
    return (asset) => {
      const name = asset.name.toLowerCase();
      return (name.endsWith(".tar.xz") || name.endsWith(".zip")) && name.includes(arch) && name.includes("gpl") && !name.includes("shared") && !name.includes("symbols");
    };
  }
  return () => false;
}

function nm3u8AssetMatcher() {
  return (asset) => {
    const name = asset.name.toLowerCase();
    if (!/\.(zip|tar\.gz|tgz)$/.test(name)) return false;
    if (process.platform === "win32") return name.includes("win") && name.includes("x64");
    if (process.platform === "darwin") return name.includes("osx") || name.includes("mac") || name.includes("darwin");
    if (process.platform === "linux") return name.includes("linux") && (process.arch === "arm64" ? name.includes("arm64") : name.includes("x64"));
    return false;
  };
}

async function findGithubReleaseAsset(apiUrl, matcher) {
  console.log(`Checking release assets: ${apiUrl}`);
  const release = await fetchJson(apiUrl);
  const assets = Array.isArray(release.assets) ? release.assets : [];
  return assets.find(matcher);
}

async function fetchJson(url) {
  const response = await fetch(url, {
    headers: {
      "user-agent": "MovieHubDeploy/0.1"
    }
  });
  if (!response.ok) throw new Error(`Failed to fetch ${url}: HTTP ${response.status}`);
  return response.json();
}

async function downloadToTemp(url, fileName) {
  const tempDir = mkdtempSync(path.join(tmpdir(), "movie-hub-tools-"));
  const filePath = path.join(tempDir, fileName.replace(/[\\/]/g, "-"));
  console.log(`Downloading ${url}`);
  const response = await fetch(url, {
    headers: {
      "user-agent": "MovieHubDeploy/0.1"
    }
  });
  if (!response.ok || !response.body) throw new Error(`Failed to download ${url}: HTTP ${response.status}`);
  await pipeline(Readable.fromWeb(response.body), createWriteStream(filePath));
  return filePath;
}

function extractArchive(archivePath) {
  const outputDir = `${archivePath}-extracted`;
  mkdirSync(outputDir, { recursive: true });
  const lower = archivePath.toLowerCase();
  if (lower.endsWith(".zip")) {
    extractZip(archivePath, outputDir);
  } else if (lower.endsWith(".tar.xz") || lower.endsWith(".tar.gz") || lower.endsWith(".tgz")) {
    runTarExtract(archivePath, outputDir);
  } else {
    throw new Error(`Unsupported archive type: ${archivePath}`);
  }
  return outputDir;
}

function extractZip(archivePath, outputDir) {
  if (process.platform === "win32") {
    run("powershell", [
      "-NoProfile",
      "-ExecutionPolicy",
      "Bypass",
      "-Command",
      "Expand-Archive -LiteralPath $env:MOVIE_HUB_ARCHIVE -DestinationPath $env:MOVIE_HUB_EXTRACT_DIR -Force"
    ], {
      env: {
        ...process.env,
        MOVIE_HUB_ARCHIVE: archivePath,
        MOVIE_HUB_EXTRACT_DIR: outputDir
      }
    });
    return;
  }
  run("unzip", ["-q", archivePath, "-d", outputDir]);
}

function runTarExtract(archivePath, outputDir) {
  run("tar", ["-xf", archivePath, "-C", outputDir]);
}

function installFfmpegFromDir(sourceDir) {
  const binDir = path.join(options.dir, "tools", "ffmpeg", "bin");
  mkdirSync(binDir, { recursive: true });
  installSingleToolFromDir(sourceDir, "ffmpeg", binDir);
  installSingleToolFromDir(sourceDir, "ffprobe", binDir);
  const ffplay = findToolExecutable(sourceDir, "ffplay");
  if (ffplay) copyTool(ffplay, path.join(binDir, executableName("ffplay")));
}

function installSingleToolFromDir(sourceDir, baseName, targetDir, aliases = []) {
  mkdirSync(targetDir, { recursive: true });
  const found = findToolExecutable(sourceDir, baseName) || aliases.map((alias) => findToolExecutable(sourceDir, alias)).find(Boolean);
  if (!found) throw new Error(`Cannot find ${baseName} in extracted archive.`);
  copyTool(found, path.join(targetDir, executableName(baseName)));
}

function findToolExecutable(rootDir, baseName) {
  const names = new Set([baseName.toLowerCase()]);
  if (process.platform === "win32") names.add(`${baseName.toLowerCase()}.exe`);
  const stack = [rootDir];
  while (stack.length) {
    const current = stack.pop();
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const fullPath = path.join(current, entry.name);
      if (entry.isDirectory()) {
        stack.push(fullPath);
        continue;
      }
      if (names.has(entry.name.toLowerCase())) return fullPath;
    }
  }
  return undefined;
}

function executableName(baseName) {
  return process.platform === "win32" ? `${baseName}.exe` : baseName;
}

function copyTool(source, target) {
  mkdirSync(path.dirname(target), { recursive: true });
  copyFileSync(source, target);
  if (process.platform !== "win32") chmodSync(target, 0o755);
  console.log(`Installed ${path.relative(options.dir, target)}`);
}

function installDependencies() {
  run(npmCommand, ["install"], { cwd: options.dir, env: deployEnv });
}

async function waitForApplication() {
  const apiUrl = `http://127.0.0.1:${options.port}/api/server`;
  const webUrl = `http://127.0.0.1:${options.webPort}`;
  await waitForUrl(apiUrl, "API");
  await waitForUrl(webUrl, "Web");
}

async function waitForUrl(url, label) {
  const deadline = Date.now() + options.timeoutSeconds * 1000;
  let lastError = "";
  while (Date.now() < deadline) {
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 3000);
      const response = await fetch(url, {
        signal: controller.signal,
        cache: "no-store"
      });
      clearTimeout(timer);
      if (response.ok) {
        console.log(`${label} ready: ${url}`);
        return;
      }
      lastError = `HTTP ${response.status}`;
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    }
    await sleep(1500);
  }

  printRecentLogs();
  throw new Error(`${label} did not become ready at ${url}: ${lastError || "timeout"}`);
}

function printRecentLogs() {
  console.log("\nRecent Movie Hub logs:");
  spawnSync(process.execPath, [path.join(options.dir, "scripts", "service.mjs"), "logs", "--lines", "80"], {
    cwd: options.dir,
    stdio: "inherit",
    env: deployEnv,
    windowsHide: true
  });
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function run(command, args, settings = {}) {
  const invocation = commandInvocation(command, args);
  const result = spawnSync(invocation.command, invocation.args, {
    cwd: settings.cwd ?? process.cwd(),
    env: settings.env ?? process.env,
    stdio: "inherit",
    windowsHide: true
  });
  if (result.error) throw new Error(`Failed to run ${command}: ${result.error.message}`);
  if (result.status !== 0) throw new Error(`${command} ${args.join(" ")} failed with exit code ${result.status ?? "unknown"}.`);
}

function capture(command, args, settings = {}) {
  const invocation = commandInvocation(command, args);
  const result = spawnSync(invocation.command, invocation.args, {
    cwd: settings.cwd ?? process.cwd(),
    env: settings.env ?? process.env,
    encoding: "utf8",
    windowsHide: true
  });
  if (result.error) throw new Error(`Failed to run ${command}: ${result.error.message}`);
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(" ")} failed: ${result.stderr?.trim() || result.stdout?.trim() || "unknown error"}`);
  }
  return result;
}

function commandInvocation(command, args) {
  if (process.platform === "win32" && usesWindowsShell(command)) {
    return {
      command: process.env.ComSpec ?? "cmd.exe",
      args: ["/d", "/s", "/c", [command, ...args].map(quoteWindowsArg).join(" ")]
    };
  }
  return { command, args };
}

function usesWindowsShell(command) {
  const normalized = command.toLowerCase();
  return normalized === "npm" || normalized === "npm.cmd" || normalized.endsWith(".cmd") || normalized.endsWith(".bat");
}

function quoteWindowsArg(value) {
  if (!/[ \t"&|<>^]/.test(value)) return value;
  return `"${value.replace(/"/g, '\\"')}"`;
}

function printHelp() {
  console.log(`Usage: node scripts/deploy.mjs [options]

Clone or update Movie Hub, install dependencies, verify the app, start services,
and wait until the Web and API endpoints are reachable.

Options:
  --repo <url>       Git repository URL. Default: ${defaultRepo}
  --branch <name>    Git branch. Default: ${defaultBranch}
  --dir <path>       Target directory. Default: current repo or ./movie-hub
  --port <port>      API port. Default: 8787
  --web-port <port>  Web port. Default: 5173
  --timeout <sec>    Readiness timeout. Default: 90
  --skip-pull        Use the existing checkout without fetching or pulling
  --skip-tools       Skip ffmpeg / N_m3u8DL-RE download and extraction
  --skip-verify      Skip npm run verify
  --skip-start       Do not restart the service
  --help             Show this help

Environment:
  MOVIE_HUB_REPO, MOVIE_HUB_BRANCH, MOVIE_HUB_DIR, PORT, WEB_PORT
`);
}
