import type {
  AppState,
  AppSettings,
  BackupRestoreResult,
  CatalogItem,
  DoubanPageResponse,
  DownloadTask,
  HubStats,
  LocalHlsJob,
  LocalVideo,
  RuntimeStatusResponse,
  ShareSummary,
  SourceHealthCheck,
  SourceImportResult,
  SourceMatchResponse,
  SourceSite,
  ToolsStatusResponse
} from "../types";

async function errorText(response: Response) {
  try {
    const json = await response.json();
    return json.error ?? response.statusText;
  } catch {
    return response.statusText;
  }
}

export const api = {
  async get<T>(url: string, options?: RequestInit): Promise<T> {
    const response = await fetch(url, options);
    if (!response.ok) throw new Error(await errorText(response));
    return response.json() as Promise<T>;
  },
  async send<T>(url: string, method: "POST" | "PUT" | "DELETE", body?: unknown): Promise<T> {
    const response = await fetch(url, {
      method,
      headers: body ? { "Content-Type": "application/json" } : undefined,
      body: body ? JSON.stringify(body) : undefined
    });
    if (!response.ok) throw new Error(await errorText(response));
    return response.json() as Promise<T>;
  }
};

export function getState() {
  return api.get<AppState>("/api/state");
}

export function getStats() {
  return api.get<HubStats>("/api/stats");
}

export function getShareSummary() {
  return api.get<ShareSummary>("/api/share");
}

export function getDoubanTrending(page: number, pageSize = 20) {
  return api.get<DoubanPageResponse>(`/api/douban/trending?page=${page}&pageSize=${pageSize}`);
}

export function searchResources(keyword: string, site = "all", options?: { silent?: boolean; signal?: AbortSignal }) {
  const silent = options?.silent ? "&silent=1" : "";
  return api.get<{ results: CatalogItem[]; errors: string[] }>(
    `/api/search?q=${encodeURIComponent(keyword)}&site=${encodeURIComponent(site)}${silent}`,
    { signal: options?.signal }
  );
}

export function getCatalogItem(sourceId: string, vodId: string) {
  return api.get<CatalogItem>(`/api/catalog/${encodeURIComponent(sourceId)}/${encodeURIComponent(vodId)}`);
}

export function matchSources(subject: CatalogItem) {
  return api.send<SourceMatchResponse>("/api/source-matches", "POST", { subject });
}

export function addWatch(item: CatalogItem, autoDownload = false) {
  return api.send("/api/watchlist", "POST", { item, autoDownload });
}

export function removeWatch(id: string) {
  return api.send(`/api/watchlist/${encodeURIComponent(id)}`, "DELETE");
}

export function checkWatchlist() {
  return api.send("/api/watchlist/check", "POST");
}

export function checkSiteHealth(id: string) {
  return api.send<{ result: SourceHealthCheck; sourceHealth: Record<string, SourceHealthCheck> }>(
    `/api/sites/${encodeURIComponent(id)}/health/check`,
    "POST"
  );
}

export function checkAllSitesHealth() {
  return api.send<{ results: SourceHealthCheck[]; sourceHealth: Record<string, SourceHealthCheck> }>("/api/sites/health/check", "POST");
}

export function saveSettings(settings: Partial<AppSettings>) {
  return api.send<{ settings: AppSettings }>("/api/settings", "PUT", settings);
}

export function getToolsStatus() {
  return api.get<ToolsStatusResponse>("/api/tools/status");
}

export function getRuntimeStatus(lines = 160) {
  return api.get<RuntimeStatusResponse>(`/api/runtime/status?lines=${encodeURIComponent(String(lines))}`);
}

export async function downloadStateBackup() {
  const response = await fetch("/api/backup/state");
  if (!response.ok) throw new Error(await errorText(response));
  const blob = await response.blob();
  const disposition = response.headers.get("Content-Disposition") ?? "";
  const match = disposition.match(/filename\*?=(?:UTF-8''|")?([^";]+)/i);
  const fallback = `movie-hub-backup-${new Date().toISOString().replace(/[:.]/g, "-")}.json`;
  const filename = match ? decodeURIComponent(match[1].replace(/"/g, "")) : fallback;
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
  URL.revokeObjectURL(url);
  return { filename, size: blob.size };
}

export function restoreStateBackup(backup: unknown) {
  return api.send<BackupRestoreResult>("/api/backup/restore", "POST", { backup, confirm: true });
}

export function createDownloadTask(item: CatalogItem, episodeName: string, url: string, sourceId: string) {
  return api.send<DownloadTask>("/api/downloads", "POST", {
    title: item.title,
    episodeName,
    url,
    sourceId
  });
}

export function removeDownload(id: string) {
  return api.send<{ downloads: DownloadTask[]; canceled: boolean }>(`/api/downloads/${encodeURIComponent(id)}`, "DELETE");
}

export function retryDownload(id: string) {
  return api.send<{ task: DownloadTask; downloads: DownloadTask[] }>(`/api/downloads/${encodeURIComponent(id)}/retry`, "POST");
}

export function clearDownloads(status: "completed" | "failed" | "canceled") {
  return api.send<{ removed: number; downloads: DownloadTask[] }>(`/api/downloads?status=${encodeURIComponent(status)}`, "DELETE");
}

export function saveSite(site: Partial<SourceSite> & Pick<SourceSite, "name" | "baseUrl">, id?: string) {
  return id ? api.send(`/api/sites/${id}`, "PUT", site) : api.send("/api/sites", "POST", site);
}

export function deleteSite(id: string) {
  return api.send(`/api/sites/${id}`, "DELETE");
}

export function importSiteSubscription(input: {
  url: string;
  enabled: boolean;
  searchable: boolean;
  apiStyle: SourceSite["apiStyle"];
}) {
  return api.send<SourceImportResult>("/api/sites/import-subscription", "POST", input);
}

export function buildLocalHls(video: LocalVideo) {
  return api.send<LocalHlsJob>(`/api/library/${encodeURIComponent(video.id)}/hls`, "POST");
}

export function markNotificationsRead(ids?: string[]) {
  return api.send("/api/notifications/read", "POST", ids ? { ids } : {});
}

export function clearReadNotifications(ids?: string[]) {
  return api.send("/api/notifications/read", "DELETE", ids ? { ids } : undefined);
}
