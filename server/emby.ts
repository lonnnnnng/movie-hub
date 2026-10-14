import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import type { AppSettings, DownloadTask } from "./types";
import { mediaDir } from "./paths";
import { readState } from "./store";

type EmbySyncResult = {
  enabled: boolean;
  synced: number;
  skipped: number;
  failed: number;
  refreshed: boolean;
  message?: string;
};

function cleanSegment(value: string) {
  return value.replace(/[<>:"/\\|?*\u0000-\u001F]/g, " ").replace(/\s+/g, " ").trim().slice(0, 160) || "未命名";
}

function xmlEscape(value: string) {
  return value.replace(/[<>&'\"]/g, (char) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", "'": "&apos;", '\"': "&quot;" })[char] ?? char);
}

function normalizeHttpUrl(value: string, required: boolean) {
  const trimmed = value.trim().replace(/\/+$/, "");
  if (!trimmed && !required) return "";
  const parsed = new URL(trimmed);
  if (!["http:", "https:"].includes(parsed.protocol) || parsed.username || parsed.password || parsed.search || parsed.hash) {
    throw new Error("Emby 地址必须是没有凭据、查询参数和片段的 HTTP(S) 地址。");
  }
  return parsed.toString().replace(/\/+$/, "");
}

function settingsError(settings: AppSettings) {
  if (!settings.embyEnabled) return undefined;
  if (!settings.embyOutputDir.trim()) return "Emby 导出目录不能为空。";
  if (!settings.embyBaseUrl.trim()) return "Emby 播放地址不能为空，必须是 Emby 可访问的 Movie Hub 地址。";
  if (!settings.embyServerUrl.trim()) return "Emby Server URL 不能为空。";
  if (!settings.embyApiKey.trim()) return "Emby API Key 不能为空。";
  try {
    normalizeHttpUrl(settings.embyBaseUrl, true);
    if (settings.embyServerUrl.trim()) normalizeHttpUrl(settings.embyServerUrl, true);
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
  return undefined;
}

function episodeNumber(task: DownloadTask, fallback: number) {
  const match = task.episodeName.match(/(?:第\s*)?(\d{1,4})\s*(?:集|话|期|episode|ep)?$/i) ?? task.episodeName.match(/(?:episode|ep|e)[\s._-]*(\d{1,4})/i);
  const number = match ? Number(match[1]) : fallback;
  return Number.isInteger(number) && number > 0 && number < 1000 ? number : fallback;
}

function publicMediaUrl(baseUrl: string, outputPath: string) {
  const relative = path.relative(mediaDir, outputPath).replace(/\\/g, "/");
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) throw new Error("下载文件不在 Movie Hub media 目录内。");
  return `${baseUrl}/media/${relative.split("/").map(encodeURIComponent).join("/")}`;
}

function showNfo(title: string) {
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<tvshow><title>${xmlEscape(title)}</title><plot>Movie Hub 下载片库</plot><uniqueid type="moviehub" default="true">${xmlEscape(title)}</uniqueid></tvshow>\n`;
}

function episodeNfo(title: string, number: number) {
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<episodedetails><title>${xmlEscape(title)}</title><season>1</season><episode>${number}</episode><uniqueid type="moviehub">${xmlEscape(`${title}-${number}`)}</uniqueid></episodedetails>\n`;
}

async function writeTaskExport(task: DownloadTask, settings: AppSettings, groupTasks: DownloadTask[]) {
  if (!task.outputPath) return false;
  const baseUrl = normalizeHttpUrl(settings.embyBaseUrl, true);
  const outputRoot = path.resolve(settings.embyOutputDir);
  const titleDir = path.join(outputRoot, cleanSegment(task.title));
  const seasonDir = path.join(titleDir, "Season 01");
  const ordered = [...groupTasks].sort((a, b) => a.updatedAt.localeCompare(b.updatedAt) || a.id.localeCompare(b.id));
  const index = ordered.findIndex((entry) => entry.id === task.id);
  const number = episodeNumber(task, index + 1);
  const fileStem = `S01E${String(number).padStart(3, "0")}`;
  await mkdir(seasonDir, { recursive: true, mode: 0o2775 });
  await writeFile(path.join(titleDir, "tvshow.nfo"), showNfo(task.title), "utf8");
  await writeFile(path.join(seasonDir, `${fileStem}.nfo`), episodeNfo(task.episodeName, number), "utf8");
  await writeFile(path.join(seasonDir, `${fileStem}.strm`), `${publicMediaUrl(baseUrl, task.outputPath)}\n`, "utf8");
  return true;
}

async function refreshEmby(settings: AppSettings) {
  if (!settings.embyServerUrl.trim()) return false;
  const serverUrl = normalizeHttpUrl(settings.embyServerUrl, true);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15000);
  try {
    const response = await fetch(`${serverUrl}/Library/Refresh`, {
      method: "POST",
      headers: { "X-Emby-Token": settings.embyApiKey.trim(), Accept: "application/json" },
      signal: controller.signal
    });
    if (!response.ok) throw new Error(`Emby 刷新失败 HTTP ${response.status}`);
    return true;
  } finally {
    clearTimeout(timeout);
  }
}

export async function syncCompletedDownload(task: DownloadTask) {
  const state = await readState();
  const settings = state.settings;
  if (!settings.embyEnabled || !settings.embySyncOnDownload || task.status !== "completed") return { synced: false, skipped: true };
  const error = settingsError(settings);
  if (error) throw new Error(error);
  const peers = state.downloads.filter((entry) => entry.status === "completed" && entry.title === task.title && entry.outputPath);
  await writeTaskExport(task, settings, peers);
  await refreshEmby(settings);
  return { synced: true, skipped: false };
}

export async function syncAllCompletedDownloads(): Promise<EmbySyncResult> {
  const state = await readState();
  const settings = state.settings;
  if (!settings.embyEnabled) return { enabled: false, synced: 0, skipped: 0, failed: 0, refreshed: false, message: "Emby 同步未启用。" };
  const error = settingsError(settings);
  if (error) return { enabled: true, synced: 0, skipped: 0, failed: 0, refreshed: false, message: error };
  const tasks = state.downloads.filter((entry) => entry.status === "completed" && entry.outputPath);
  const groups = new Map<string, DownloadTask[]>();
  for (const task of tasks) groups.set(task.title, [...(groups.get(task.title) ?? []), task]);
  let synced = 0;
  let failed = 0;
  for (const task of tasks) {
    try {
      await writeTaskExport(task, settings, groups.get(task.title) ?? [task]);
      synced += 1;
    } catch (error) {
      failed += 1;
      console.error(`Emby export failed for ${task.id}:`, error);
    }
  }
  let refreshed = false;
  try {
    refreshed = synced > 0 && (await refreshEmby(settings));
  } catch (error) {
    failed += 1;
    console.error("Emby refresh failed:", error);
  }
  return { enabled: true, synced, skipped: 0, failed, refreshed };
}

export async function getEmbyStatus() {
  const state = await readState();
  const settings = state.settings;
  return {
    enabled: settings.embyEnabled,
    configured: !settingsError(settings),
    outputDir: path.resolve(settings.embyOutputDir),
    serverUrl: settings.embyServerUrl ? "<configured>" : "",
    completedDownloads: state.downloads.filter((task) => task.status === "completed").length
  };
}
