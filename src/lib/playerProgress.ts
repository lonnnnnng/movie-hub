const PLAYER_PROGRESS_KEY_PREFIX = "movie-hub.player.progress.";
export const MAX_PLAYBACK_PROGRESS_ENTRIES = 60;

export const MIN_RESUME_SECONDS = 20;
export const END_CLEAR_SECONDS = 24;

export type PlaybackProgress = {
  time: number;
  duration: number;
  updatedAt: string;
  title?: string;
  source?: string;
};

export type PlaybackProgressEntry = PlaybackProgress & {
  key: string;
};

export function progressStorageKey(url: string) {
  return `${PLAYER_PROGRESS_KEY_PREFIX}${hashString(url)}`;
}

export function readPlaybackProgress(key: string) {
  try {
    const raw = window.localStorage.getItem(key);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<PlaybackProgress>;
    if (typeof parsed.time !== "number" || typeof parsed.duration !== "number") return null;
    if (!Number.isFinite(parsed.time) || !Number.isFinite(parsed.duration)) return null;
    return {
      time: parsed.time,
      duration: parsed.duration,
      updatedAt: typeof parsed.updatedAt === "string" ? parsed.updatedAt : "",
      title: typeof parsed.title === "string" ? parsed.title : undefined,
      source: typeof parsed.source === "string" ? parsed.source : undefined
    };
  } catch {
    return null;
  }
}

export function savePlaybackProgress(key: string, progress: PlaybackProgress) {
  try {
    window.localStorage.setItem(key, JSON.stringify(progress));
    prunePlaybackProgressEntries(MAX_PLAYBACK_PROGRESS_ENTRIES);
  } catch {
    // Playback memory is a convenience feature; restricted storage should not affect playback.
  }
}

export function clearPlaybackProgress(key: string) {
  try {
    window.localStorage.removeItem(key);
  } catch {
    // Ignore storage failures; playback should keep working.
  }
}

export function clearPlaybackProgressEntry(key: string) {
  if (!key.startsWith(PLAYER_PROGRESS_KEY_PREFIX)) return false;
  try {
    window.localStorage.removeItem(key);
    return true;
  } catch {
    return false;
  }
}

export function getPlaybackProgressSummary() {
  const entries = getPlaybackProgressEntries();
  return { count: entries.length, latestAt: entries[0]?.updatedAt ?? "", entries };
}

function getPlaybackProgressEntries(): PlaybackProgressEntry[] {
  if (typeof window === "undefined") return [];
  try {
    const entries: PlaybackProgressEntry[] = [];
    for (let index = 0; index < window.localStorage.length; index += 1) {
      const key = window.localStorage.key(index);
      if (!key?.startsWith(PLAYER_PROGRESS_KEY_PREFIX)) continue;
      const progress = readPlaybackProgress(key);
      if (progress) entries.push({ ...progress, key });
    }
    return entries.sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
  } catch {
    return [];
  }
}

export function clearAllPlaybackProgress() {
  if (typeof window === "undefined") return 0;
  try {
    const keys: string[] = [];
    for (let index = 0; index < window.localStorage.length; index += 1) {
      const key = window.localStorage.key(index);
      if (key?.startsWith(PLAYER_PROGRESS_KEY_PREFIX)) keys.push(key);
    }
    keys.forEach((key) => window.localStorage.removeItem(key));
    return keys.length;
  } catch {
    return 0;
  }
}

function prunePlaybackProgressEntries(limit = MAX_PLAYBACK_PROGRESS_ENTRIES) {
  if (typeof window === "undefined") return 0;
  try {
    const entries = getPlaybackProgressEntries();
    const staleEntries = entries.slice(Math.max(0, limit));
    staleEntries.forEach((entry) => window.localStorage.removeItem(entry.key));
    return staleEntries.length;
  } catch {
    return 0;
  }
}

export function formatDuration(seconds: number) {
  const total = Math.max(0, Math.floor(seconds));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const secs = total % 60;
  if (hours) return `${hours}:${String(minutes).padStart(2, "0")}:${String(secs).padStart(2, "0")}`;
  return `${minutes}:${String(secs).padStart(2, "0")}`;
}

function hashString(value: string) {
  let hash = 5381;
  for (let index = 0; index < value.length; index += 1) {
    hash = (hash * 33) ^ value.charCodeAt(index);
  }
  return (hash >>> 0).toString(36);
}
