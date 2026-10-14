import { spawn, type ChildProcess } from "node:child_process";
import { mkdir, readdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import type { AppSettings, DownloadTask } from "./types";
import { hasFfmpeg, spawnFfmpeg } from "./ffmpeg";
import { findNm3u8DlRe, spawnNm3u8DlRe } from "./nm3u8dl";
import { buildFfmpegDownloadArgs, buildNm3u8DlReArgs } from "./toolArgs";
import { hlsDir, mediaDir } from "./paths";
import { addNotification, readState, upsertDownload } from "./store";
import { syncCompletedDownload } from "./emby";

const activeDownloads = new Set<string>();
const downloadProcesses = new Map<string, ChildProcess>();
const canceledDownloads = new Set<string>();
const reservedOutputKeys = new Set<string>();
const videoExtensions = new Set([".mp4", ".mkv", ".webm", ".mov", ".m4v", ".ts"]);

class DownloadCanceledError extends Error {
  constructor() {
    super("下载已取消");
    this.name = "DownloadCanceledError";
  }
}

function ensureDownloadNotCanceled(taskId: string) {
  if (canceledDownloads.has(taskId)) throw new DownloadCanceledError();
}

function terminateChildProcess(child: ChildProcess) {
  if (child.killed) return;

  if (process.platform === "win32" && child.pid) {
    const killer = spawn("taskkill", ["/pid", String(child.pid), "/t", "/f"], {
      stdio: "ignore",
      windowsHide: true
    });
    killer.on("error", () => {
      if (!child.killed) child.kill();
    });
  } else {
    child.kill("SIGTERM");
  }

  const timer = setTimeout(() => {
    if (!child.killed) child.kill("SIGKILL");
  }, 2500);
  timer.unref?.();
}

type DownloadPlan = {
  titleDir: string;
  saveName: string;
  downloadSaveName: string;
  outputPath: string;
  tempDir: string;
};

function sanitizeSegment(value: string) {
  return value.replace(/[<>:"/\\|?*\u0000-\u001F]/g, " ").replace(/\s+/g, " ").trim().slice(0, 90) || "video";
}

function timestampSeconds(value: string) {
  const parts = value.split(":").map(Number);
  if (parts.length !== 3 || parts.some((part) => Number.isNaN(part))) return undefined;
  return parts[0] * 3600 + parts[1] * 60 + parts[2];
}

function processSummary(message: string) {
  return message
    .replace(/\u001b\[[0-9;]*m/g, "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .slice(-2)
    .join(" / ")
    .slice(0, 260);
}

function isM3u8Url(url: string) {
  return /\.m3u8(?:[?#]|$)/i.test(url);
}

function parsePercent(message: string) {
  const matches = [...message.replace(/\u001b\[[0-9;]*m/g, "").matchAll(/(\d{1,3}(?:\.\d+)?)\s*%/g)];
  const latest = matches.at(-1)?.[1];
  if (!latest) return undefined;
  const value = Number(latest);
  if (!Number.isFinite(value)) return undefined;
  return Math.max(0, Math.min(96, Math.round(value)));
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isBusyFileError(error: unknown) {
  if (!error || typeof error !== "object" || !("code" in error)) return false;
  return ["EBUSY", "EPERM", "EACCES"].includes(String((error as { code?: unknown }).code));
}

async function pathExists(filePath: string) {
  try {
    await stat(filePath);
    return true;
  } catch {
    return false;
  }
}

async function retryBusyOperation<T>(operation: () => Promise<T>) {
  let lastError: unknown;
  for (let attempt = 0; attempt < 8; attempt += 1) {
    try {
      return await operation();
    } catch (error) {
      lastError = error;
      if (!isBusyFileError(error)) throw error;
      await sleep(350 + attempt * 250);
    }
  }
  throw lastError;
}

function taskFileSuffix(taskId: string) {
  return taskId.replace(/[^a-zA-Z0-9]/g, "").slice(-10) || Date.now().toString(36);
}

function outputKey(filePath: string) {
  return path.resolve(filePath).toLowerCase();
}

function buildDownloadSaveName(saveName: string, taskId: string) {
  const suffix = `.moviehub-${taskFileSuffix(taskId)}`;
  return `${saveName.slice(0, Math.max(1, 90 - suffix.length))}${suffix}`;
}

function buildPlan(task: DownloadTask): DownloadPlan {
  const titleDir = path.join(mediaDir, sanitizeSegment(task.title));
  const saveName = sanitizeSegment(task.episodeName);
  return {
    titleDir,
    saveName,
    downloadSaveName: buildDownloadSaveName(saveName, task.id),
    outputPath: path.join(titleDir, `${saveName}.mp4`),
    tempDir: path.join(hlsDir, "downloads", task.id)
  };
}

async function latestVideoFile(dir: string, saveName: string, startedAt: number) {
  let entries: string[];
  try {
    entries = await readdir(dir);
  } catch {
    return undefined;
  }

  const files = await Promise.all(
    entries
      .filter((entry) => videoExtensions.has(path.extname(entry).toLowerCase()))
      .filter((entry) => path.parse(entry).name.startsWith(saveName))
      .map(async (entry) => {
        const filePath = path.join(dir, entry);
        const info = await stat(filePath);
        return { filePath, mtimeMs: info.mtimeMs };
      })
  );

  return files
    .filter((entry) => entry.mtimeMs >= startedAt - 2000)
    .sort((a, b) => b.mtimeMs - a.mtimeMs)
    .at(0)?.filePath;
}

async function collectPlaylistFiles(dir: string): Promise<string[]> {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }

  const files = await Promise.all(entries.map(async (entry) => {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) return collectPlaylistFiles(fullPath);
    if (entry.isFile() && path.extname(entry.name).toLowerCase() === ".m3u8") return [fullPath];
    return [];
  }));
  return files.flat();
}

async function scorePlaylistFile(filePath: string, rootDir: string) {
  const relative = path.relative(rootDir, filePath).replace(/\\/g, "/");
  const depth = relative.split("/").length - 1;
  const name = path.basename(filePath).toLowerCase();
  let content = "";
  try {
    content = await readFile(filePath, "utf8");
  } catch {
    // Keep the playlist as a fallback candidate even if metadata cannot be read.
  }

  let score = depth * 20;
  if (/#EXT-X-STREAM-INF/i.test(content)) score -= 35;
  if (/(^|[-_.])(master|index|playlist|main)([-_.]|$)/i.test(name)) score -= 15;
  if (/#EXTINF/i.test(content)) score += 5;
  if (/(chunk|segment|seglist)/i.test(name)) score += 10;
  return { filePath, relative, score };
}

async function findPlaylistFile(dir: string): Promise<string | undefined> {
  const candidates = await collectPlaylistFiles(dir);
  if (!candidates.length) return undefined;

  const ranked = await Promise.all(candidates.map((filePath) => scorePlaylistFile(filePath, dir)));
  return ranked.sort((left, right) => left.score - right.score || left.relative.localeCompare(right.relative)).at(0)?.filePath;
}

function hlsUrlPath(filePath: string) {
  const relative = path.relative(hlsDir, filePath);
  if (relative.startsWith("..") || path.isAbsolute(relative)) return undefined;
  return `/hls/${relative.replace(/\\/g, "/").split("/").map(encodeURIComponent).join("/")}`;
}

function isExternalHlsUri(value: string) {
  return /^[a-z][a-z0-9+.-]*:/i.test(value) || value.startsWith("/") || value.startsWith("//");
}

function rewriteRelativeHlsUri(sourceDir: string, uri: string) {
  const value = uri.trim();
  if (!value || isExternalHlsUri(value)) return uri;

  const match = value.match(/^([^?#]*)([?#].*)?$/);
  const resourcePath = match?.[1] ?? value;
  const suffix = match?.[2] ?? "";
  if (!resourcePath) return uri;
  const rewritten = hlsUrlPath(path.resolve(sourceDir, resourcePath));
  return rewritten ? `${rewritten}${suffix}` : uri;
}

function rewriteHlsAttributeUris(line: string, sourceDir: string) {
  return line.replace(/URI=(?:"([^"]*)"|([^,]*))/g, (match, quoted: string | undefined, bare: string | undefined) => {
    const uri = quoted ?? bare;
    if (!uri) return match;
    return `URI="${rewriteRelativeHlsUri(sourceDir, uri)}"`;
  });
}

async function rewritePlaylistForHttp(playlistPath: string, targetPath: string) {
  const content = await readFile(playlistPath, "utf8");
  const sourceDir = path.dirname(playlistPath);
  const rewritten = content
    .split(/\r?\n/)
    .map((line) => {
      const value = line.trim();
      if (!value) return line;
      if (value.startsWith("#")) return rewriteHlsAttributeUris(line, sourceDir);
      return rewriteRelativeHlsUri(sourceDir, value);
    })
    .join("\n");
  await writeFile(targetPath, `${rewritten.endsWith("\n") ? rewritten : `${rewritten}\n`}`, "utf8");
}

function hlsCacheDirForOutput(outputPath: string) {
  const relative = path.relative(mediaDir, outputPath).replace(/\\/g, "/");
  return path.join(hlsDir, Buffer.from(relative).toString("base64url"));
}

async function preserveDownloadedHlsCache(plan: DownloadPlan, outputPath: string) {
  const playlist = await findPlaylistFile(plan.tempDir);
  if (!playlist) return undefined;

  const relativePlaylist = path.relative(plan.tempDir, playlist);
  if (relativePlaylist.startsWith("..") || path.isAbsolute(relativePlaylist)) return undefined;

  const hlsCacheDir = hlsCacheDirForOutput(outputPath);
  await rm(hlsCacheDir, { recursive: true, force: true });
  const targetSourceDir = path.join(hlsCacheDir, "source");
  const targetSourcePlaylist = path.join(targetSourceDir, relativePlaylist);
  await mkdir(path.dirname(targetSourceDir), { recursive: true });
  await retryBusyOperation(() => rename(plan.tempDir, targetSourceDir));
  const targetPlaylist = path.join(hlsCacheDir, "index.m3u8");
  await rewritePlaylistForHttp(targetSourcePlaylist, targetPlaylist);
  return targetPlaylist;
}

async function preserveDownloadedHlsCacheSafely(plan: DownloadPlan, outputPath: string) {
  try {
    return await preserveDownloadedHlsCache(plan, outputPath);
  } catch (error) {
    console.warn(`Unable to preserve downloaded HLS cache for ${outputPath}: ${errorMessage(error)}`);
    return undefined;
  }
}

function playlistHttpPath(playlistPath: string) {
  return hlsUrlPath(playlistPath);
}

async function reserveUniqueOutputPath(targetPath: string) {
  const parsed = path.parse(targetPath);
  for (let index = 1; index < 1000; index += 1) {
    const candidate =
      index === 1 ? targetPath : path.join(parsed.dir, `${parsed.name} (${index})${parsed.ext}`);
    const key = outputKey(candidate);
    if (reservedOutputKeys.has(key) || (await pathExists(candidate))) continue;
    reservedOutputKeys.add(key);
    return candidate;
  }
  throw new Error(`无法生成不重复的输出文件名: ${targetPath}`);
}

function releaseReservedOutputPath(filePath: string) {
  reservedOutputKeys.delete(outputKey(filePath));
}

async function normalizeDownloadedOutput(sourcePath: string, targetPath: string) {
  if (path.resolve(sourcePath) === path.resolve(targetPath)) {
    return targetPath;
  }

  const finalPath = await reserveUniqueOutputPath(targetPath);
  try {
    await retryBusyOperation(() => rename(sourcePath, finalPath));
    return finalPath;
  } finally {
    releaseReservedOutputPath(finalPath);
  }
}

export async function createDownloadTask(input: {
  title: string;
  episodeName: string;
  url: string;
  sourceId: string;
}) {
  const now = new Date().toISOString();
  const task: DownloadTask = {
    id: `task-${Date.now()}-${Math.random().toString(16).slice(2)}`,
    title: input.title,
    episodeName: input.episodeName,
    url: input.url,
    sourceId: input.sourceId,
    status: "queued",
    progress: 0,
    createdAt: now,
    updatedAt: now
  };

  await upsertDownload(task);
  await addNotification({
    title: "下载任务已创建",
    message: `${task.title} · ${task.episodeName} 已加入队列。`,
    tone: "info",
    category: "download",
    taskId: task.id,
    sourceId: task.sourceId
  });
  void startDownload(task);
  return task;
}

export async function resumeDownloadTask(task: DownloadTask) {
  if (!["queued", "downloading", "failed", "canceled"].includes(task.status)) return;
  const resumedTask: DownloadTask = {
    ...task,
    status: "queued",
    progress: 0,
    message:
      task.status === "failed" || task.status === "canceled"
        ? "任务已重新加入下载队列。"
        : "服务启动后恢复下载队列。",
    updatedAt: new Date().toISOString()
  };
  await upsertDownload(resumedTask);
  void startDownload(resumedTask);
}

export async function cancelDownloadTask(task: DownloadTask) {
  if (!["queued", "downloading"].includes(task.status)) return { canceled: false, reason: "task-not-active" as const };
  canceledDownloads.add(task.id);
  const child = downloadProcesses.get(task.id);
  if (child) terminateChildProcess(child);
  const canceledTask: DownloadTask = {
    ...task,
    status: "canceled",
    progress: Math.min(task.progress, 96),
    message: "下载已取消，可稍后重试。",
    updatedAt: new Date().toISOString()
  };
  await upsertDownload(canceledTask);
  await addNotification({
    title: "下载任务已取消",
    message: `${task.title} · ${task.episodeName} 已停止，已下载的临时文件不会自动删除。`,
    tone: "warning",
    category: "download",
    taskId: task.id,
    sourceId: task.sourceId
  });
  return { canceled: true as const };
}

async function startDownload(task: DownloadTask) {
  if (activeDownloads.has(task.id)) return;
  if (canceledDownloads.has(task.id)) {
    canceledDownloads.delete(task.id);
    return;
  }
  const plan = buildPlan(task);

  activeDownloads.add(task.id);

  await mkdir(plan.titleDir, { recursive: true });
  await mkdir(plan.tempDir, { recursive: true });

  let currentTask: DownloadTask = task;
  let writeQueue = Promise.resolve();
  let reservedDirectOutputPath: string | undefined;
  const persist = async (update: Partial<DownloadTask>) => {
    currentTask = {
      ...currentTask,
      ...update,
      updatedAt: new Date().toISOString()
    };
    const snapshot = currentTask;
    writeQueue = writeQueue.then(async () => {
      await upsertDownload(snapshot);
    });
    await writeQueue;
  };

  try {
    const state = await readState();
    const settings = state.settings;
    const ffmpegAvailable = await hasFfmpeg(settings.ffmpegPath);
    const nm3u8dl = isM3u8Url(task.url) ? await findNm3u8DlRe(settings.m3u8DownloaderPath) : undefined;
    ensureDownloadNotCanceled(task.id);

    if (nm3u8dl) {
      ensureDownloadNotCanceled(task.id);
      await persist({
        status: "downloading",
        progress: 6,
        outputDir: plan.titleDir,
        downloader: "n-m3u8dl-re",
        message: "N_m3u8DL-RE 已接管 m3u8 下载。"
      });

      try {
        const startedAt = Date.now();
        await runNm3u8DlRe(task, plan, settings, nm3u8dl, ffmpegAvailable, startedAt, persist);
        ensureDownloadNotCanceled(task.id);
        await writeQueue;
        const detectedOutput = await latestVideoFile(plan.titleDir, plan.downloadSaveName, startedAt);
        if (!detectedOutput) throw new Error("N_m3u8DL-RE 未生成可识别的视频文件。");
        const outputPath = await normalizeDownloadedOutput(detectedOutput, plan.outputPath);
        const playlistPath = await preserveDownloadedHlsCacheSafely(plan, outputPath);
        ensureDownloadNotCanceled(task.id);
        await completeTask(currentTask, plan.titleDir, outputPath, playlistPath);
        return;
      } catch (error) {
        if (error instanceof DownloadCanceledError || canceledDownloads.has(task.id)) throw new DownloadCanceledError();
        const taskStartedAt = Date.parse(currentTask.updatedAt);
        const recoveredOutput = await latestVideoFile(
          plan.titleDir,
          plan.downloadSaveName,
          Number.isFinite(taskStartedAt) ? taskStartedAt : Date.now()
        );
        if (recoveredOutput) {
          const outputPath = await normalizeDownloadedOutput(recoveredOutput, plan.outputPath);
          const playlistPath = await preserveDownloadedHlsCacheSafely(plan, outputPath);
          ensureDownloadNotCanceled(task.id);
          await completeTask(currentTask, plan.titleDir, outputPath, playlistPath);
          return;
        }
        if (!ffmpegAvailable) throw error;
        ensureDownloadNotCanceled(task.id);
        await persist({
          status: "downloading",
          progress: 8,
          downloader: "ffmpeg",
          message: `N_m3u8DL-RE 下载失败，已切换 ffmpeg：${errorMessage(error)}`
        });
      }
    }

    if (!ffmpegAvailable) {
      throw new Error(
        isM3u8Url(task.url)
          ? "未检测到 N_m3u8DL-RE 或 ffmpeg。请在系统 PATH、项目 tools 目录，或设置页配置 N_m3u8DL-RE 路径。"
          : "未检测到 ffmpeg，无法落地保存当前视频。"
      );
    }

    ensureDownloadNotCanceled(task.id);
    plan.outputPath = await reserveUniqueOutputPath(plan.outputPath);
    reservedDirectOutputPath = plan.outputPath;
    await persist({
      status: "downloading",
      progress: Math.max(currentTask.progress, 8),
      outputDir: plan.titleDir,
      outputPath: plan.outputPath,
      downloader: "ffmpeg",
      message: nm3u8dl ? currentTask.message : "使用 ffmpeg 下载并封装为 mp4。"
    });
    await runFfmpeg(task, plan, settings, persist);
    ensureDownloadNotCanceled(task.id);
    await writeQueue;
    await completeTask(currentTask, plan.titleDir, plan.outputPath);
  } catch (error) {
    await writeQueue;
    if (error instanceof DownloadCanceledError || canceledDownloads.has(task.id)) {
      await upsertDownload({
        ...currentTask,
        status: "canceled",
        progress: Math.min(currentTask.progress, 96),
        message: "下载已取消，可稍后重试。",
        updatedAt: new Date().toISOString()
      });
    } else {
      await failTask(currentTask, error);
    }
  } finally {
    activeDownloads.delete(task.id);
    downloadProcesses.delete(task.id);
    canceledDownloads.delete(task.id);
    if (reservedDirectOutputPath) releaseReservedOutputPath(reservedDirectOutputPath);
  }
}

function nm3u8Args(task: DownloadTask, plan: DownloadPlan, settings: AppSettings, ffmpegAvailable: boolean) {
  return buildNm3u8DlReArgs(
    {
      url: task.url,
      titleDir: plan.titleDir,
      saveName: plan.downloadSaveName,
      tempDir: plan.tempDir,
      ffmpegAvailable
    },
    settings
  );
}

function runNm3u8DlRe(
  task: DownloadTask,
  plan: DownloadPlan,
  settings: AppSettings,
  command: string,
  ffmpegAvailable: boolean,
  startedAt: number,
  persist: (update: Partial<DownloadTask>) => Promise<void>
) {
  return new Promise<void>((resolve, reject) => {
    const child = spawnNm3u8DlRe(command, nm3u8Args(task, plan, settings, ffmpegAvailable), {});
    downloadProcesses.set(task.id, child);
    let progress = 6;
    let lastPersistAt = 0;
    let lastMessage = "";

    const handleOutput = (chunk: Buffer) => {
      const message = chunk.toString("utf-8");
      const summary = processSummary(message);
      if (summary) lastMessage = summary;
      const nextPercent = parsePercent(message);
      if (nextPercent !== undefined) progress = Math.max(progress, Math.min(96, nextPercent));
      else progress = Math.min(96, Math.max(progress + 1, 12));

      const now = Date.now();
      if (now - lastPersistAt < 900 && progress < 96) return;
      lastPersistAt = now;
      void persist({
        status: "downloading",
        progress,
        message: summary || "N_m3u8DL-RE 正在下载分片。"
      });
    };

    child.stdout?.on("data", handleOutput);
    child.stderr?.on("data", handleOutput);
    child.on("error", reject);
    child.on("exit", async (code) => {
      downloadProcesses.delete(task.id);
      if (canceledDownloads.has(task.id)) {
        reject(new DownloadCanceledError());
        return;
      }
      if (code === 0) {
        resolve();
        return;
      }
      const outputPath = await latestVideoFile(plan.titleDir, plan.downloadSaveName, startedAt);
      if (outputPath) {
        resolve();
        return;
      }
      reject(new Error(`N_m3u8DL-RE 退出码 ${code ?? "unknown"}${lastMessage ? `：${lastMessage}` : ""}`));
    });
  });
}

function runFfmpeg(task: DownloadTask, plan: DownloadPlan, settings: AppSettings, persist: (update: Partial<DownloadTask>) => Promise<void>) {
  return new Promise<void>((resolve, reject) => {
    let progress = 8;
    let durationSeconds: number | undefined;
    let lastPersistAt = 0;
    let lastMessage = "";

    const child = spawnFfmpeg(
      buildFfmpegDownloadArgs({ url: task.url, outputPath: plan.outputPath }, settings),
      {},
      settings.ffmpegPath
    );
    downloadProcesses.set(task.id, child);

    child.stderr.on("data", (chunk: Buffer) => {
      const message = chunk.toString("utf-8");
      const summary = processSummary(message);
      if (summary) lastMessage = summary;

      const durationMatch = message.match(/Duration:\s*(\d{2}:\d{2}:\d{2}(?:\.\d+)?)/);
      if (durationMatch) durationSeconds = timestampSeconds(durationMatch[1]) ?? durationSeconds;

      const timeMatches = [...message.matchAll(/time=\s*(\d{2}:\d{2}:\d{2}(?:\.\d+)?)/g)];
      const latestTime = timeMatches.at(-1)?.[1];
      if (!latestTime) return;

      const elapsedSeconds = timestampSeconds(latestTime);
      if (elapsedSeconds !== undefined && durationSeconds && durationSeconds > 0) {
        progress = Math.min(96, Math.max(progress, Math.round((elapsedSeconds / durationSeconds) * 88) + 8));
      } else {
        progress = Math.min(96, Math.max(progress + 1, 12));
      }

      const now = Date.now();
      if (now - lastPersistAt < 900 && progress < 96) return;
      lastPersistAt = now;
      void persist({
        status: "downloading",
        progress,
        message: summary || `ffmpeg 已下载到 ${latestTime}`
      });
    });

    child.on("error", reject);
    child.on("exit", (code) => {
      downloadProcesses.delete(task.id);
      if (canceledDownloads.has(task.id)) {
        reject(new DownloadCanceledError());
        return;
      }
      if (code === 0) resolve();
      else reject(new Error(`ffmpeg 退出码 ${code ?? "unknown"}${lastMessage ? `：${lastMessage}` : ""}`));
    });
  });
}

async function completeTask(task: DownloadTask, outputDir: string, outputPath: string, playlistPath?: string) {
  const completedTask: DownloadTask = {
    ...task,
    status: "completed",
    progress: 100,
    message: "下载完成，已加入本地媒体目录。",
    outputDir,
    outputPath,
    playlistPath,
    playlistUrl: playlistPath ? playlistHttpPath(playlistPath) : undefined,
    updatedAt: new Date().toISOString()
  };
  await upsertDownload(completedTask);
  await addNotification({
    title: "下载完成",
    message: `${task.title} · ${task.episodeName} 已保存到本地媒体目录。`,
    tone: "success",
    category: "download",
    taskId: task.id,
    sourceId: task.sourceId
  });
  // long：下载已经成功落盘后再同步 Emby；外部服务失败只能提示，不能改变下载成功状态。
  void syncCompletedDownload(completedTask).catch((error) => {
    console.error(`Emby sync failed for ${task.id}:`, error);
  });
}

async function failTask(task: DownloadTask, error: unknown) {
  const message = errorMessage(error);
  await upsertDownload({
    ...task,
    status: "failed",
    progress: Math.min(task.progress, 96),
    message,
    updatedAt: new Date().toISOString()
  });
  await addNotification({
    title: "下载失败",
    message: `${task.title} · ${task.episodeName}: ${message}`,
    tone: "danger",
    category: "download",
    taskId: task.id,
    sourceId: task.sourceId
  });
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}
