import type { SourceSite } from "./types";

const genericHostLabels = new Set(["api", "caiji", "cj", "collect", "m3u8", "www", "xsd", "zy"]);
const mojibakePattern =
  /璧勬簮|澶囦唤|鎭㈠|涓嬭浇|鍔犲叆|鏈湴|濯掍綋|鐩綍|鏃犳硶|杩愯|瀵煎叆|褰撳墠|绯荤粺|銆|锛|锟斤拷/u;

export function hasCorruptText(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const text = value.trim();
  if (!text) return false;
  if (/[\uFFFD]/u.test(text)) return true;
  if (text.includes("\u951f") || text.includes("\u65a4\u62f7")) return true;
  if (mojibakePattern.test(text)) return true;
  if (/\?{2,}/.test(text)) return true;
  if (/^\?+\d+\?$/.test(text)) return true;
  if (/^\?+$/.test(text)) return true;
  return false;
}

export function cleanDisplayText(value: unknown, fallback = "") {
  const text = typeof value === "string" ? value.trim() : "";
  if (text && !hasCorruptText(text)) return text;
  return fallback.trim();
}

function hostFromUrl(value: string) {
  try {
    const url = new URL(value.trim());
    return url.hostname.toLowerCase();
  } catch {
    return "";
  }
}

function unwrapProxyUrl(value: string) {
  try {
    const url = new URL(value.trim());
    for (const key of ["url", "api", "u"]) {
      const nested = url.searchParams.get(key);
      if (nested && /^https?:\/\//i.test(nested)) return nested;
    }
    return value;
  } catch {
    return value;
  }
}

export function siteNameFromUrl(value: string, fallback = "资源站") {
  const host = hostFromUrl(unwrapProxyUrl(value));
  if (!host) return fallback;
  const labels = host.split(".").filter(Boolean);
  const meaningful = labels.find((label) => !genericHostLabels.has(label) && label !== "com" && label !== "net" && label !== "org" && label !== "cc");
  const raw = meaningful ?? labels[0] ?? "";
  const cleaned = raw.replace(/[^a-z0-9_-]/gi, "").trim();
  return cleaned || fallback;
}

export function safeSourceName(site: Pick<SourceSite, "name" | "baseUrl">) {
  return cleanDisplayText(site.name, siteNameFromUrl(site.baseUrl));
}

export function cleanEpisodeName(value: unknown, fallback = "") {
  const raw = typeof value === "string" ? value : "";
  const match = raw.match(/\?+(\d+)\?+/) ?? fallback.match(/\?+(\d+)\?+/);
  if (match) return `第${match[1]}集`;
  const cleaned = cleanDisplayText(value, fallback);
  if (cleaned && !hasCorruptText(cleaned)) return cleaned;
  return fallback;
}
