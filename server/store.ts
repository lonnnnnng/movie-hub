import { access, mkdir, readFile } from "node:fs/promises";
import path from "node:path";
import SqliteDatabase from "better-sqlite3";
import type {
  AppSettings,
  AppState,
  CatalogItem,
  DownloadTask,
  HubNotification,
  LocalHlsJob,
  ScrapeSnapshot,
  SourceHealthCheck,
  SourceSite,
  WatchItem
} from "./types";
import { defaultSites } from "./defaults";

type SqlValue = string | number | bigint | null;
type SqlRow = Record<string, SqlValue>;
type SqlStatement = {
  all(...values: SqlValue[]): SqlRow[];
  get(...values: SqlValue[]): SqlRow | undefined;
  run(...values: SqlValue[]): unknown;
};
type SqliteConnection = {
  exec(sql: string): void;
  prepare(sql: string): SqlStatement;
};

const dataDir = path.resolve("server", "data");
const legacyStorePath = path.join(dataDir, "store.json");
const databasePath = path.join(dataDir, "movie-hub.sqlite");
const bucketNames = ["sites", "watchlist", "downloads", "hlsJobs", "library", "notifications", "scrapeHistory", "trendingCache"] as const;

let db: SqliteConnection | undefined;
let stateQueue = Promise.resolve();

const blankState = (): AppState => ({
  sites: defaultSites,
  sourceHealth: {},
  settings: {
    sourceHealthCheckIntervalMinutes: 30,
    watchlistCheckIntervalMinutes: 30,
    ffmpegPath: "",
    ffmpegHlsSegmentSeconds: 6,
    ffmpegReconnectDelaySeconds: 5,
    ffmpegDownloadInputArgs: "",
    ffmpegDownloadOutputArgs: "",
    ffmpegHlsInputArgs: "",
    ffmpegHlsOutputArgs: "",
    m3u8DownloaderPath: "",
    m3u8DownloaderThreads: 16,
    m3u8DownloaderRetryCount: 6,
    m3u8DownloaderTimeoutSeconds: 30,
    m3u8DownloaderHeaders: "",
    m3u8DownloaderProxy: "",
    m3u8DownloaderMaxSpeed: "",
    m3u8DownloaderMuxAfterDone: "",
    m3u8DownloaderExtraArgs: "",
    shareSmbUrl: "",
    shareFtpUrl: ""
  },
  watchlist: [],
  downloads: [],
  hlsJobs: [],
  library: [],
  notifications: [],
  scrapeHistory: [],
  trendingCache: []
});

async function ensureStore() {
  await mkdir(dataDir, { recursive: true });
  const database = openDatabase();
  migrateSchema(database);

  if (hasStateRows(database)) return;

  const legacyState = await readLegacyState();
  writeStateToDatabase(database, legacyState ?? blankState(), {
    migratedFromJsonAt: legacyState ? new Date().toISOString() : undefined
  });
}

function openDatabase() {
  if (db) return db;
  db = new SqliteDatabase(databasePath) as SqliteConnection;
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA foreign_keys = ON");
  return db;
}

function migrateSchema(database: SqliteConnection) {
  database.exec(`
    CREATE TABLE IF NOT EXISTS app_meta (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS app_settings (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      data TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS source_health (
      site_id TEXT PRIMARY KEY,
      data TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS app_items (
      bucket TEXT NOT NULL,
      item_id TEXT NOT NULL,
      position INTEGER NOT NULL,
      data TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      PRIMARY KEY (bucket, item_id)
    );

    CREATE INDEX IF NOT EXISTS idx_app_items_bucket_position ON app_items(bucket, position);
  `);
  setMeta(database, "schemaVersion", "1");
}

function hasStateRows(database: SqliteConnection) {
  const settings = database.prepare("SELECT COUNT(*) AS count FROM app_settings").get()?.count;
  const items = database.prepare("SELECT COUNT(*) AS count FROM app_items").get()?.count;
  return Number(settings ?? 0) > 0 || Number(items ?? 0) > 0;
}

async function readLegacyState() {
  try {
    await access(legacyStorePath);
    const content = await readFile(legacyStorePath, "utf-8");
    return normalizeState(parseStoreContent(content));
  } catch {
    return undefined;
  }
}

function extractFirstJsonObject(content: string) {
  let depth = 0;
  let inString = false;
  let escaped = false;
  let started = false;

  for (let index = 0; index < content.length; index += 1) {
    const char = content[index];

    if (!started) {
      if (/\s/.test(char)) continue;
      if (char !== "{") return undefined;
      started = true;
      depth = 1;
      continue;
    }

    if (inString) {
      if (escaped) {
        escaped = false;
        continue;
      }
      if (char === "\\") {
        escaped = true;
        continue;
      }
      if (char === "\"") inString = false;
      continue;
    }

    if (char === "\"") {
      inString = true;
      continue;
    }
    if (char === "{" || char === "[") depth += 1;
    if (char === "}" || char === "]") depth -= 1;

    if (depth === 0) return content.slice(0, index + 1);
  }

  return undefined;
}

function parseStoreContent(content: string): Partial<AppState> {
  try {
    return JSON.parse(content) as Partial<AppState>;
  } catch {
    const recovered = extractFirstJsonObject(content);
    if (!recovered) throw new Error("store.json is not recoverable JSON");
    return JSON.parse(recovered) as Partial<AppState>;
  }
}

function normalizeState(parsed: Partial<AppState>): AppState {
  return {
    sites: parsed.sites?.length ? parsed.sites : defaultSites,
    sourceHealth: parsed.sourceHealth ?? {},
    settings: {
      sourceHealthCheckIntervalMinutes: parsed.settings?.sourceHealthCheckIntervalMinutes ?? 30,
      sourceHealthLastAutoCheckAt: parsed.settings?.sourceHealthLastAutoCheckAt,
      watchlistCheckIntervalMinutes: parsed.settings?.watchlistCheckIntervalMinutes ?? 30,
      watchlistLastAutoCheckAt: parsed.settings?.watchlistLastAutoCheckAt,
      ffmpegPath: parsed.settings?.ffmpegPath ?? "",
      ffmpegHlsSegmentSeconds: parsed.settings?.ffmpegHlsSegmentSeconds ?? 6,
      ffmpegReconnectDelaySeconds: parsed.settings?.ffmpegReconnectDelaySeconds ?? 5,
      ffmpegDownloadInputArgs: parsed.settings?.ffmpegDownloadInputArgs ?? "",
      ffmpegDownloadOutputArgs: parsed.settings?.ffmpegDownloadOutputArgs ?? "",
      ffmpegHlsInputArgs: parsed.settings?.ffmpegHlsInputArgs ?? "",
      ffmpegHlsOutputArgs: parsed.settings?.ffmpegHlsOutputArgs ?? "",
      m3u8DownloaderPath: parsed.settings?.m3u8DownloaderPath ?? "",
      m3u8DownloaderThreads: parsed.settings?.m3u8DownloaderThreads ?? 16,
      m3u8DownloaderRetryCount: parsed.settings?.m3u8DownloaderRetryCount ?? 6,
      m3u8DownloaderTimeoutSeconds: parsed.settings?.m3u8DownloaderTimeoutSeconds ?? 30,
      m3u8DownloaderHeaders: parsed.settings?.m3u8DownloaderHeaders ?? "",
      m3u8DownloaderProxy: parsed.settings?.m3u8DownloaderProxy ?? "",
      m3u8DownloaderMaxSpeed: parsed.settings?.m3u8DownloaderMaxSpeed ?? "",
      m3u8DownloaderMuxAfterDone: parsed.settings?.m3u8DownloaderMuxAfterDone ?? "",
      m3u8DownloaderExtraArgs: parsed.settings?.m3u8DownloaderExtraArgs ?? "",
      shareSmbUrl: parsed.settings?.shareSmbUrl ?? "",
      shareFtpUrl: parsed.settings?.shareFtpUrl ?? ""
    },
    watchlist: parsed.watchlist ?? [],
    downloads: parsed.downloads ?? [],
    hlsJobs: parsed.hlsJobs ?? [],
    library: parsed.library ?? [],
    notifications: parsed.notifications ?? [],
    scrapeHistory: parsed.scrapeHistory ?? [],
    trendingCache: parsed.trendingCache ?? [],
    trendingUpdatedAt: parsed.trendingUpdatedAt
  };
}

async function readStateUnchecked(): Promise<AppState> {
  await ensureStore();
  return readStateFromDatabase(openDatabase());
}

export async function readState(): Promise<AppState> {
  return readStateUnchecked();
}

function readStateFromDatabase(database: SqliteConnection): AppState {
  const settingsRow = database.prepare("SELECT data FROM app_settings WHERE id = 1").get();
  const sourceHealthRows = database.prepare("SELECT site_id, data FROM source_health ORDER BY site_id").all();
  const metaRows = database.prepare("SELECT key, value FROM app_meta").all();
  const settings = settingsRow?.data ? parseJson<AppSettings | undefined>(String(settingsRow.data), undefined) : undefined;
  const sourceHealth = Object.fromEntries(
    sourceHealthRows.flatMap((row) => {
      const value = parseJson(String(row.data), undefined as SourceHealthCheck | undefined);
      return value ? [[String(row.site_id), value] as const] : [];
    })
  ) as Record<string, SourceHealthCheck>;
  const partial: Partial<AppState> = {
    settings,
    sourceHealth
  };

  for (const bucket of bucketNames) {
    const rows = database.prepare("SELECT data FROM app_items WHERE bucket = ? ORDER BY position ASC").all(bucket);
    (partial as Record<string, unknown>)[bucket] = rows.map((row) => parseJson(String(row.data), undefined)).filter(Boolean);
  }

  const meta = Object.fromEntries(metaRows.map((row) => [String(row.key), String(row.value)]));
  partial.trendingUpdatedAt = meta.trendingUpdatedAt;
  return normalizeState(partial);
}

function parseJson<T>(value: string, fallback: T): T {
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}

function writeStateToDatabase(database: SqliteConnection, state: AppState, meta?: Record<string, string | undefined>) {
  const next = normalizeState(state);
  const now = new Date().toISOString();
  database.exec("BEGIN IMMEDIATE");
  try {
    database.prepare("DELETE FROM app_settings").run();
    database.prepare("INSERT INTO app_settings (id, data, updated_at) VALUES (1, ?, ?)").run(JSON.stringify(next.settings), now);

    database.prepare("DELETE FROM source_health").run();
    const insertHealth = database.prepare("INSERT INTO source_health (site_id, data, updated_at) VALUES (?, ?, ?)");
    for (const [siteId, value] of Object.entries(next.sourceHealth)) {
      insertHealth.run(siteId, JSON.stringify(value), now);
    }

    database.prepare("DELETE FROM app_items").run();
    const insertItem = database.prepare(
      "INSERT INTO app_items (bucket, item_id, position, data, updated_at) VALUES (?, ?, ?, ?, ?)"
    );
    for (const bucket of bucketNames) {
      const items = next[bucket];
      items.forEach((item, position) => {
        insertItem.run(bucket, itemKey(item, position), position, JSON.stringify(item), now);
      });
    }

    if (next.trendingUpdatedAt) setMeta(database, "trendingUpdatedAt", next.trendingUpdatedAt);
    else database.prepare("DELETE FROM app_meta WHERE key = ?").run("trendingUpdatedAt");
    for (const [key, value] of Object.entries(meta ?? {})) {
      if (value) setMeta(database, key, value);
    }
    setMeta(database, "schemaVersion", "1");
    database.exec("COMMIT");
  } catch (error) {
    database.exec("ROLLBACK");
    throw error;
  }
}

function setMeta(database: SqliteConnection, key: string, value: string) {
  database
    .prepare("INSERT INTO app_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value")
    .run(key, value);
}

function itemKey(item: unknown, position: number) {
  if (item && typeof item === "object" && "id" in item) {
    const id = (item as { id?: unknown }).id;
    if (typeof id === "string" && id) return id;
  }
  return `position-${position}`;
}

export async function writeState(state: AppState) {
  stateQueue = stateQueue.then(async () => {
    await ensureStore();
    writeStateToDatabase(openDatabase(), state);
  });
  return stateQueue;
}

export async function updateState(mutator: (state: AppState) => AppState | void) {
  const operation = stateQueue.then(async () => {
    const state = await readStateUnchecked();
    const next = mutator(state) ?? state;
    writeStateToDatabase(openDatabase(), next);
    return next;
  });
  stateQueue = operation.then(
    () => undefined,
    () => undefined
  );
  return operation;
}

export async function upsertSite(site: SourceSite) {
  return updateState((state) => {
    const index = state.sites.findIndex((item) => item.id === site.id);
    if (index >= 0) state.sites[index] = site;
    else state.sites.unshift(site);
  });
}

export async function removeSite(id: string) {
  return updateState((state) => {
    state.sites = state.sites.filter((site) => site.id !== id);
    delete state.sourceHealth[id];
  });
}

export async function upsertWatchItem(item: WatchItem) {
  return updateState((state) => {
    const index = state.watchlist.findIndex((entry) => entry.id === item.id);
    if (index >= 0) state.watchlist[index] = item;
    else state.watchlist.unshift(item);
  });
}

export async function removeWatchItem(id: string) {
  return updateState((state) => {
    state.watchlist = state.watchlist.filter((item) => item.id !== id);
  });
}

export async function upsertDownload(task: DownloadTask) {
  return updateState((state) => {
    const index = state.downloads.findIndex((entry) => entry.id === task.id);
    if (index >= 0) state.downloads[index] = task;
    else state.downloads.unshift(task);
  });
}

export async function removeDownload(id: string) {
  return updateState((state) => {
    state.downloads = state.downloads.filter((task) => task.id !== id);
  });
}

export async function upsertLocalHlsJob(job: LocalHlsJob) {
  return updateState((state) => {
    const index = state.hlsJobs.findIndex((entry) => entry.id === job.id);
    if (index >= 0) state.hlsJobs[index] = job;
    else state.hlsJobs.unshift(job);
  });
}

export async function addNotification(input: Omit<HubNotification, "id" | "read" | "createdAt">) {
  return updateState((state) => {
    state.notifications.unshift({
      id: `notice-${Date.now()}-${Math.random().toString(16).slice(2)}`,
      read: false,
      createdAt: new Date().toISOString(),
      ...input
    });
    state.notifications = state.notifications.slice(0, 80);
  });
}

export async function markNotificationsRead(ids?: string[]) {
  return updateState((state) => {
    const idSet = ids?.length ? new Set(ids) : undefined;
    state.notifications = state.notifications.map((notice) =>
      !idSet || idSet.has(notice.id) ? { ...notice, read: true } : notice
    );
  });
}

export async function clearReadNotifications(ids?: string[]) {
  return updateState((state) => {
    const idSet = ids?.length ? new Set(ids) : undefined;
    state.notifications = state.notifications.filter((notice) => !notice.read || (idSet && !idSet.has(notice.id)));
  });
}

export async function recordScrapeSnapshot(input: Omit<ScrapeSnapshot, "id" | "createdAt">) {
  return updateState((state) => {
    state.scrapeHistory.unshift({
      id: `scrape-${Date.now()}-${Math.random().toString(16).slice(2)}`,
      createdAt: new Date().toISOString(),
      ...input,
      items: input.items.slice(0, 80),
      errors: input.errors.slice(0, 12)
    });
    state.scrapeHistory = state.scrapeHistory.slice(0, 24);
  });
}

export async function setTrendingCache(items: CatalogItem[]) {
  return updateState((state) => {
    state.trendingCache = items.slice(0, 80);
    state.trendingUpdatedAt = new Date().toISOString();
  });
}
