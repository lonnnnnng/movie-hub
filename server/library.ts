import { createReadStream, existsSync, statSync } from "node:fs";
import { mkdir, readdir, stat, cp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { Request, Response } from "express";
import type { AppSettings, LocalHlsJob, LocalVideo } from "./types";
import { hasFfmpeg, spawnFfmpeg } from "./ffmpeg";
import { hasFfprobe, probeMediaInfo } from "./ffprobe";
import { buildFfmpegHlsArgs } from "./toolArgs";
import { addNotification, readState, upsertLocalHlsJob } from "./store";
import { hlsDir, legacyHlsDir, mediaDir } from "./paths";

const videoExtensions = new Set([".mp4", ".mkv", ".webm", ".mov", ".m4v"]);
const activeLocalHlsJobs = new Map<string, LocalHlsJob>();
const mediaProbeCache = new Map<string, LocalVideo["probe"] | null>();
const ffprobeAvailabilityCache = new Map<string, boolean>();

function mimeFor(filePath: string) {
  const ext = path.extname(filePath).toLowerCase();
  if (ext === ".mp4" || ext === ".m4v") return "video/mp4";
  if (ext === ".webm") return "video/webm";
  if (ext === ".mov") return "video/quicktime";
  if (ext === ".ts") return "video/mp2t";
  return "application/octet-stream";
}

function safeResolveMediaPath(fileName: string) {
  const resolved = path.resolve(mediaDir, fileName);
  const relative = path.relative(mediaDir, resolved);
  if (relative.startsWith("..") || path.isAbsolute(relative)) return undefined;
  return resolved;
}

function hlsPlaylistPath(id: string) {
  return path.join(hlsDir, id, "index.m3u8");
}

function legacyHlsPlaylistPath(id: string) {
  return path.join(legacyHlsDir, id, "index.m3u8");
}

async function ensureLegacyHlsMigrated(id: string) {
  const next = hlsPlaylistPath(id);
  if (existsSync(next)) return;
  const legacy = legacyHlsPlaylistPath(id);
  if (!existsSync(legacy)) return;
  await mkdir(path.dirname(next), { recursive: true });
  await cp(path.dirname(legacy), path.dirname(next), { recursive: true, force: true });
}

function decodeLibraryId(id: string) {
  return Buffer.from(id, "base64url").toString("utf-8");
}

function libraryTitle(relative: string) {
  const parsed = path.parse(relative);
  return parsed.dir ? parsed.dir.split("/").at(-1) ?? parsed.name : parsed.name;
}

function cleanFfmpegMessage(message: string) {
  return message
    .replace(/\u001b\[[0-9;]*m/g, "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .slice(-2)
    .join(" / ")
    .slice(0, 220);
}

function parseTimestamp(value: string) {
  const parts = value.split(":").map(Number);
  if (parts.length !== 3 || parts.some((part) => Number.isNaN(part))) return undefined;
  return parts[0] * 3600 + parts[1] * 60 + parts[2];
}

function parseHlsProgress(message: string) {
  const durationMatch = message.match(/Duration:\s*(\d{2}:\d{2}:\d{2}(?:\.\d+)?)/);
  const timeMatches = [...message.matchAll(/time=\s*(\d{2}:\d{2}:\d{2}(?:\.\d+)?)/g)];
  const latestTime = timeMatches.at(-1)?.[1];
  if (!durationMatch || !latestTime) return undefined;

  const duration = parseTimestamp(durationMatch[1]);
  const current = parseTimestamp(latestTime);
  if (!duration || !current) return undefined;

  return Math.max(0, Math.min(96, Math.round((current / duration) * 88) + 8));
}

async function walk(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true });
  const files = await Promise.all(
    entries.map(async (entry) => {
      if (entry.name.startsWith(".")) return [];
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) return walk(fullPath);
      if (entry.isFile() && videoExtensions.has(path.extname(entry.name).toLowerCase())) return [fullPath];
      return [];
    })
  );
  return files.flat();
}

async function mapLimit<T, U>(items: T[], limit: number, mapper: (item: T, index: number) => Promise<U>) {
  const results = new Array<U>(items.length);
  let cursor = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (cursor < items.length) {
      const index = cursor;
      cursor += 1;
      results[index] = await mapper(items[index], index);
    }
  });
  await Promise.all(workers);
  return results;
}

function probeCacheKey(filePath: string, size: number, mtimeMs: number) {
  return `${filePath}|${size}|${mtimeMs}`;
}

async function probeLibraryVideo(filePath: string, size: number, mtimeMs: number, ffmpegPath?: string) {
  const key = probeCacheKey(filePath, size, mtimeMs);
  if (mediaProbeCache.has(key)) return mediaProbeCache.get(key) ?? undefined;

  const probe = await probeMediaInfo(filePath, ffmpegPath);
  mediaProbeCache.set(key, probe ?? null);

  if (mediaProbeCache.size > 600) {
    const oldestKey = mediaProbeCache.keys().next().value as string | undefined;
    if (oldestKey) mediaProbeCache.delete(oldestKey);
  }

  return probe ?? undefined;
}

async function ensureFfprobeAvailable(ffmpegPath?: string) {
  const key = ffmpegPath?.trim() || "__default__";
  if (!ffprobeAvailabilityCache.has(key)) {
    ffprobeAvailabilityCache.set(key, await hasFfprobe(ffmpegPath));
  }
  return ffprobeAvailabilityCache.get(key) ?? false;
}

export async function scanLibrary(host = "localhost:8787"): Promise<LocalVideo[]> {
  await mkdir(mediaDir, { recursive: true });
  const state = await readState();
  const ffmpegPath = state.settings.ffmpegPath;
  const ffprobeAvailable = await ensureFfprobeAvailable(ffmpegPath);
  const files = await walk(mediaDir);

  return mapLimit(files, 4, async (filePath) => {
    const info = await stat(filePath);
    const relative = path.relative(mediaDir, filePath).replace(/\\/g, "/");
    const parsed = path.parse(relative);
    const title = parsed.dir ? parsed.dir.split("/").at(-1) ?? parsed.name : parsed.name;
    const id = Buffer.from(relative).toString("base64url");
    await ensureLegacyHlsMigrated(id);
    const probe = ffprobeAvailable ? await probeLibraryVideo(filePath, info.size, info.mtimeMs, ffmpegPath) : undefined;

    return {
      id,
      title,
      episodeName: parsed.name === title ? undefined : parsed.name,
      fileName: relative,
      path: filePath,
      size: info.size,
      modifiedAt: info.mtime.toISOString(),
      streamUrl: `http://${host}/media/${encodeURIComponent(relative)}`,
      hlsUrl: existsSync(hlsPlaylistPath(id)) ? `http://${host}/hls/${id}/index.m3u8` : undefined,
      ...(probe ? { probe } : {})
    } satisfies LocalVideo;
  });
}

export async function buildLocalHls(id: string) {
  const state = await readState();
  const settings = state.settings;
  if (!(await hasFfmpeg(settings.ffmpegPath))) {
    throw new Error("未检测到 ffmpeg，无法把本地视频切片为 m3u8。");
  }

  const relative = decodeLibraryId(id);
  const input = safeResolveMediaPath(relative);
  if (!input || !existsSync(input)) {
    throw new Error("本地视频不存在。");
  }

  const outputDir = path.join(hlsDir, id);
  await mkdir(outputDir, { recursive: true });
  const playlist = path.join(outputDir, "index.m3u8");
  const segmentPattern = path.join(outputDir, "segment_%05d.ts");
  const now = new Date().toISOString();

  const activeJob = activeLocalHlsJobs.get(id);
  if (activeJob && (activeJob.status === "queued" || activeJob.status === "running")) {
    return activeJob;
  }

  const job: LocalHlsJob = {
    id: `hls-${Date.now()}-${Math.random().toString(16).slice(2)}`,
    videoId: id,
    title: libraryTitle(relative),
    episodeName: path.parse(relative).name,
    fileName: relative,
    outputDir,
    playlistPath: playlist,
    status: "queued",
    progress: 0,
    message: "等待 ffmpeg 启动",
    createdAt: now,
    updatedAt: now
  };

  activeLocalHlsJobs.set(id, job);
  await upsertLocalHlsJob(job);
  void runLocalHlsJob(job, input, segmentPattern, playlist, settings);
  return job;
}

async function runLocalHlsJob(
  job: LocalHlsJob,
  input: string,
  segmentPattern: string,
  playlist: string,
  settings: AppSettings
) {
  let current: LocalHlsJob = job;
  let progress = 0;
  let lastPersistAt = 0;
  let settled = false;
  let stderr = "";

  const persist = async (update: Partial<LocalHlsJob>) => {
    progress = update.progress ?? progress;
    current = {
      ...current,
      ...update,
      progress: update.progress ?? progress,
      updatedAt: new Date().toISOString()
    };
    await upsertLocalHlsJob(current);
  };

  const settle = async (status: LocalHlsJob["status"], message: string, code?: number) => {
    if (settled) return;
    settled = true;
    activeLocalHlsJobs.delete(job.videoId);
    await persist({
      status,
      progress: status === "completed" ? 100 : Math.min(progress, 96),
      message: status === "completed" ? "HLS 生成完成" : message
    });

    if (status === "completed") {
      await addNotification({
        title: "本地 HLS 生成完成",
        message: `${job.title} 已完成切片，可以直接播放或复制 m3u8 地址。`,
        tone: "success",
        category: "download"
      });
      return;
    }

    await addNotification({
      title: "本地 HLS 生成失败",
      message: `${job.title}: ${message}${code == null ? "" : `（${code}）`}`,
      tone: "danger",
      category: "download"
    });
  };

  try {
    const child = spawnFfmpeg(
      buildFfmpegHlsArgs({ input, segmentPattern, playlist }, settings),
      {},
      settings.ffmpegPath
    );

    await persist({ status: "running", progress: 4, message: "正在生成 HLS 片段" });

    child.stderr?.on("data", (chunk: Buffer) => {
      stderr = `${stderr}${chunk.toString("utf-8")}`.slice(-1600);
      const summary = cleanFfmpegMessage(stderr);
      const nextProgress = parseHlsProgress(stderr) ?? Math.min(96, Math.max(progress + 1, 12));
      progress = Math.max(progress, nextProgress);
      const now = Date.now();
      if (now - lastPersistAt < 900 && progress < 96) return;
      lastPersistAt = now;
      void persist({
        status: "running",
        progress,
        message: summary || "正在生成 HLS 片段"
      });
    });

    child.on("error", (error) => {
      void settle("failed", error instanceof Error ? error.message : String(error));
    });

    child.on("exit", (code) => {
      if (code === 0) {
        void settle("completed", "HLS 生成完成");
        return;
      }
      void settle("failed", stderr || `ffmpeg 退出码 ${code ?? "unknown"}`, code ?? undefined);
    });
  } catch (error) {
    void settle("failed", error instanceof Error ? error.message : String(error));
  }
}

export function streamLocalVideo(req: Request, res: Response) {
  const encodedName = Array.isArray(req.params.fileName) ? req.params.fileName.join("/") : req.params.fileName;
  const fileName = decodeURIComponent(encodedName);
  const filePath = safeResolveMediaPath(fileName);

  if (!filePath || !existsSync(filePath)) {
    res.status(404).json({ error: "视频文件不存在" });
    return;
  }

  const fileStat = statSync(filePath);
  const range = req.headers.range;
  const contentType = mimeFor(filePath);

  if (!range) {
    res.writeHead(200, {
      "Content-Length": fileStat.size,
      "Content-Type": contentType,
      "Accept-Ranges": "bytes"
    });
    createReadStream(filePath).pipe(res);
    return;
  }

  const parts = range.replace(/bytes=/, "").split("-");
  const start = Number.parseInt(parts[0], 10);
  const end = parts[1] ? Number.parseInt(parts[1], 10) : fileStat.size - 1;
  const chunkSize = end - start + 1;

  res.writeHead(206, {
    "Content-Range": `bytes ${start}-${end}/${fileStat.size}`,
    "Accept-Ranges": "bytes",
    "Content-Length": chunkSize,
    "Content-Type": contentType
  });
  createReadStream(filePath, { start, end }).pipe(res);
}

export function getLanUrls(port: number) {
  const urls = [`http://localhost:${port}`];
  const interfaces = os.networkInterfaces();

  Object.values(interfaces).forEach((items) => {
    items?.forEach((network) => {
      if (network.family === "IPv4" && !network.internal) {
        urls.push(`http://${network.address}:${port}`);
      }
    });
  });

  return urls;
}
