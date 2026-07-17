import { demoPosters } from "./defaults";
import type { CatalogItem, MediaKind } from "./types";

type DoubanSubject = {
  id?: string;
  title?: string;
  rate?: string;
  cover?: string;
  url?: string;
  episodes_info?: string;
  is_new?: boolean;
  playable?: boolean;
};

type DoubanSuggestSubject = {
  id?: string;
  title?: string;
  img?: string;
  url?: string;
  type?: string;
  sub_title?: string;
  year?: string;
};

type DoubanShelf = {
  type: "movie" | "tv";
  kind: MediaKind;
  referer: string;
};

const shelves: DoubanShelf[] = [
  { type: "movie", kind: "movie", referer: "https://movie.douban.com/explore" },
  { type: "tv", kind: "series", referer: "https://movie.douban.com/tv/" }
];

function text(value: unknown) {
  if (value == null) return undefined;
  const next = String(value).trim();
  return next || undefined;
}

function normalizeUrl(value?: string) {
  const url = text(value)?.replace(/\\\//g, "/");
  if (!url) return undefined;
  if (url.startsWith("//")) return `https:${url}`;
  return url;
}

function doubanEndpoint(type: DoubanShelf["type"], limit: number, start = 0) {
  const url = new URL("https://movie.douban.com/j/search_subjects");
  url.searchParams.set("type", type);
  url.searchParams.set("tag", "热门");
  url.searchParams.set("sort", "recommend");
  url.searchParams.set("page_limit", String(limit));
  url.searchParams.set("page_start", String(start));
  return url.toString();
}

async function runWithTimeout<T>(fn: (signal: AbortSignal) => Promise<T>, timeout = 6500) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);
  try {
    return await fn(controller.signal);
  } finally {
    clearTimeout(timer);
  }
}

async function fetchDoubanShelf(shelf: DoubanShelf, limit: number, start = 0) {
  const url = doubanEndpoint(shelf.type, limit, start);
  const payload = await runWithTimeout(async (signal) => {
    const response = await fetch(url, {
      signal,
      headers: {
        "user-agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125 Safari/537.36",
        referer: shelf.referer,
        accept: "application/json,text/plain,*/*"
      }
    });

    if (!response.ok) {
      throw new Error(`豆瓣热门响应 ${response.status}`);
    }

    return (await response.json()) as { subjects?: DoubanSubject[] };
  });

  return (payload.subjects ?? [])
    .map((subject, index) => normalizeDoubanSubject(subject, shelf.kind, index))
    .filter((item): item is CatalogItem => Boolean(item));
}

function normalizeDoubanSubject(subject: DoubanSubject, kind: MediaKind, index: number): CatalogItem | undefined {
  const title = text(subject.title);
  if (!title) return undefined;

  const doubanId = text(subject.id) ?? `${kind}-${index}-${encodeURIComponent(title)}`;
  const poster = normalizeUrl(subject.cover) ?? demoPosters[index % demoPosters.length];
  const score = text(subject.rate);
  const episodesInfo = text(subject.episodes_info);

  return {
    id: `douban-${kind}-${doubanId}`,
    sourceId: "douban",
    sourceName: "豆瓣热门",
    vodId: `${kind}-${doubanId}`,
    title,
    kind,
    poster,
    backdrop: poster,
    remarks: episodesInfo ?? (score ? `豆瓣 ${score}` : subject.is_new ? "豆瓣新热" : "豆瓣热门"),
    description: normalizeUrl(subject.url),
    score,
    episodes: [],
    raw: {
      doubanId,
      doubanUrl: normalizeUrl(subject.url),
      playable: Boolean(subject.playable)
    }
  };
}

function normalizeDoubanSuggestSubject(subject: DoubanSuggestSubject, index: number): CatalogItem | undefined {
  const title = text(subject.title);
  if (!title) return undefined;

  const rawType = text(subject.type);
  const kind: MediaKind = rawType?.toLowerCase().includes("tv") ? "series" : "movie";
  const doubanId = text(subject.id) ?? `${kind}-${index}-${encodeURIComponent(title)}`;
  const poster = normalizeUrl(subject.img) ?? demoPosters[index % demoPosters.length];
  const subTitle = text(subject.sub_title);

  return {
    id: `douban-${kind}-${doubanId}`,
    sourceId: "douban",
    sourceName: "豆瓣",
    vodId: `${kind}-${doubanId}`,
    title,
    originalTitle: subTitle,
    kind,
    poster,
    backdrop: poster,
    year: text(subject.year),
    remarks: subTitle ?? text(subject.year) ?? "豆瓣条目",
    description: normalizeUrl(subject.url),
    episodes: [],
    raw: {
      doubanId,
      doubanUrl: normalizeUrl(subject.url),
      suggestType: rawType
    }
  };
}

function interleave<T>(groups: T[][]) {
  const merged: T[] = [];
  const maxLength = Math.max(0, ...groups.map((group) => group.length));
  for (let index = 0; index < maxLength; index += 1) {
    for (const group of groups) {
      const item = group[index];
      if (item) merged.push(item);
    }
  }
  return merged;
}

function uniqueByDoubanId(items: CatalogItem[]) {
  const seen = new Set<string>();
  return items.filter((item) => {
    const key = item.vodId || item.title;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

export async function fetchDoubanTrendingPage(page = 1, pageSize = 20): Promise<{
  items: CatalogItem[];
  page: number;
  pageSize: number;
  hasMore: boolean;
}> {
  const safePage = Math.max(1, Math.floor(page));
  const safePageSize = Math.max(1, Math.min(60, Math.floor(pageSize)));
  const perShelfLimit = Math.max(4, Math.ceil(safePageSize / shelves.length));
  const start = (safePage - 1) * perShelfLimit;
  const settled = await Promise.allSettled(shelves.map((shelf) => fetchDoubanShelf(shelf, perShelfLimit, start)));
  const groups = settled.map((entry) => (entry.status === "fulfilled" ? entry.value : []));
  const items = uniqueByDoubanId(interleave(groups)).slice(0, safePageSize);

  if (!items.length) {
    const reason = settled.find((entry): entry is PromiseRejectedResult => entry.status === "rejected")?.reason;
    throw reason instanceof Error ? reason : new Error("豆瓣热门暂时不可用");
  }

  return {
    items,
    page: safePage,
    pageSize: safePageSize,
    hasMore: items.length === safePageSize
  };
}

export async function fetchDoubanTrending(limit = 24): Promise<CatalogItem[]> {
  const perShelfLimit = Math.max(8, Math.ceil(limit / shelves.length));
  const settled = await Promise.allSettled(shelves.map((shelf) => fetchDoubanShelf(shelf, perShelfLimit)));
  const groups = settled.map((entry) => (entry.status === "fulfilled" ? entry.value : []));
  const items = uniqueByDoubanId(interleave(groups)).slice(0, limit);

  if (!items.length) {
    const reason = settled.find((entry): entry is PromiseRejectedResult => entry.status === "rejected")?.reason;
    throw reason instanceof Error ? reason : new Error("豆瓣热门暂时不可用");
  }

  return items;
}

export async function searchDoubanSubjects(keyword: string, limit = 24): Promise<CatalogItem[]> {
  const query = text(keyword);
  if (!query) return [];

  const url = new URL("https://movie.douban.com/j/subject_suggest");
  url.searchParams.set("q", query);

  const payload = await runWithTimeout(async (signal) => {
    const response = await fetch(url, {
      signal,
      headers: {
        "user-agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125 Safari/537.36",
        referer: "https://movie.douban.com/",
        accept: "application/json,text/plain,*/*"
      }
    });

    if (!response.ok) {
      throw new Error(`豆瓣搜索响应 ${response.status}`);
    }

    return (await response.json()) as DoubanSuggestSubject[];
  });

  return payload
    .map((subject, index) => normalizeDoubanSuggestSubject(subject, index))
    .filter((item): item is CatalogItem => Boolean(item))
    .slice(0, limit);
}
