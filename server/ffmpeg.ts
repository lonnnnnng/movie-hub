import { spawn, type SpawnOptionsWithoutStdio } from "node:child_process";
import { resolveLocalToolPath } from "./toolPaths";

export function getFfmpegPath(configuredPath?: string) {
  return configuredPath?.trim() || process.env.FFMPEG_PATH || resolveLocalToolPath("ffmpeg") || "ffmpeg";
}

export async function hasFfmpeg(configuredPath?: string) {
  return new Promise<boolean>((resolve) => {
    let child;
    try {
      child = spawn(getFfmpegPath(configuredPath), ["-version"], { stdio: "ignore", windowsHide: true });
    } catch {
      resolve(false);
      return;
    }
    child.on("error", () => resolve(false));
    child.on("exit", (code) => resolve(code === 0));
  });
}

export function spawnFfmpeg(args: string[], options: SpawnOptionsWithoutStdio = {}, configuredPath?: string) {
  return spawn(getFfmpegPath(configuredPath), args, {
    ...options,
    windowsHide: true
  });
}

export async function inspectFfmpeg(configuredPath?: string) {
  const command = getFfmpegPath(configuredPath);
  const checkedAt = new Date().toISOString();
  const startedAt = performance.now();
  return new Promise<{
    ok: boolean;
    command: string;
    configuredPath?: string;
    version?: string;
    latencyMs: number;
    message: string;
  }>((resolve) => {
    let output = "";
    let child;
    try {
      child = spawn(command, ["-version"], { windowsHide: true });
    } catch (error) {
      resolve({
        ok: false,
        command,
        configuredPath: configuredPath?.trim() || undefined,
        latencyMs: Math.round(performance.now() - startedAt),
        message: error instanceof Error ? error.message : String(error)
      });
      return;
    }
    const timer = setTimeout(() => {
      child.kill();
      resolve({
        ok: false,
        command,
        configuredPath: configuredPath?.trim() || undefined,
        latencyMs: Math.round(performance.now() - startedAt),
        message: `检测超时：${checkedAt}`
      });
    }, 5000);

    child.stdout?.on("data", (chunk: Buffer) => {
      output = `${output}${chunk.toString("utf-8")}`.slice(0, 1000);
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      output = `${output}${chunk.toString("utf-8")}`.slice(0, 1000);
    });
    child.on("error", (error) => {
      clearTimeout(timer);
      resolve({
        ok: false,
        command,
        configuredPath: configuredPath?.trim() || undefined,
        latencyMs: Math.round(performance.now() - startedAt),
        message: error.message
      });
    });
    child.on("exit", (code) => {
      clearTimeout(timer);
      const firstLine = output.split(/\r?\n/).find(Boolean)?.trim();
      resolve({
        ok: code === 0,
        command,
        configuredPath: configuredPath?.trim() || undefined,
        version: firstLine,
        latencyMs: Math.round(performance.now() - startedAt),
        message: code === 0 ? "ffmpeg 可用" : `ffmpeg 退出码 ${code ?? "unknown"}`
      });
    });
  });
}
