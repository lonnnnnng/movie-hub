import { XMLParser } from "fast-xml-parser";
import type { CatalogItem, Episode, MediaKind, SourceSite } from "./types";
import { demoPosters } from "./defaults";
import { cleanDisplayText, cleanEpisodeName, safeSourceName } from "./text";

type CmsVod = Record<string, unknown>;

const xmlParser = new XMLParser({
  ignoreAttributes: false,
  cdataPropName: "__cdata",
  textNodeName: "__text"
});

const playablePattern = /^https?:\/\/.+\.(m3u8|mp4)(\?.*)?$/i;

function text(value: unknown): string | undefined {
  if (value == null) return undefined;
  if (typeof value === "object" && "__cdata" in value) {
    return text((value as Record<string, unknown>).__cdata);
  }
  if (typeof value === "object" && "__text" in value) {
    return text((value as Record<string, unknown>).__text);
  }
  const next = String(value).trim();
  return next || undefined;
}

function listOf<T>(value: T | T[] | undefined): T[] {
  if (value == null) return [];
  return Array.isArray(value) ? value : [value];
}

function inferKind(typeName?: string): MediaKind {
  const name = typeName ?? "";
  if (/动漫|动画|番/i.test(name)) return "anime";
  if (/综艺|真人秀/i.test(name)) return "variety";
  if (/剧|连续|电视|短剧/i.test(name)) return "series";
  if (/电影|片/i.test(name)) return "movie";
  return "unknown";
}

function sourceEndpoint(site: SourceSite, params: Record<string, string | number | undefined>) {
  const url = new URL(site.baseUrl);
  Object.entries(params).forEach(([key, value]) => {
    if (value !== undefined && value !== "") url.searchParams.set(key, String(value));
  });
  return url.toString();
}

function extractJsonList(payload: unknown): CmsVod[] {
  if (!payload || typeof payload !== "object") return [];
  const root = payload as Record<string, unknown>;
  const candidates = [
    root.list,
    root.data,
    root.vod,
    root?.rss && typeof root.rss === "object" ? (root.rss as Record<string, unknown>).list : undefined
  ];

  for (const candidate of candidates) {
    if (Array.isArray(candidate)) return candidate as CmsVod[];
    if (candidate && typeof candidate === "object") {
      const objectCandidate = candidate as Record<string, unknown>;
      if (Array.isArray(objectCandidate.video)) return objectCandidate.video as CmsVod[];
      if (objectCandidate.video) return [objectCandidate.video as CmsVod];
    }
  }

  return [];
}

function extractXmlList(payload: unknown): CmsVod[] {
  if (!payload || typeof payload !== "object") return [];
  const root = payload as Record<string, unknown>;
  const rss = root.rss as Record<string, unknown> | undefined;
  const list = rss?.list as Record<string, unknown> | undefined;
  return listOf(list?.video as CmsVod | CmsVod[] | undefined);
}

function parsePayload(body: string) {
  const trimmed = body.trim();
  if (!trimmed) return [];

  if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
    return extractJsonList(JSON.parse(trimmed));
  }

  const parsed = xmlParser.parse(trimmed);
  return extractXmlList(parsed);
}

function readField(vod: CmsVod, ...keys: string[]) {
  for (const key of keys) {
    const value = text(vod[key]);
    if (value) return value;
  }
  return undefined;
}

function readDisplayField(vod: CmsVod, ...keys: string[]) {
  for (const key of keys) {
    const value = readField(vod, key);
    const cleaned = cleanDisplayText(value);
    if (cleaned) return cleaned;
  }
  return undefined;
}

function cleanOptionalText(value?: string) {
  return cleanDisplayText(value) || undefined;
}

function normalizeUrl(raw?: string) {
  if (!raw) return undefined;
  const cleaned = raw.replace(/&amp;/g, "&").trim();
  if (/^\/\//.test(cleaned)) return `https:${cleaned}`;
  return cleaned;
}

function splitEpisodes(playUrl?: string, playFrom?: string, site?: SourceSite): Episode[] {
  if (!playUrl || !site) return [];
  const groups = playUrl.split("$$$");
  const fromGroups = playFrom?.split("$$$") ?? [];
  const sourceName = safeSourceName(site);

  return groups.flatMap((group, groupIndex) => {
    const playFromName = fromGroups[groupIndex] || fromGroups[0] || "online";
    return group
      .split("#")
      .map((entry, entryIndex) => {
        const [rawName, ...urlParts] = entry.split("$");
        const url = normalizeUrl(urlParts.join("$") || rawName);
        const fallbackName = `第 ${entryIndex + 1} 集`;
        const name = urlParts.length ? cleanEpisodeName(rawName.trim(), fallbackName) : fallbackName;
        if (!url || !playablePattern.test(url)) return undefined;

        return {
          id: `${site.id}-${groupIndex}-${entryIndex}-${Buffer.from(url).toString("base64url").slice(0, 12)}`,
          name: name || `第 ${entryIndex + 1} 集`,
          url,
          playFrom: playFromName,
          sourceId: site.id,
          sourceName
        } satisfies Episode;
      })
      .filter(Boolean) as Episode[];
  });
}

function normalizeVod(vod: CmsVod, site: SourceSite, index = 0): CatalogItem {
  const vodId = readField(vod, "vod_id", "id") ?? `${site.id}-${index}`;
  const sourceName = safeSourceName(site);
  const title = readDisplayField(vod, "vod_name", "name", "title") ?? "未命名影片";
  const typeName = readDisplayField(vod, "type_name", "type", "class");
  const poster = normalizeUrl(readField(vod, "vod_pic", "pic", "cover", "poster")) ?? demoPosters[index % demoPosters.length];
  const playUrl = readField(vod, "vod_play_url", "dl", "playurl", "url");
  const playFrom = readField(vod, "vod_play_from", "playfrom", "from");
  const episodes = splitEpisodes(playUrl, playFrom, site);

  return {
    id: `${site.id}-${vodId}`,
    sourceId: site.id,
    sourceName,
    vodId,
    title,
    originalTitle: readDisplayField(vod, "vod_sub", "subname"),
    kind: inferKind(typeName),
    poster,
    backdrop: normalizeUrl(readField(vod, "vod_pic_slide", "vod_blurb_pic", "backdrop")),
    year: readDisplayField(vod, "vod_year", "year"),
    area: readDisplayField(vod, "vod_area", "area"),
    language: readDisplayField(vod, "vod_lang", "lang"),
    typeName,
    actors: readDisplayField(vod, "vod_actor", "actor"),
    director: readDisplayField(vod, "vod_director", "director"),
    remarks: readDisplayField(vod, "vod_remarks", "remarks", "note"),
    description: cleanOptionalText(readField(vod, "vod_content", "content", "desc")?.replace(/<[^>]+>/g, "")),
    updatedAt: readDisplayField(vod, "vod_time", "time", "updated_at"),
    score: readDisplayField(vod, "vod_score", "score"),
    episodes
  };
}

async function fetchCms(url: string, signal?: AbortSignal) {
  const response = await fetch(url, {
    signal,
    headers: {
      "user-agent": "MovieHub/0.1 (+local-family-cinema)",
      accept: "application/json,text/xml,application/xml,text/plain,*/*"
    }
  });

  if (!response.ok) {
    throw new Error(`资源站响应 ${response.status}`);
  }

  return response.text();
}

async function runWithTimeout<T>(fn: (signal: AbortSignal) => Promise<T>, timeout = 9000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);
  try {
    return await fn(controller.signal);
  } finally {
    clearTimeout(timer);
  }
}

export async function searchSite(site: SourceSite, keyword: string, limit = 12): Promise<CatalogItem[]> {
  if (!site.enabled || !site.searchable) return [];

  const attempts = [
    sourceEndpoint(site, { ac: "detail", wd: keyword, pagesize: limit }),
    sourceEndpoint(site, { ac: "videolist", wd: keyword, pagesize: limit }),
    sourceEndpoint(site, { ac: "list", wd: keyword, pagesize: limit })
  ];

  let lastError: unknown;
  for (const url of attempts) {
    try {
      const body = await runWithTimeout((signal) => fetchCms(url, signal));
      const list = parsePayload(body).slice(0, limit);
      if (list.length) return list.map((vod, index) => normalizeVod(vod, site, index));
    } catch (error) {
      lastError = error;
    }
  }

  if (lastError instanceof Error) {
    throw new Error(`${safeSourceName(site)}: ${lastError.message}`);
  }
  return [];
}

export async function fetchTrendingFromSite(site: SourceSite, limit = 18): Promise<CatalogItem[]> {
  if (!site.enabled) return [];

  const attempts = [
    sourceEndpoint(site, { ac: "detail", pagesize: limit }),
    sourceEndpoint(site, { ac: "videolist", pagesize: limit }),
    sourceEndpoint(site, { ac: "list", pagesize: limit })
  ];

  for (const url of attempts) {
    try {
      const body = await runWithTimeout((signal) => fetchCms(url, signal));
      const list = parsePayload(body).slice(0, limit);
      if (list.length) return list.map((vod, index) => normalizeVod(vod, site, index));
    } catch {
      // Try the next endpoint flavor; CMS mirrors are not consistent.
    }
  }

  return [];
}

export async function fetchDetail(site: SourceSite, vodId: string): Promise<CatalogItem | undefined> {
  const url = sourceEndpoint(site, { ac: "detail", ids: vodId });
  const body = await runWithTimeout((signal) => fetchCms(url, signal));
  const [first] = parsePayload(body);
  return first ? normalizeVod(first, site, 0) : undefined;
}

export function siteHealthUrl(site: SourceSite) {
  return sourceEndpoint(site, { ac: "list", pagesize: 1 });
}
