#!/usr/bin/env node
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, readSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { spawn, spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const packageJsonFile = path.join(rootDir, "package.json");
const nodeModulesDir = path.join(rootDir, "node_modules");
const runtimeDir = path.join(rootDir, "var");
const stateFile = path.join(runtimeDir, "movie-hub.state.json");
const logFile = path.join(runtimeDir, "movie-hub.log");
const apiPort = readPort("PORT", 8787);
const webPort = readPort("WEB_PORT", 5173);
const webUrl = `http://127.0.0.1:${webPort}`;
const apiBaseUrl = `http://127.0.0.1:${apiPort}`;
const apiUrl = `${apiBaseUrl}/api/server`;
const apiScript = path.join(rootDir, "server", "index.ts");
const runtimeDependencies = [
  { packageName: "tsx", binName: "tsx", label: "tsx" },
  { packageName: "vite", binName: "vite", label: "vite" },
  { packageName: "better-sqlite3", label: "better-sqlite3", moduleName: "better-sqlite3" }
];

const command = (process.argv[2] ?? "help").toLowerCase();
const extraArgs = process.argv.slice(3);

main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(message);
  process.exitCode = 1;
});

async function main() {
  switch (command) {
    case "start":
      await startService();
      return;
    case "stop":
      await stopService();
      return;
    case "restart":
      await stopService({ quiet: true });
      await startService();
      return;
    case "status":
      await printStatus();
      return;
    case "logs":
      await printLogs(extraArgs);
      return;
    case "help":
    case "--help":
    case "-h":
    default:
      printHelp();
  }
}

function ensureRuntimeDir() {
  mkdirSync(runtimeDir, { recursive: true });
}

function readPort(name, fallback) {
  const value = Number(process.env[name]);
  if (Number.isInteger(value) && value > 0 && value <= 65535) return value;
  return fallback;
}

function readState() {
  try {
    if (!existsSync(stateFile)) return null;
    const parsed = JSON.parse(readFileSync(stateFile, "utf8"));
    if (!parsed || typeof parsed !== "object") return null;
    if (!Number.isInteger(parsed.apiPid) || !Number.isInteger(parsed.webPid)) return null;
    return parsed;
  } catch {
    return null;
  }
}

function writeState(state) {
  ensureRuntimeDir();
  writeFileSync(stateFile, `${JSON.stringify(state, null, 2)}\n`);
}

function removeState() {
  try {
    unlinkSync(stateFile);
  } catch {
    // Ignore missing state.
  }
}

function isProcessAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function startChild(command, args) {
  const fd = openSync(logFile, "a");
  try {
    const child = spawn(process.execPath, [command, ...args], {
      cwd: rootDir,
      detached: true,
      stdio: ["ignore", fd, fd],
      windowsHide: true,
      env: {
        ...process.env,
        NODE_ENV: process.env.NODE_ENV ?? "development"
      }
    });
    if (!child.pid) {
      throw new Error("Failed to start Movie Hub.");
    }
    child.unref();
    return child.pid;
  } finally {
    closeSync(fd);
  }
}

function readPackageJson() {
  try {
    return JSON.parse(readFileSync(packageJsonFile, "utf8"));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Cannot read package.json: ${message}`);
  }
}

function dependencyDeclared(packageJson, packageName) {
  return Boolean(packageJson.dependencies?.[packageName] || packageJson.devDependencies?.[packageName] || packageJson.optionalDependencies?.[packageName]);
}

function dependencyBinPath(packageName, binName) {
  const packageJsonPath = path.join(nodeModulesDir, packageName, "package.json");
  if (!existsSync(packageJsonPath)) return null;

  try {
    const packageJson = JSON.parse(readFileSync(packageJsonPath, "utf8"));
    const bin = packageJson.bin;
    const relativeBin = typeof bin === "string" ? bin : bin?.[binName];
    if (!relativeBin) return null;

    const resolved = path.resolve(path.dirname(packageJsonPath), relativeBin);
    return existsSync(resolved) ? resolved : null;
  } catch {
    return null;
  }
}

function statePorts(state) {
  return {
    apiPort: Number.isInteger(state?.apiPort) ? state.apiPort : 8787,
    webPort: Number.isInteger(state?.webPort) ? state.webPort : 5173
  };
}

function stateMatchesCurrentPorts(state) {
  const ports = statePorts(state);
  return ports.apiPort === apiPort && ports.webPort === webPort;
}

function formatPortPair(state) {
  const ports = statePorts(state);
  return `API ${ports.apiPort}, Web ${ports.webPort}`;
}

function displayCommandPart(value) {
  return path.isAbsolute(value) ? path.relative(rootDir, value) : value;
}

function missingRuntimeDependencies() {
  const packageJson = readPackageJson();
  return runtimeDependencies.filter((dependency) => {
    if (!dependencyDeclared(packageJson, dependency.packageName)) {
      throw new Error(`Missing ${dependency.packageName} in package.json dependencies.`);
    }
    if (dependency.binName) return !dependencyBinPath(dependency.packageName, dependency.binName);
    if (dependency.moduleName) return !dependencyModuleReady(dependency.moduleName);
    return false;
  });
}

function dependencyModuleReady(moduleName) {
  const result = spawnSync(process.execPath, ["-e", `require(${JSON.stringify(moduleName)})`], {
    cwd: rootDir,
    stdio: "ignore",
    windowsHide: true
  });
  return !result.error && result.status === 0;
}

function installDependencies() {
  console.log("Runtime dependencies are missing or incomplete. Running npm install...");
  const installCommand =
    process.platform === "win32"
      ? {
          command: process.env.ComSpec ?? "cmd.exe",
          args: ["/d", "/s", "/c", "npm install"]
        }
      : {
          command: "npm",
          args: ["install"]
        };
  const result = spawnSync(installCommand.command, installCommand.args, {
    cwd: rootDir,
    stdio: "inherit",
    windowsHide: true
  });

  if (result.error) {
    throw new Error(`Failed to run npm install: ${result.error.message}`);
  }
  if (result.status !== 0) {
    throw new Error(`npm install failed with exit code ${result.status ?? "unknown"}.`);
  }
}

function ensureRuntimeDependencies() {
  if (!existsSync(nodeModulesDir)) installDependencies();

  let missing = missingRuntimeDependencies();
  if (missing.length) {
    console.log(`Missing runtime package files: ${missing.map((dependency) => dependency.label).join(", ")}`);
    installDependencies();
    missing = missingRuntimeDependencies();
  }

  if (missing.length) {
    throw new Error(
      `Runtime dependencies are still missing after npm install: ${missing.map((dependency) => dependency.label).join(", ")}.`
    );
  }
}

function launchPlan() {
  const apiCli = dependencyBinPath("tsx", "tsx");
  const webCli = dependencyBinPath("vite", "vite");
  if (!apiCli || !webCli) {
    throw new Error("Runtime dependencies are not ready. Run npm install and try again.");
  }

  return {
    api: {
      command: apiCli,
      args: ["watch", apiScript]
    },
    web: {
      command: webCli,
      args: ["--host", "0.0.0.0", "--port", String(webPort), "--strictPort"]
    }
  };
}

async function startService() {
  ensureRuntimeDir();
  ensureRuntimeDependencies();

  const state = readState();
  const apiAlive = state?.apiPid ? isProcessAlive(state.apiPid) : false;
  const webAlive = state?.webPid ? isProcessAlive(state.webPid) : false;
  if (apiAlive && webAlive) {
    if (stateMatchesCurrentPorts(state)) {
      console.log(`Movie Hub is already running (api ${state.apiPid}, web ${state.webPid}).`);
      console.log(`Web: ${webUrl}`);
      console.log(`API: ${apiBaseUrl}`);
      console.log(`Log: ${logFile}`);
      return;
    }
    throw new Error(
      `Movie Hub is already running with different ports (${formatPortPair(state)}). Run restart to switch to API ${apiPort}, Web ${webPort}.`
    );
  }
  if (apiAlive || webAlive) {
    console.log("Movie Hub is partially running. Stopping the stale stack before starting again...");
    await stopService({ quiet: true });
  }

  const apiProbe = await probeHttp(apiUrl);
  const webProbe = await probeHttp(webUrl);
  if (apiProbe.ok && webProbe.ok) {
    console.log("Movie Hub already appears to be running on the expected ports, but no matching state file was found.");
    console.log(`Web: ${formatProbe(webProbe, `http://localhost:${webPort}`)}`);
    console.log(`API: ${formatProbe(apiProbe, `http://localhost:${apiPort}`)}`);
    console.log(`Log: ${logFile}`);
    return;
  }
  if (apiProbe.ok || webProbe.ok) {
    throw new Error(
      `Cannot start Movie Hub because one expected port is already in use. Web: ${formatProbe(webProbe, `http://localhost:${webPort}`)}; API: ${formatProbe(apiProbe, `http://localhost:${apiPort}`)}. Stop the process using that port or choose different PORT/WEB_PORT values.`
    );
  }

  removeState();

  const plan = launchPlan();
  let apiPid;
  let webPid;

  try {
    apiPid = startChild(plan.api.command, plan.api.args);
    webPid = startChild(plan.web.command, plan.web.args);
    writeState({
      apiPid,
      webPid,
      apiPort,
      webPort,
      platform: process.platform,
      node: process.version,
      startedAt: new Date().toISOString(),
      command: {
        api: `node ${displayCommandPart(plan.api.command)} ${plan.api.args.map(displayCommandPart).join(" ")}`,
        web: `node ${displayCommandPart(plan.web.command)} ${plan.web.args.map(displayCommandPart).join(" ")}`
      }
    });
    console.log(`Movie Hub started.`);
    console.log(`API pid: ${apiPid} -> http://localhost:${apiPort}`);
    console.log(`Web pid: ${webPid} -> http://localhost:${webPort}`);
    console.log(`Log: ${logFile}`);
  } catch (error) {
    await stopLooseProcess(apiPid);
    await stopLooseProcess(webPid);
    throw error instanceof Error ? error : new Error(String(error));
  }
}

async function stopService(options = {}) {
  const { quiet = false } = options;
  const state = readState();

  if (!state?.apiPid && !state?.webPid) {
    removeState();
    if (!quiet) console.log("Movie Hub is not running.");
    return;
  }

  const apiAlive = state.apiPid ? isProcessAlive(state.apiPid) : false;
  const webAlive = state.webPid ? isProcessAlive(state.webPid) : false;

  if (!apiAlive && !webAlive) {
    removeState();
    if (!quiet) console.log("Movie Hub state was stale and has been cleared.");
    return;
  }

  await stopLooseProcess(state.apiPid);
  await stopLooseProcess(state.webPid);
  removeState();

  if (!quiet) console.log("Movie Hub stopped.");
}

async function stopLooseProcess(pid) {
  if (!pid || !isProcessAlive(pid)) return;

  if (process.platform === "win32") {
    spawnSync("taskkill", ["/PID", String(pid), "/T", "/F"], { stdio: "ignore" });
    return;
  }

  try {
    process.kill(-pid, "SIGTERM");
  } catch {
    try {
      process.kill(pid, "SIGTERM");
    } catch {
      return;
    }
  }

  const deadline = Date.now() + 5000;
  while (Date.now() < deadline && isProcessAlive(pid)) {
    await sleep(200);
  }

  if (isProcessAlive(pid)) {
    try {
      process.kill(-pid, "SIGKILL");
    } catch {
      try {
        process.kill(pid, "SIGKILL");
      } catch {
        // Ignore.
      }
    }
  }
}

async function printStatus() {
  const state = readState();
  const apiAlive = state?.apiPid ? isProcessAlive(state.apiPid) : false;
  const webAlive = state?.webPid ? isProcessAlive(state.webPid) : false;
  const apiProbe = await probeHttp(apiUrl);
  const webProbe = await probeHttp(webUrl);
  const statePortValues = statePorts(state);
  const stateApiProbe =
    state && !stateMatchesCurrentPorts(state) ? await probeHttp(`http://127.0.0.1:${statePortValues.apiPort}/api/server`) : apiProbe;
  const stateWebProbe = state && !stateMatchesCurrentPorts(state) ? await probeHttp(`http://127.0.0.1:${statePortValues.webPort}`) : webProbe;
  const running = apiAlive || webAlive || apiProbe.ok || webProbe.ok || stateApiProbe.ok || stateWebProbe.ok;
  const healthy = apiAlive && webAlive && stateApiProbe.ok && stateWebProbe.ok && stateMatchesCurrentPorts(state);

  console.log(`Status: ${running ? (healthy ? "running" : "partial") : "stopped"}`);
  if (state?.apiPid) console.log(`API PID: ${state.apiPid}${apiAlive ? "" : " (stale)"}`);
  if (state?.webPid) console.log(`Web PID: ${state.webPid}${webAlive ? "" : " (stale)"}`);
  if (state) console.log(`State ports: ${formatPortPair(state)}`);
  console.log(`Configured ports: API ${apiPort}, Web ${webPort}`);
  if (state?.startedAt) console.log(`Started: ${state.startedAt}`);
  console.log(`Web: ${formatProbe(webProbe, `http://localhost:${webPort}`)}`);
  console.log(`API: ${formatProbe(apiProbe, `http://localhost:${apiPort}`)}`);
  if (state && !stateMatchesCurrentPorts(state)) {
    console.log(`State Web: ${formatProbe(stateWebProbe, `http://localhost:${statePortValues.webPort}`)}`);
    console.log(`State API: ${formatProbe(stateApiProbe, `http://localhost:${statePortValues.apiPort}`)}`);
    console.log("Note: configured ports differ from the saved running stack. Use restart to switch ports.");
  }
  console.log(`Log: ${logFile}`);
}

async function probeHttp(url) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 1000);
  try {
    const response = await fetch(url, {
      signal: controller.signal,
      cache: "no-store"
    });
    return { ok: true, status: response.status };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  } finally {
    clearTimeout(timer);
  }
}

function formatProbe(result, label) {
  return result.ok ? `${label} [ok ${result.status}]` : `${label} [down]`;
}

async function printLogs(args) {
  const options = parseLogOptions(args);
  if (!existsSync(logFile)) {
    console.log("No log file yet.");
    return;
  }

  const text = readFileSync(logFile, "utf8");
  process.stdout.write(tailLines(text, options.lines));

  if (!options.follow) return;

  let position = statSync(logFile).size;
  const timer = setInterval(() => {
    if (!existsSync(logFile)) return;
    const size = statSync(logFile).size;
    if (size < position) {
      position = size;
      return;
    }
    if (size === position) return;

    const chunk = readChunk(logFile, position, size - position);
    position = size;
    process.stdout.write(chunk);
  }, 1000);

  const cleanup = () => {
    clearInterval(timer);
    process.exit(0);
  };

  process.once("SIGINT", cleanup);
  process.once("SIGTERM", cleanup);
}

function readChunk(file, offset, length) {
  const fd = openSync(file, "r");
  try {
    const buffer = Buffer.alloc(length);
    const bytesRead = readSync(fd, buffer, 0, length, offset);
    return buffer.subarray(0, bytesRead).toString("utf8");
  } finally {
    closeSync(fd);
  }
}

function tailLines(text, count) {
  const normalized = text.replace(/\r\n/g, "\n");
  const lines = normalized.split("\n");
  if (lines.at(-1) === "") lines.pop();
  if (lines.length <= count) {
    return `${lines.join("\n")}${lines.length ? "\n" : ""}`;
  }
  return `${lines.slice(-count).join("\n")}\n`;
}

function parseLogOptions(args) {
  let lines = 120;
  let follow = false;

  for (let index = 0; index < args.length; index += 1) {
    const value = args[index];
    if (value === "--follow" || value === "-f") {
      follow = true;
      continue;
    }
    if (value === "--lines" || value === "-n") {
      const next = Number(args[index + 1]);
      if (Number.isFinite(next) && next > 0) lines = Math.trunc(next);
      index += 1;
      continue;
    }
    if (value.startsWith("--lines=")) {
      const next = Number(value.slice("--lines=".length));
      if (Number.isFinite(next) && next > 0) lines = Math.trunc(next);
      continue;
    }
    if (/^-n\d+$/.test(value)) {
      const next = Number(value.slice(2));
      if (Number.isFinite(next) && next > 0) lines = Math.trunc(next);
    }
  }

  return { lines, follow };
}

function printHelp() {
  console.log(`Usage: node scripts/service.mjs <start|stop|restart|status|logs>

Commands:
  start     Start the Movie Hub dev stack
  stop      Stop the Movie Hub dev stack
  restart   Restart the Movie Hub dev stack
  status    Show process and port status
  logs      Print the latest log lines

Examples:
  node scripts/service.mjs start
  PORT=8787 WEB_PORT=5173 node scripts/service.mjs start
  node scripts/service.mjs logs --lines 200
  node scripts/service.mjs logs --follow
`);
}
