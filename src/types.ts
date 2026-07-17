export type MediaKind = "movie" | "series" | "anime" | "variety" | "unknown";

export type SourceSite = {
  id: string;
  name: string;
  baseUrl: string;
  enabled: boolean;
  apiStyle: "maccms-json" | "maccms-xml" | "auto";
  searchable: boolean;
  builtIn?: boolean;
  notes?: string;
  createdAt: string;
  updatedAt: string;
};

export type SourceImportResult = {
  imported: SourceSite[];
  skipped: {
    name: string;
    baseUrl: string;
    reason: string;
  }[];
  failed: {
    name: string;
    baseUrl: string;
    reason: string;
  }[];
  totals: {
    candidates: number;
    imported: number;
    skipped: number;
    failed: number;
  };
  sites: SourceSite[];
};

type SourceHealthStatus = "online" | "offline" | "disabled" | "unknown";

export type SourceHealthCheck = {
  siteId: string;
  siteName: string;
  status: SourceHealthStatus;
  ok: boolean;
  latencyMs?: number;
  httpStatus?: number;
  checkedAt: string;
  message?: string;
  url?: string;
  sampleBytes?: number;
};

export type MediaProbeInfo = {
  durationSeconds?: number;
  width?: number;
  height?: number;
  videoCodec?: string;
  audioCodec?: string;
  bitrateKbps?: number;
  containerFormat?: string;
  audioChannels?: number;
  sampleRate?: number;
};

export type AppSettings = {
  sourceHealthCheckIntervalMinutes: number;
  sourceHealthLastAutoCheckAt?: string;
  watchlistCheckIntervalMinutes: number;
  watchlistLastAutoCheckAt?: string;
  ffmpegPath?: string;
  ffmpegHlsSegmentSeconds: number;
  ffmpegReconnectDelaySeconds: number;
  ffmpegDownloadInputArgs?: string;
  ffmpegDownloadOutputArgs?: string;
  ffmpegHlsInputArgs?: string;
  ffmpegHlsOutputArgs?: string;
  m3u8DownloaderPath?: string;
  m3u8DownloaderThreads: number;
  m3u8DownloaderRetryCount: number;
  m3u8DownloaderTimeoutSeconds: number;
  m3u8DownloaderHeaders?: string;
  m3u8DownloaderProxy?: string;
  m3u8DownloaderMaxSpeed?: string;
  m3u8DownloaderMuxAfterDone?: string;
  m3u8DownloaderExtraArgs?: string;
  shareSmbUrl?: string;
  shareFtpUrl?: string;
};

export type Episode = {
  id: string;
  name: string;
  url: string;
  playFrom?: string;
  sourceId: string;
  sourceName: string;
};

export type CatalogItem = {
  id: string;
  sourceId: string;
  sourceName: string;
  vodId: string;
  title: string;
  originalTitle?: string;
  kind: MediaKind;
  poster?: string;
  backdrop?: string;
  year?: string;
  area?: string;
  language?: string;
  typeName?: string;
  actors?: string;
  director?: string;
  remarks?: string;
  description?: string;
  updatedAt?: string;
  score?: string;
  episodes: Episode[];
  raw?: unknown;
};

export type WatchItem = {
  id: string;
  item: CatalogItem;
  latestEpisodeName?: string;
  lastCheckedAt?: string;
  updateFoundAt?: string;
  updateMessage?: string;
  autoDownload: boolean;
  createdAt: string;
};

export type DownloadTask = {
  id: string;
  title: string;
  episodeName: string;
  url: string;
  sourceId: string;
  status: "queued" | "downloading" | "completed" | "failed" | "canceled";
  progress: number;
  downloader?: "n-m3u8dl-re" | "ffmpeg";
  message?: string;
  outputDir?: string;
  outputPath?: string;
  playlistPath?: string;
  playlistUrl?: string;
  createdAt: string;
  updatedAt: string;
};

export type LocalVideo = {
  id: string;
  title: string;
  episodeName?: string;
  fileName: string;
  path: string;
  size: number;
  modifiedAt: string;
  streamUrl: string;
  hlsUrl?: string;
  probe?: MediaProbeInfo;
};

export type LocalHlsJob = {
  id: string;
  videoId: string;
  title: string;
  episodeName?: string;
  fileName: string;
  outputDir: string;
  playlistPath: string;
  status: "queued" | "running" | "completed" | "failed";
  progress: number;
  message?: string;
  createdAt: string;
  updatedAt: string;
};

type ShareProtocol = "hls" | "webdav" | "smb" | "ftp";

export type ShareProtocolInfo = {
  id: ShareProtocol;
  label: string;
  status: "active" | "external" | "disabled";
  urls: string[];
  rootPath?: string;
  description: string;
  note?: string;
};

export type ShareSummary = {
  mediaDir: string;
  hlsDir: string;
  videos: LocalVideo[];
  totalSize: number;
  hlsReady: number;
  appUrls: string[];
  apiUrls: string[];
  protocols: ShareProtocolInfo[];
  generatedAt: string;
};

export type ToolStatus = {
  id: "ffmpeg" | "ffprobe" | "n-m3u8dl-re";
  label: string;
  ok: boolean;
  command?: string;
  configuredPath?: string;
  version?: string;
  latencyMs?: number;
  stability: "stable" | "slow" | "missing" | "error";
  message: string;
  checkedAt: string;
};

export type ToolsStatusResponse = {
  ffmpeg: ToolStatus;
  ffprobe: ToolStatus;
  nM3u8DlRe: ToolStatus;
  checkedAt: string;
};

export type RuntimeDiagnosticCheck = {
  id: "api" | "library" | "tools" | "downloads" | "sources" | "notifications";
  label: string;
  status: "ok" | "warning" | "error";
  message: string;
  value?: string;
};

export type RuntimeStatusResponse = {
  api: string;
  uptimeSeconds: number;
  memory: {
    rss: number;
    heapUsed: number;
    heapTotal: number;
  };
  cwd: string;
  mediaDir: string;
  hlsDir: string;
  logFile: string;
  startedAt: string;
  checkedAt: string;
  checks: RuntimeDiagnosticCheck[];
  logs: {
    lines: string[];
    size: number;
    modifiedAt?: string;
  };
};

export type BackupRestoreResult = {
  restoredAt: string;
  summary: {
    sites: number;
    enabledSites: number;
    watchlist: number;
    downloads: number;
    hlsJobs: number;
    notifications: number;
    scrapeHistory: number;
    trendingCache: number;
    library: number;
  };
  state: AppState;
};

export type HubNotification = {
  id: string;
  title: string;
  message: string;
  tone: "info" | "success" | "warning" | "danger";
  category: "watch" | "download" | "source" | "system";
  itemId?: string;
  sourceId?: string;
  taskId?: string;
  read: boolean;
  createdAt: string;
};

export type AppState = {
  sites: SourceSite[];
  sourceHealth: Record<string, SourceHealthCheck>;
  settings: AppSettings;
  watchlist: WatchItem[];
  downloads: DownloadTask[];
  hlsJobs: LocalHlsJob[];
  library: LocalVideo[];
  notifications: HubNotification[];
  scrapeHistory: unknown[];
  trendingCache: CatalogItem[];
  trendingUpdatedAt?: string;
};

export type HubStats = {
  sites: number;
  enabledSites: number;
  onlineSites: number;
  offlineSites: number;
  watchlist: number;
  downloads: number;
  completedDownloads: number;
  library: number;
  serverUrls: string[];
  apiUrls: string[];
  unreadNotifications: number;
  lastScrapeAt?: string;
  trendingUpdatedAt?: string;
};

type SourceRouteStatus = "available" | "missing" | "failed" | "disabled";

export type SourceRouteMetric = {
  key: "availability" | "latency" | "episodes" | "speed" | "stability" | "quality" | "freshness" | "match" | "reliability";
  label: string;
  value: string;
  score: number;
  tone: "good" | "warn" | "bad" | "muted";
  description?: string;
};

export type SourceRoute = {
  siteId: string;
  siteName: string;
  enabled: boolean;
  status: SourceRouteStatus;
  hasResource: boolean;
  playable: boolean;
  score: number;
  reasons: string[];
  candidateTitle?: string;
  vodId?: string;
  item?: CatalogItem;
  episodeCount: number;
  latestEpisodeName?: string;
  remarks?: string;
  quality: {
    label: string;
    score: number;
  };
  probe: {
    playable: boolean;
    latencyMs?: number;
    speedKbps?: number;
    stability: "unknown" | "smooth" | "ok" | "risky" | "failed";
    message?: string;
    testedUrl?: string;
    checkedAt: string;
  };
  metrics: SourceRouteMetric[];
  error?: string;
};

export type SourceMatchResponse = {
  subject: CatalogItem;
  routes: SourceRoute[];
  recommendedRoute?: SourceRoute;
  selectedItem?: CatalogItem;
  errors: string[];
  checkedAt: string;
};

export type DoubanPageResponse = {
  items: CatalogItem[];
  page: number;
  pageSize: number;
  hasMore: boolean;
};

export type Toast = {
  tone: "good" | "warn" | "bad";
  message: string;
};
