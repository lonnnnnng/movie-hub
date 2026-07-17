import { existsSync } from "node:fs";
import path from "node:path";
import { spawn, type SpawnOptionsWithoutStdio } from "node:child_process";
import { resolveLocalToolCandidates } from "./toolPaths";

const commandNames = ["N_m3u8DL-RE", "N_m3u8DL-RE.exe", "n-m3u8dl-re", "n-m3u8dl-re.exe"];

function unique(values: string[]) {
  return [...new Set(values.filter(Boolean))];
}

function commandCandidates(configuredPath?: string) {
  const configured = configuredPath?.trim();
  const envPath = process.env.N_M3U8DL_RE_PATH?.trim() || process.env.N_M3U8DL_PATH?.trim();
  const localPaths = commandNames.flatMap((name) => resolveLocalToolCandidates(name));
  return unique([configured ?? "", envPath ?? "", ...localPaths, ...commandNames]).filter((command) => {
    return !path.isAbsolute(command) || existsSync(command);
  });
}

function commandWorks(command: string, args: string[]) {
  return new Promise<boolean>((resolve) => {
    let child;
    try {
      child = spawn(command, args, { stdio: "ignore", windowsHide: true });
    } catch {
      resolve(false);
      return;
    }
    const timer = setTimeout(() => {
      child.kill();
      resolve(false);
    }, 5000);

    child.on("error", () => {
      clearTimeout(timer);
      resolve(false);
    });
    child.on("exit", (code) => {
      clearTimeout(timer);
      resolve(code === 0);
    });
  });
}

export async function findNm3u8DlRe(configuredPath?: string) {
  for (const command of commandCandidates(configuredPath)) {
    if ((await commandWorks(command, ["--version"])) || (await commandWorks(command, ["--help"]))) {
      return command;
    }
  }
  return undefined;
}

export async function inspectNm3u8DlRe(configuredPath?: string) {
  const checkedAt = new Date().toISOString();
  for (const command of commandCandidates(configuredPath)) {
    const startedAt = performance.now();
    const result = await runProbe(command, ["--version"]);
    const fallback = result.ok ? result : await runProbe(command, ["--help"]);
    if (fallback.ok) {
      return {
        ok: true,
        command,
        configuredPath: configuredPath?.trim() || undefined,
        version: firstUsefulLine(fallback.output) ?? "N_m3u8DL-RE",
        latencyMs: Math.round(performance.now() - startedAt),
        message: "N_m3u8DL-RE 可用",
        checkedAt
      };
    }
  }

  return {
    ok: false,
    command: commandCandidates(configuredPath)[0],
    configuredPath: configuredPath?.trim() || undefined,
    latencyMs: 0,
    message: "未检测到 N_m3u8DL-RE，请检查 tools 目录或手动配置路径",
    checkedAt
  };
}

function runProbe(command: string, args: string[]) {
  return new Promise<{ ok: boolean; output: string; message?: string }>((resolve) => {
    let output = "";
    let child;
    try {
      child = spawn(command, args, { windowsHide: true });
    } catch (error) {
      resolve({ ok: false, output, message: error instanceof Error ? error.message : String(error) });
      return;
    }
    const timer = setTimeout(() => {
      child.kill();
      resolve({ ok: false, output, message: "检测超时" });
    }, 5000);

    child.stdout?.on("data", (chunk: Buffer) => {
      output = `${output}${chunk.toString("utf-8")}`.slice(0, 1000);
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      output = `${output}${chunk.toString("utf-8")}`.slice(0, 1000);
    });
    child.on("error", (error) => {
      clearTimeout(timer);
      resolve({ ok: false, output, message: error.message });
    });
    child.on("exit", (code) => {
      clearTimeout(timer);
      resolve({ ok: code === 0, output, message: `退出码 ${code ?? "unknown"}` });
    });
  });
}

function firstUsefulLine(output: string) {
  return output
    .replace(/\u001b\[[0-9;]*m/g, "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find((line) => line && !/^usage:/i.test(line));
}

export function spawnNm3u8DlRe(command: string, args: string[], options: SpawnOptionsWithoutStdio = {}) {
  return spawn(command, args, {
    ...options,
    windowsHide: true
  });
}
