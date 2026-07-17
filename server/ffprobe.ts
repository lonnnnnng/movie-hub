import { spawn } from "node:child_process";
import { resolveLocalToolPath, resolveSiblingToolPath } from "./toolPaths";
import { getFfmpegPath } from "./ffmpeg";

function getFfprobePath(configuredFfmpegPath?: string) {
  return (
    resolveSiblingToolPath(configuredFfmpegPath, "ffprobe") ||
    process.env.FFPROBE_PATH?.trim() ||
    resolveLocalToolPath("ffprobe") ||
    resolveSiblingToolPath(getFfmpegPath(configuredFfmpegPath), "ffprobe") ||
    "ffprobe"
  );
}

function parseNumber(value?: string) {
  if (!value) return undefined;
  const parsed = Number.parseFloat(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function pickStream(streams: Array<Record<string, unknown>>, type: "video" | "audio") {
  return streams.find((stream) => stream.codec_type === type) as
    | {
        codec_type?: string;
        codec_name?: string;
        width?: number;
        height?: number;
        bit_rate?: string;
        channels?: number;
        sample_rate?: string;
      }
    | undefined;
}

export async function hasFfprobe(configuredFfmpegPath?: string) {
  return new Promise<boolean>((resolve) => {
    let child;
    try {
      child = spawn(getFfprobePath(configuredFfmpegPath), ["-version"], { stdio: "ignore", windowsHide: true });
    } catch {
      resolve(false);
      return;
    }
    child.on("error", () => resolve(false));
    child.on("exit", (code) => resolve(code === 0));
  });
}

export async function inspectFfprobe(configuredFfmpegPath?: string) {
  const command = getFfprobePath(configuredFfmpegPath);
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
        configuredPath: undefined,
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
        configuredPath: undefined,
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
        configuredPath: undefined,
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
        configuredPath: undefined,
        version: firstLine,
        latencyMs: Math.round(performance.now() - startedAt),
        message: code === 0 ? "ffprobe 可用" : `ffprobe 退出码 ${code ?? "unknown"}`
      });
    });
  });
}

export async function probeMediaInfo(filePath: string, configuredFfmpegPath?: string) {
  const command = getFfprobePath(configuredFfmpegPath);
  return new Promise<
    | {
        durationSeconds?: number;
        width?: number;
        height?: number;
        videoCodec?: string;
        audioCodec?: string;
        bitrateKbps?: number;
        containerFormat?: string;
        audioChannels?: number;
        sampleRate?: number;
      }
    | undefined
  >((resolve) => {
    let output = "";
    let child;
    try {
      child = spawn(
        command,
        [
          "-v",
          "error",
          "-show_entries",
          "format=duration,bit_rate,format_name:stream=index,codec_type,codec_name,width,height,bit_rate,channels,sample_rate",
          "-show_streams",
          "-show_format",
          "-of",
          "json",
          filePath
        ],
        { windowsHide: true }
      );
    } catch {
      resolve(undefined);
      return;
    }
    const timer = setTimeout(() => {
      child.kill();
      resolve(undefined);
    }, 10000);

    child.stdout?.on("data", (chunk: Buffer) => {
      output = `${output}${chunk.toString("utf-8")}`;
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      output = `${output}${chunk.toString("utf-8")}`;
    });
    child.on("error", () => {
      clearTimeout(timer);
      resolve(undefined);
    });
    child.on("exit", (code) => {
      clearTimeout(timer);
      if (code !== 0 || !output.trim()) {
        resolve(undefined);
        return;
      }

      try {
        const parsed = JSON.parse(output) as {
          format?: {
            duration?: string;
            bit_rate?: string;
            format_name?: string;
          };
          streams?: Array<Record<string, unknown>>;
        };
        const streams = parsed.streams ?? [];
        const videoStream = pickStream(streams, "video");
        const audioStream = pickStream(streams, "audio");
        const durationSeconds = parseNumber(parsed.format?.duration);
        const bitrateKbps = parseNumber(parsed.format?.bit_rate ?? videoStream?.bit_rate ?? audioStream?.bit_rate);

        resolve({
          durationSeconds,
          width: typeof videoStream?.width === "number" ? videoStream.width : undefined,
          height: typeof videoStream?.height === "number" ? videoStream.height : undefined,
          videoCodec: videoStream?.codec_name,
          audioCodec: audioStream?.codec_name,
          bitrateKbps: bitrateKbps ? Math.round(bitrateKbps / 1000) : undefined,
          containerFormat: parsed.format?.format_name?.split(",").find(Boolean),
          audioChannels: typeof audioStream?.channels === "number" ? audioStream.channels : undefined,
          sampleRate: parseNumber(audioStream?.sample_rate)
        });
      } catch {
        resolve(undefined);
      }
    });
  });
}
