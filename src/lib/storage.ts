import { useEffect, useRef, useState } from "react";

type StoredStateOptions<T> = {
  validate?: (value: unknown) => value is T;
};

export type StoredPreferenceImportResult = {
  imported: number;
  skipped: number;
  total: number;
};

const STORED_STATE_PREFIX = "movie-hub.";
const STORED_STATE_EXCLUDED_PREFIXES = ["movie-hub.player.progress."];

export function useStoredState<T>(key: string, fallback: T, options: StoredStateOptions<T> = {}) {
  const fallbackRef = useRef(fallback);
  const validateRef = useRef(options.validate);
  fallbackRef.current = fallback;
  validateRef.current = options.validate;
  const [stored, setStored] = useState(() => ({
    key,
    value: readStoredValue(key, fallbackRef.current, validateRef.current)
  }));

  useEffect(() => {
    setStored({
      key,
      value: readStoredValue(key, fallbackRef.current, validateRef.current)
    });
  }, [key]);

  useEffect(() => {
    if (stored.key !== key) return;
    try {
      window.localStorage.setItem(stored.key, JSON.stringify(stored.value));
    } catch {
      // Storage can be unavailable in private browsing or restricted WebViews.
    }
  }, [key, stored]);

  function setValue(next: T | ((value: T) => T)) {
    setStored((current) => ({
      key,
      value: typeof next === "function" ? (next as (value: T) => T)(current.key === key ? current.value : fallbackRef.current) : next
    }));
  }

  return [stored.value, setValue] as const;
}

export function getStoredPreferenceSummary() {
  const entries = getStoredPreferenceEntries();
  return { count: entries.length, entries };
}

export function clearStoredPreferences() {
  if (typeof window === "undefined") return 0;
  try {
    const entries = getStoredPreferenceEntries();
    entries.forEach((entry) => window.localStorage.removeItem(entry.key));
    return entries.length;
  } catch {
    return 0;
  }
}

export function createStoredPreferenceExport() {
  const entries = getStoredPreferenceEntries();
  const values: Record<string, unknown> = {};
  for (const entry of entries) {
    values[entry.key] = readRawStoredValue(entry.key);
  }
  return {
    format: "movie-hub-local-preferences",
    exportedAt: new Date().toISOString(),
    count: entries.length,
    entries: values
  };
}

export function importStoredPreferences(payload: unknown): StoredPreferenceImportResult {
  if (typeof window === "undefined") return { imported: 0, skipped: 0, total: 0 };
  const entries = extractPreferenceValues(payload);
  if (!entries) return { imported: 0, skipped: 0, total: 0 };
  let imported = 0;
  let skipped = 0;
  for (const [key, value] of Object.entries(entries)) {
    if (!isStoredPreferenceKey(key)) {
      skipped += 1;
      continue;
    }
    try {
      window.localStorage.setItem(key, JSON.stringify(value));
      imported += 1;
    } catch {
      skipped += 1;
    }
  }
  return { imported, skipped, total: imported + skipped };
}

function getStoredPreferenceEntries() {
  if (typeof window === "undefined") return [] as Array<{ key: string; label: string }>;
  try {
    const entries: Array<{ key: string; label: string }> = [];
    for (let index = 0; index < window.localStorage.length; index += 1) {
      const key = window.localStorage.key(index);
      if (!key || !isStoredPreferenceKey(key)) continue;
      entries.push({ key, label: preferenceLabel(key) });
    }
    return entries.sort((left, right) => left.label.localeCompare(right.label, "zh-CN"));
  } catch {
    return [];
  }
}

function readStoredValue<T>(key: string, fallback: T, validate?: (value: unknown) => value is T) {
  if (typeof window === "undefined") return fallback;
  try {
    const raw = window.localStorage.getItem(key);
    if (raw == null) return fallback;
    const parsed = JSON.parse(raw) as unknown;
    return validate ? (validate(parsed) ? parsed : fallback) : (parsed as T);
  } catch {
    return fallback;
  }
}

function readRawStoredValue(key: string) {
  try {
    const raw = window.localStorage.getItem(key);
    return raw == null ? null : (JSON.parse(raw) as unknown);
  } catch {
    return null;
  }
}

function isStoredPreferenceKey(key: string) {
  return key.startsWith(STORED_STATE_PREFIX) && !STORED_STATE_EXCLUDED_PREFIXES.some((prefix) => key.startsWith(prefix));
}

function extractPreferenceValues(payload: unknown) {
  if (!isPlainRecord(payload)) return null;
  const candidate = isPlainRecord(payload.entries) ? payload.entries : payload;
  return Object.keys(candidate).some((key) => isStoredPreferenceKey(key)) ? candidate : null;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function preferenceLabel(key: string) {
  const withoutPrefix = key.slice(STORED_STATE_PREFIX.length);
  const [area, ...rest] = withoutPrefix.split(".");
  const areaName =
    {
      downloads: "下载管理",
      library: "本地片库",
      player: "播放器",
      settings: "系统设置",
      share: "共享中心",
      sources: "资源站",
      tracking: "剧集追踪"
    }[area] ?? area;
  return rest.length ? `${areaName} · ${rest.join(".")}` : areaName;
}
