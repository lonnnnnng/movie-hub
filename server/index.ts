import express from "express";
import morgan from "morgan";
import { createReadStream, existsSync } from "node:fs";
import { readFile, readdir, stat } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { cancelDownloadTask, createDownloadTask, resumeDownloadTask } from "./downloader";
import { fetchDetail, fetchTrendingFromSite, searchSite, siteHealthUrl } from "./cms";
import { fetchDoubanTrending, fetchDoubanTrendingPage, searchDoubanSubjects } from "./douban";
import { getReadOnlyFtpShareState, startReadOnlyFtpShare } from "./ftp";
import { getEmbyStatus, syncAllCompletedDownloads } from "./emby";
import { inspectFfmpeg } from "./ffmpeg";
import { buildLocalHls, getLanUrls, scanLibrary, streamLocalVideo } from "./library";
import { inspectFfprobe } from "./ffprobe";
import { inspectNm3u8DlRe } from "./nm3u8dl";
import { hlsDir, legacyHlsDir, mediaDir } from "./paths";
import { extractSubscriptionVodSources } from "./subscription";
import { cleanDisplayText, hasCorruptText, safeSourceName, siteNameFromUrl } from "./text";
import {
  addNotification,
  clearReadNotifications,
  markNotificationsRead,
  recordScrapeSnapshot,
  readState,
  removeDownload,
  removeSite,
  removeWatchItem,
  setTrendingCache,
  updateState,
  writeState,
  upsertSite,
  upsertWatchItem
} from "./store";
import type {
  AppState,
  CatalogItem,
  Episode,
  SourceHealthCheck,
  SourceMatchResponse,
  SourceRoute,
  SourceRouteMetric,
  SourceRouteProbe,
  SourceSite,
  RuntimeDiagnosticCheck,
  RuntimeStatusResponse,
  ShareProtocolInfo,
  ShareSummary,
  ToolStatus,
  ToolsStatusResponse,
  WatchItem
} from "./types";

const app = express();
const port = Number(process.env.PORT ?? 8787);
const webPort = Number(process.env.WEB_PORT ?? 5173);
const appVersion = "0.1.0";
const startedAt = new Date().toISOString();
const runtimeLogFile = path.resolve("var", "movie-hub.log");

app.use(express.json({ limit: "10mb" }));
app.use(morgan("tiny"));

app.use((_, res, next) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Range");
  res.setHeader("Access-Control-Allow-Methods", "GET,HEAD,POST,PUT,DELETE,OPTIONS,PROPFIND");
  next();
});

app.use((req, res, next) => {
  if (req.method === "OPTIONS") {
    res.sendStatus(204);
    return;
  }
  next();
});

const siteSchema = z.object({
  name: z.string().min(1),
  baseUrl: z.string().url(),
  enabled: z.boolean().default(true),
  apiStyle: z.enum(["maccms-json", "maccms-xml", "auto"]).default("auto"),
  searchable: z.boolean().default(true),
  notes: z.string().optional()
});

const siteSubscriptionSchema = z.object({
  url: z.string().url(),
  enabled: z.boolean().default(true),
  searchable: z.boolean().default(true),
  apiStyle: z.enum(["maccms-json", "maccms-xml", "auto"]).default("auto")
});

const settingsSchema = z.object({
  sourceHealthCheckIntervalMinutes: z.coerce.number().int().min(1).max(1440).optional(),
  watchlistCheckIntervalMinutes: z.coerce.number().int().min(1).max(1440).optional(),
  ffmpegPath: z.string().trim().max(1000).optional(),
  ffmpegHlsSegmentSeconds: z.coerce.number().int().min(2).max(30).optional(),
  ffmpegReconnectDelaySeconds: z.coerce.number().int().min(1).max(60).optional(),
  ffmpegDownloadInputArgs: z.string().trim().max(3000).optional(),
  ffmpegDownloadOutputArgs: z.string().trim().max(3000).optional(),
  ffmpegHlsInputArgs: z.string().trim().max(3000).optional(),
  ffmpegHlsOutputArgs: z.string().trim().max(3000).optional(),
  m3u8DownloaderPath: z.string().trim().max(1000).optional(),
  m3u8DownloaderThreads: z.coerce.number().int().min(1).max(64).optional(),
  m3u8DownloaderRetryCount: z.coerce.number().int().min(1).max(20).optional(),
  m3u8DownloaderTimeoutSeconds: z.coerce.number().int().min(5).max(120).optional(),
  m3u8DownloaderHeaders: z.string().trim().max(3000).optional(),
  m3u8DownloaderProxy: z.string().trim().max(500).optional(),
  m3u8DownloaderMaxSpeed: z.string().trim().max(32).optional(),
  m3u8DownloaderMuxAfterDone: z.string().trim().max(500).optional(),
  m3u8DownloaderExtraArgs: z.string().trim().max(3000).optional(),
  shareSmbUrl: z.string().trim().max(500).optional(),
  shareFtpUrl: z.string().trim().max(500).optional(),
  embyEnabled: z.boolean().optional(),
  embyOutputDir: z.string().trim().max(1000).optional(),
  embyBaseUrl: z.string().trim().max(2048).optional(),
  embyServerUrl: z.string().trim().max(2048).optional(),
  embyApiKey: z.string().trim().max(2048).optional(),
  embySyncOnDownload: z.boolean().optional()
});

function uniqueCatalogItems(items: CatalogItem[]) {
  const seen = new Set<string>();
  return items.filter((item) => {
    const key = `${item.sourceId}-${item.vodId}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function normalizeSourceUrl(value: string) {
  try {
    const url = new URL(value.trim());
    url.hash = "";
    url.pathname = url.pathname.replace(/\/+$/, "") || "/";
    return url.toString().replace(/\/+$/, "");
  } catch {
    return value.trim().replace(/\/+$/, "");
  }
}

function cleanOptionalDisplayText(value: string | undefined, fallback = "") {
  if (value == null) return value;
  return cleanDisplayText(value, fallback);
}

function normalizeSiteDisplayInput<T extends { name: string; baseUrl: string; notes?: string }>(site: T): T {
  const fallbackName = siteNameFromUrl(site.baseUrl);
  return {
    ...site,
    name: cleanDisplayText(site.name, fallbackName) || fallbackName,
    notes: cleanOptionalDisplayText(site.notes)
  };
}

function cleanImportedSourceName(name: string, baseUrl: string) {
  const cleaned = name
    .replace(/^\s*\[采\]\s*/u, "")
    .replace(/^\s*[🎬🔞\-\s]+/u, "")
    .replace(/[\-\s]+$/u, "")
    .trim();
  return cleanDisplayText(cleaned || name.trim(), siteNameFromUrl(baseUrl));
}

function titleKey(title: string) {
  return title
    .toLocaleLowerCase("zh-CN")
    .replace(/[\s《》“”"'.,，。:：;；!！?？·\-_/\\()[\]（）【】]+/g, "");
}

function uniqueCatalogTitles(items: CatalogItem[]) {
  const seen = new Set<string>();
  return items.filter((item) => {
    const key = titleKey(item.title) || `${item.sourceId}-${item.vodId}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function sameTitle(left: string, right: string) {
  const leftKey = titleKey(left);
  return Boolean(leftKey && leftKey === titleKey(right));
}

function mergeDoubanMetadata(sourceItem: CatalogItem, doubanItem: CatalogItem): CatalogItem {
  return {
    ...sourceItem,
    poster: doubanItem.poster ?? sourceItem.poster,
    backdrop: sourceItem.backdrop ?? doubanItem.backdrop ?? doubanItem.poster,
    score: sourceItem.score ?? doubanItem.score,
    remarks: sourceItem.remarks ?? doubanItem.remarks,
    description: sourceItem.description ?? doubanItem.description
  };
}

function textKey(value?: string) {
  return titleKey(value ?? "");
}

function isLikelyMatch(candidate: CatalogItem, subject: CatalogItem) {
  const candidateTitle = textKey(candidate.title);
  const subjectTitle = textKey(subject.title);
  const subjectOriginalTitle = textKey(subject.originalTitle);
  if (!candidateTitle || !subjectTitle) return false;
  return (
    candidateTitle === subjectTitle ||
    Boolean(subjectOriginalTitle && candidateTitle === subjectOriginalTitle) ||
    candidateTitle.includes(subjectTitle) ||
    subjectTitle.includes(candidateTitle)
  );
}

function pickBestCandidate(candidates: CatalogItem[], subject: CatalogItem) {
  return candidates
    .filter((candidate) => isLikelyMatch(candidate, subject))
    .sort((left, right) => {
      const leftExact = sameTitle(left.title, subject.title) ? 1 : 0;
      const rightExact = sameTitle(right.title, subject.title) ? 1 : 0;
      return rightExact - leftExact || right.episodes.length - left.episodes.length;
    })[0];
}

function inferQuality(item?: CatalogItem) {
  const value = `${item?.title ?? ""} ${item?.remarks ?? ""} ${item?.typeName ?? ""} ${item?.episodes.map((episode) => `${episode.name} ${episode.url}`).join(" ") ?? ""}`;
  if (/4k|2160|uhd|超清|蓝光|原盘/i.test(value)) return { label: "超清/4K", score: 100 };
  if (/1080|fhd|高清|hd/i.test(value)) return { label: "高清", score: 82 };
  if (/720/i.test(value)) return { label: "标清+", score: 66 };
  if (/tc|ts|cam|枪版|抢先/i.test(value)) return { label: "抢先版", score: 24 };
  if (item?.episodes.length) return { label: "普通", score: 54 };
  return { label: "未知", score: 0 };
}

function scoreProbe(probe: SourceRouteProbe) {
  if (!probe.playable) return 0;
  const latencyScore = probe.latencyMs == null ? 5 : Math.max(0, Math.min(10, 10 - probe.latencyMs / 500));
  const speedScore = probe.speedKbps == null ? 5 : Math.max(0, Math.min(16, probe.speedKbps / 180));
  const stabilityBonus = probe.stability === "smooth" ? 4 : probe.stability === "ok" ? 2 : probe.stability === "risky" ? -2 : 0;
  return Math.round(latencyScore + speedScore + stabilityBonus);
}

function metricTone(score: number): SourceRouteMetric["tone"] {
  if (score >= 72) return "good";
  if (score >= 40) return "warn";
  if (score > 0) return "bad";
  return "muted";
}

function latencyScore(latencyMs?: number) {
  if (latencyMs == null) return 20;
  if (latencyMs <= 900) return 100;
  if (latencyMs <= 1600) return 82;
  if (latencyMs <= 2800) return 58;
  if (latencyMs <= 4500) return 32;
  return 12;
}

function speedScore(speedKbps?: number) {
  if (speedKbps == null) return 20;
  if (speedKbps >= 2800) return 100;
  if (speedKbps >= 1500) return 82;
  if (speedKbps >= 700) return 58;
  if (speedKbps >= 280) return 32;
  return 12;
}

function stabilityScore(stability: SourceRouteProbe["stability"]) {
  return {
    smooth: 100,
    ok: 78,
    risky: 38,
    unknown: 20,
    failed: 0
  }[stability];
}

function freshnessScore(updatedAt?: string) {
  if (!updatedAt) return 46;
  const time = new Date(updatedAt).getTime();
  if (Number.isNaN(time)) return 46;
  const ageDays = (Date.now() - time) / 86_400_000;
  if (ageDays <= 7) return 100;
  if (ageDays <= 30) return 82;
  if (ageDays <= 120) return 58;
  return 34;
}

function matchScore(candidate: CatalogItem | undefined, subject: CatalogItem) {
  if (!candidate) return 0;
  if (sameTitle(candidate.title, subject.title)) return 100;
  return isLikelyMatch(candidate, subject) ? 70 : 30;
}

function buildRouteMetrics(route: Pick<SourceRoute, "enabled" | "hasResource" | "playable" | "episodeCount" | "quality" | "probe" | "item" | "status">, subject: CatalogItem): SourceRouteMetric[] {
  const latestName = route.item?.episodes.at(-1)?.name;
  const metrics: SourceRouteMetric[] = [
    {
      key: "availability",
      label: "可用性",
      value: route.playable ? "可播放" : route.hasResource ? "有资源未通过" : route.enabled ? "未命中" : "已停用",
      score: route.playable ? 100 : route.hasResource ? 42 : 0,
      tone: route.playable ? "good" : route.hasResource ? "warn" : "bad",
      description: route.probe.message
    },
    {
      key: "latency",
      label: "访问延迟",
      value: route.probe.latencyMs == null ? "未知" : `${route.probe.latencyMs} ms`,
      score: latencyScore(route.probe.latencyMs),
      tone: metricTone(latencyScore(route.probe.latencyMs))
    },
    {
      key: "episodes",
      label: "更新集数",
      value: route.episodeCount ? `${route.episodeCount} 集${latestName ? ` / ${latestName}` : ""}` : "无分集",
      score: Math.min(100, route.episodeCount * 8),
      tone: metricTone(Math.min(100, route.episodeCount * 8))
    },
    {
      key: "speed",
      label: "播放速度",
      value: route.probe.speedKbps == null ? "未知" : `${Math.round(route.probe.speedKbps)} kbps`,
      score: speedScore(route.probe.speedKbps),
      tone: metricTone(speedScore(route.probe.speedKbps))
    },
    {
      key: "stability",
      label: "卡顿风险",
      value: {
        smooth: "流畅",
        ok: "基本稳定",
        risky: "可能卡顿",
        unknown: "未知",
        failed: "不可播放"
      }[route.probe.stability],
      score: stabilityScore(route.probe.stability),
      tone: metricTone(stabilityScore(route.probe.stability))
    },
    {
      key: "quality",
      label: "清晰度",
      value: route.quality.label,
      score: route.quality.score,
      tone: metricTone(route.quality.score)
    },
    {
      key: "freshness",
      label: "更新新鲜度",
      value: route.item?.updatedAt ?? "未知",
      score: freshnessScore(route.item?.updatedAt),
      tone: metricTone(freshnessScore(route.item?.updatedAt))
    },
    {
      key: "match",
      label: "标题匹配",
      value: route.item ? route.item.title : "无匹配",
      score: matchScore(route.item, subject),
      tone: metricTone(matchScore(route.item, subject))
    },
    {
      key: "reliability",
      label: "综合可靠性",
      value: route.status === "available" ? "推荐候选" : route.status === "failed" ? "探测失败" : route.status === "missing" ? "无匹配资源" : "不可用",
      score: route.playable ? Math.round((latencyScore(route.probe.latencyMs) + speedScore(route.probe.speedKbps) + stabilityScore(route.probe.stability)) / 3) : 0,
      tone: route.playable ? metricTone(Math.round((latencyScore(route.probe.latencyMs) + speedScore(route.probe.speedKbps) + stabilityScore(route.probe.stability)) / 3)) : "bad"
    }
  ];
  return metrics;
}

function scoreRoute(item: CatalogItem | undefined, probe: SourceRouteProbe) {
  if (!item) return 0;
  const quality = inferQuality(item);
  const episodeScore = Math.min(20, item.episodes.length * 2);
  const playableScore = probe.playable ? 25 : 0;
  const resourceScore = 20;
  return Math.max(0, Math.min(100, resourceScore + playableScore + episodeScore + Math.round(quality.score * 0.18) + scoreProbe(probe)));
}

function routeReasons(route: Pick<SourceRoute, "hasResource" | "playable" | "episodeCount" | "quality" | "probe">) {
  const reasons: string[] = [];
  if (!route.hasResource) return ["未搜索到匹配片源"];
  reasons.push(`更新到 ${route.episodeCount} 集`);
  reasons.push(`清晰度：${route.quality.label}`);
  if (route.playable) reasons.push("抽样播放正常");
  if (route.probe.latencyMs != null) reasons.push(`延迟 ${route.probe.latencyMs}ms`);
  if (route.probe.speedKbps != null) reasons.push(`抽样速度 ${Math.round(route.probe.speedKbps)}kbps`);
  if (route.probe.stability === "smooth") reasons.push("播放稳定性较好");
  if (route.probe.stability === "risky") reasons.push("速度偏慢，可能卡顿");
  return reasons;
}

async function runProbeFetch(url: string, init: RequestInit = {}, timeout = 4500) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);
  const startedAt = performance.now();
  try {
    const response = await fetch(url, {
      ...init,
      signal: controller.signal,
      headers: {
        "user-agent": "MovieHub/0.1 (+route-probe)",
        accept: "*/*",
        ...(init.headers ?? {})
      }
    });
    const latencyMs = Math.round(performance.now() - startedAt);
    return { response, latencyMs, startedAt };
  } finally {
    clearTimeout(timer);
  }
}

async function readSampleBytes(response: Response, maxBytes = 256 * 1024) {
  if (!response.body) return 0;
  const reader = response.body.getReader();
  let total = 0;
  try {
    while (total < maxBytes) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
    }
  } finally {
    await reader.cancel().catch(() => undefined);
  }
  return total;
}

function firstPlaylistMediaLine(body: string) {
  return body
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find((line) => line && !line.startsWith("#"));
}

function probeStability(playable: boolean, latencyMs?: number, speedKbps?: number): SourceRouteProbe["stability"] {
  if (!playable) return "failed";
  if (latencyMs == null || speedKbps == null) return "unknown";
  if (latencyMs <= 1600 && speedKbps >= 1500) return "smooth";
  if (latencyMs <= 2800 && speedKbps >= 700) return "ok";
  return "risky";
}

async function probeBytes(url: string) {
  const { response, latencyMs, startedAt } = await runProbeFetch(
    url,
    {
      headers: {
        range: "bytes=0-262143"
      }
    },
    5000
  );
  if (!response.ok && response.status !== 206) {
    throw new Error(`播放探测响应 ${response.status}`);
  }
  const bytes = await readSampleBytes(response);
  const elapsedSeconds = Math.max(0.001, (performance.now() - startedAt) / 1000);
  return { latencyMs, speedKbps: (bytes * 8) / 1024 / elapsedSeconds };
}

async function probeEpisode(episode?: Episode): Promise<SourceRouteProbe> {
  const checkedAt = new Date().toISOString();
  if (!episode) {
    return {
      playable: false,
      stability: "failed",
      message: "没有可探测的分集",
      checkedAt
    };
  }

  try {
    if (/\.m3u8(\?|$)/i.test(episode.url)) {
      const playlist = await runProbeFetch(
        episode.url,
        {
          headers: {
            accept: "application/vnd.apple.mpegurl,application/x-mpegURL,*/*"
          }
        },
        4500
      );
      if (!playlist.response.ok) throw new Error(`m3u8 响应 ${playlist.response.status}`);
      const body = await playlist.response.text();
      const mediaLine = firstPlaylistMediaLine(body);
      if (!mediaLine) {
        return {
          playable: true,
          latencyMs: playlist.latencyMs,
          stability: probeStability(true, playlist.latencyMs),
          message: "m3u8 可访问，但没有抽样到媒体分片",
          testedUrl: episode.url,
          checkedAt
        };
      }

      const mediaUrl = absolutizeUrl(mediaLine, episode.url);
      const sampleUrl = /\.m3u8(\?|$)/i.test(mediaUrl)
        ? absolutizeUrl(firstPlaylistMediaLine(await (await runProbeFetch(mediaUrl)).response.text()) ?? mediaUrl, mediaUrl)
        : mediaUrl;
      const sample = await probeBytes(sampleUrl);
      const latencyMs = Math.min(playlist.latencyMs, sample.latencyMs);
      return {
        playable: true,
        latencyMs,
        speedKbps: sample.speedKbps,
        stability: probeStability(true, latencyMs, sample.speedKbps),
        testedUrl: sampleUrl,
        checkedAt
      };
    }

    const sample = await probeBytes(episode.url);
    return {
      playable: true,
      latencyMs: sample.latencyMs,
      speedKbps: sample.speedKbps,
      stability: probeStability(true, sample.latencyMs, sample.speedKbps),
      testedUrl: episode.url,
      checkedAt
    };
  } catch (error) {
    return {
      playable: false,
      stability: "failed",
      message: error instanceof Error ? error.message : "播放探测失败",
      testedUrl: episode.url,
      checkedAt
    };
  }
}

async function evaluateSiteRoute(site: SourceSite, subject: CatalogItem): Promise<SourceRoute> {
  const checkedAt = new Date().toISOString();
  const siteName = safeSourceName(site);
  if (!site.enabled || !site.searchable) {
    const probe: SourceRouteProbe = {
      playable: false,
      stability: "unknown",
      message: site.enabled ? "资源站未开启搜索" : "资源站已停用",
      checkedAt
    };
    const route: SourceRoute = {
      siteId: site.id,
      siteName,
      enabled: site.enabled,
      status: "disabled",
      hasResource: false,
      playable: false,
      score: 0,
      reasons: [probe.message ?? "不可用"],
      episodeCount: 0,
      quality: { label: "未知", score: 0 },
      probe,
      metrics: []
    };
    route.metrics = buildRouteMetrics(route, subject);
    return route;
  }

  try {
    const candidates = await withSoftTimeout(searchSite(site, subject.title, 8), 8500);
    const candidate = pickBestCandidate(candidates, subject);
    if (!candidate) {
      const probe: SourceRouteProbe = {
        playable: false,
        stability: "unknown",
        message: candidates.length ? "有搜索结果，但标题不匹配" : "没有搜索结果",
        checkedAt
      };
      const route: SourceRoute = {
        siteId: site.id,
        siteName,
        enabled: true,
        status: "missing",
        hasResource: false,
        playable: false,
        score: 0,
        reasons: [],
        episodeCount: 0,
        quality: { label: "未知", score: 0 },
        probe,
        metrics: []
      };
      route.reasons = routeReasons(route);
      route.metrics = buildRouteMetrics(route, subject);
      return route;
    }

    const detail = candidate.episodes.length ? candidate : (await withSoftTimeout(fetchDetail(site, candidate.vodId), 6500)) ?? candidate;
    const episode = detail.episodes.at(-1) ?? detail.episodes[0];
    const probe = await probeEpisode(episode);
    const quality = inferQuality(detail);
    const route: SourceRoute = {
      siteId: site.id,
      siteName,
      enabled: true,
      status: probe.playable ? "available" : "failed",
      hasResource: true,
      playable: probe.playable,
      score: 0,
      reasons: [],
      candidateTitle: detail.title,
      vodId: detail.vodId,
      item: mergeDoubanMetadata(detail, subject),
      episodeCount: detail.episodes.length,
      latestEpisodeName: detail.episodes.at(-1)?.name,
      remarks: detail.remarks,
      quality,
      probe,
      metrics: [],
      error: probe.playable ? undefined : probe.message
    };
    route.score = scoreRoute(route.item, probe);
    route.reasons = routeReasons(route);
    route.metrics = buildRouteMetrics(route, subject);
    return route;
  } catch (error) {
    const probe: SourceRouteProbe = {
      playable: false,
      stability: "failed",
      message: error instanceof Error ? error.message : "线路评测失败",
      checkedAt
    };
    const route: SourceRoute = {
      siteId: site.id,
      siteName,
      enabled: true,
      status: "failed",
      hasResource: false,
      playable: false,
      score: 0,
      reasons: [probe.message ?? "线路评测失败"],
      episodeCount: 0,
      quality: { label: "未知", score: 0 },
      probe,
      metrics: [],
      error: probe.message
    };
    route.metrics = buildRouteMetrics(route, subject);
    return route;
  }
}

async function evaluateSourceRoutes(subject: CatalogItem): Promise<SourceMatchResponse> {
  const state = await readState();
  const routes = await Promise.all(state.sites.map((site) => evaluateSiteRoute(site, subject)));
  const sortedRoutes = [...routes].sort((left, right) => right.score - left.score);
  const recommendedRoute = sortedRoutes.find((route) => route.playable && route.item);
  const selectedItem = recommendedRoute?.item;
  return {
    subject,
    routes: sortedRoutes,
    recommendedRoute,
    selectedItem,
    errors: sortedRoutes.filter((route) => route.error).map((route) => `${route.siteName}: ${route.error}`),
    checkedAt: new Date().toISOString()
  };
}

function withSoftTimeout<T>(promise: Promise<T>, timeout = 5500): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeoutPromise = new Promise<T>((_, reject) => {
    timer = setTimeout(() => reject(new Error("资源站匹配超时")), timeout);
  });
  return Promise.race([promise, timeoutPromise]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}

async function findPlayableMatchesForDouban(doubanItems: CatalogItem[], sites: SourceSite[], itemLimit = 8) {
  const searchSites = sites.filter((site) => site.searchable).slice(0, 3);
  if (!doubanItems.length || !searchSites.length || itemLimit <= 0) return [];

  const settled = await Promise.allSettled(
    doubanItems.slice(0, itemLimit).map(async (doubanItem) => {
      const siteSearches = await Promise.allSettled(
        searchSites.map((site) => withSoftTimeout(searchSite(site, doubanItem.title, 4)))
      );
      const candidates = siteSearches.flatMap((entry) => (entry.status === "fulfilled" ? entry.value : []));
      const playable = candidates.find((item) => item.episodes.length && sameTitle(item.title, doubanItem.title));
      return playable ? mergeDoubanMetadata(playable, doubanItem) : undefined;
    })
  );

  return uniqueCatalogItems(
    settled.flatMap((entry) => (entry.status === "fulfilled" && entry.value ? [entry.value] : []))
  );
}

function orderTrendingByDouban(doubanItems: CatalogItem[], sourceItems: CatalogItem[], limit: number) {
  const playableByTitle = new Map<string, CatalogItem>();
  for (const item of sourceItems) {
    if (item.episodes.length) {
      const key = titleKey(item.title);
      if (key && !playableByTitle.has(key)) playableByTitle.set(key, item);
    }
  }

  const usedPlayableIds = new Set<string>();
  const ordered = doubanItems.map((doubanItem) => {
    const playable = playableByTitle.get(titleKey(doubanItem.title));
    if (!playable) return doubanItem;
    usedPlayableIds.add(playable.id);
    return mergeDoubanMetadata(playable, doubanItem);
  });

  const remainingSourceItems = sourceItems.filter((item) => item.episodes.length && !usedPlayableIds.has(item.id));
  return uniqueCatalogTitles(uniqueCatalogItems([...ordered, ...remainingSourceItems])).slice(0, limit);
}

function isLikelyDevRequest(host: string) {
  return host.endsWith(`:${webPort}`) || process.env.npm_lifecycle_event?.startsWith("dev");
}

function getAppUrls(host?: string) {
  const targetPort = host && isLikelyDevRequest(host) ? webPort : port;
  return getLanUrls(targetPort);
}

function apiHostForRequest(host?: string) {
  if (!host) return `localhost:${port}`;
  return isLikelyDevRequest(host) ? host.replace(/:\d+$/, `:${port}`) : host;
}

function getExternalProtocolUrls(settingUrl: string | undefined, envKey: "SMB_SHARE_URL" | "FTP_SHARE_URL") {
  return [settingUrl?.trim(), process.env[envKey]?.trim()].filter((value): value is string => Boolean(value));
}

function getFtpShareUrls() {
  const ftp = getReadOnlyFtpShareState();
  if (!ftp.active) return [];
  return getLanUrls(ftp.port).map((url) => url.replace(/^http:\/\//, "ftp://"));
}

function buildShareProtocols(apiUrls: string[], settings: Awaited<ReturnType<typeof readState>>["settings"]): ShareProtocolInfo[] {
  const ftp = getReadOnlyFtpShareState();
  const ftpUrls = [...getFtpShareUrls(), ...getExternalProtocolUrls(settings.shareFtpUrl, "FTP_SHARE_URL")];
  return [
    {
      id: "hls",
      label: "HLS 推流",
      status: "active",
      urls: apiUrls.map((url) => `${url}/hls/`),
      rootPath: hlsDir,
      description: "把已下载剧集切成 m3u8 + ts 片段，适合手机、电视盒子和支持 HLS 的播放器。",
      note: "单集生成后会显示可直接复制的 m3u8 地址。"
    },
    {
      id: "webdav",
      label: "WebDAV 只读共享",
      status: "active",
      urls: apiUrls.map((url) => `${url}/dav/`),
      rootPath: mediaDir,
      description: "内置只读 WebDAV 服务，可在局域网文件管理器或播放器里直接浏览 media 目录。",
      note: "当前为免登录局域网模式，请只在可信网络内使用。"
    },
    {
      id: "smb",
      label: "SMB 共享",
      status: getExternalProtocolUrls(settings.shareSmbUrl, "SMB_SHARE_URL").length ? "external" : "disabled",
      urls: getExternalProtocolUrls(settings.shareSmbUrl, "SMB_SHARE_URL"),
      rootPath: mediaDir,
      description: "适合电视、NAS 和 Windows 文件共享。Movie Hub 会展示外部 SMB 地址，服务由系统或 NAS 提供。",
      note: "可在共享中心保存 SMB 地址，也可通过环境变量 SMB_SHARE_URL 提供。"
    },
    {
      id: "ftp",
      label: "FTP 共享",
      status: ftp.active ? "active" : ftpUrls.length ? "external" : "disabled",
      urls: ftpUrls,
      rootPath: mediaDir,
      description: "内置只读 FTP 服务，适合旧款播放器、下载器或文件管理器在局域网访问 media 目录。",
      note: ftp.active
        ? `内置 FTP 端口 ${ftp.port}，匿名只读访问；也可保存外部 FTP 地址一并展示。`
        : ftp.error
          ? `内置 FTP 未启动：${ftp.error}。可保存外部 FTP 地址作为备用入口。`
          : "可在共享中心保存 FTP 地址，也可通过环境变量 FTP_SHARE_URL 提供。"
    }
  ];
}

async function buildShareSummary(host?: string): Promise<ShareSummary> {
  const state = await readState();
  const apiHost = apiHostForRequest(host);
  const videos = await scanLibrary(apiHost);
  const apiUrls = getLanUrls(port);
  return {
    mediaDir,
    hlsDir,
    videos,
    totalSize: videos.reduce((sum, video) => sum + video.size, 0),
    hlsReady: videos.filter((video) => video.hlsUrl).length,
    appUrls: getAppUrls(host),
    apiUrls,
    protocols: buildShareProtocols(apiUrls, state.settings),
    generatedAt: new Date().toISOString()
  };
}

function safeResolveDavPath(target = "") {
  const decoded = decodeURIComponent(target).replace(/^\/+/, "");
  const resolved = path.resolve(mediaDir, decoded);
  const relative = path.relative(mediaDir, resolved);
  if (relative.startsWith("..") || path.isAbsolute(relative)) return undefined;
  return { filePath: resolved, relative: relative.replace(/\\/g, "/") };
}

function davHref(relative: string, isDirectory: boolean) {
  const suffix = relative
    .split("/")
    .filter(Boolean)
    .map((part) => encodeURIComponent(part))
    .join("/");
  return `/dav/${suffix}${isDirectory && suffix ? "/" : ""}`;
}

function xmlEscape(value: string) {
  return value.replace(/[<>&'"]/g, (char) => {
    return {
      "<": "&lt;",
      ">": "&gt;",
      "&": "&amp;",
      "'": "&apos;",
      "\"": "&quot;"
    }[char] ?? char;
  });
}

function mimeForFile(filePath: string) {
  const ext = path.extname(filePath).toLowerCase();
  if (ext === ".mp4" || ext === ".m4v") return "video/mp4";
  if (ext === ".webm") return "video/webm";
  if (ext === ".mov") return "video/quicktime";
  if (ext === ".ts") return "video/mp2t";
  if (ext === ".m3u8") return "application/vnd.apple.mpegurl";
  return "application/octet-stream";
}

async function davResourceXml(filePath: string, relative: string) {
  const info = await stat(filePath);
  const isDirectory = info.isDirectory();
  const name = relative ? path.basename(relative) : "media";
  return `
    <D:response>
      <D:href>${xmlEscape(davHref(relative, isDirectory))}</D:href>
      <D:propstat>
        <D:prop>
          <D:displayname>${xmlEscape(name)}</D:displayname>
          <D:getlastmodified>${info.mtime.toUTCString()}</D:getlastmodified>
          ${isDirectory ? "<D:resourcetype><D:collection/></D:resourcetype>" : "<D:resourcetype/>"}
          ${isDirectory ? "" : `<D:getcontentlength>${info.size}</D:getcontentlength><D:getcontenttype>${xmlEscape(mimeForFile(filePath))}</D:getcontenttype>`}
        </D:prop>
        <D:status>HTTP/1.1 200 OK</D:status>
      </D:propstat>
    </D:response>`;
}

async function handleDavPropfind(req: express.Request, res: express.Response, target = "") {
  const resolved = safeResolveDavPath(target);
  if (!resolved || !existsSync(resolved.filePath)) {
    res.status(404).end();
    return;
  }

  const info = await stat(resolved.filePath);
  const depth = req.header("depth") ?? "1";
  const entries = [await davResourceXml(resolved.filePath, resolved.relative)];

  if (info.isDirectory() && depth !== "0") {
    const children = await readdir(resolved.filePath, { withFileTypes: true });
    for (const child of children) {
      const childRelative = [resolved.relative, child.name].filter(Boolean).join("/");
      entries.push(await davResourceXml(path.join(resolved.filePath, child.name), childRelative));
    }
  }

  res.status(207);
  res.setHeader("Content-Type", "application/xml; charset=utf-8");
  res.send(`<?xml version="1.0" encoding="utf-8"?><D:multistatus xmlns:D="DAV:">${entries.join("")}</D:multistatus>`);
}

async function handleDavRead(req: express.Request, res: express.Response, target = "") {
  const resolved = safeResolveDavPath(target);
  if (!resolved || !existsSync(resolved.filePath)) {
    res.status(404).end();
    return;
  }

  const info = await stat(resolved.filePath);
  if (info.isDirectory()) {
    const children = await readdir(resolved.filePath, { withFileTypes: true });
    res.setHeader("Content-Type", "text/plain; charset=utf-8");
    res.send(children.map((child) => `${child.name}${child.isDirectory() ? "/" : ""}`).join("\n"));
    return;
  }

  const range = req.headers.range;
  const contentType = mimeForFile(resolved.filePath);
  if (!range) {
    res.writeHead(200, {
      "Content-Length": info.size,
      "Content-Type": contentType,
      "Accept-Ranges": "bytes"
    });
    if (req.method === "HEAD") res.end();
    else createReadStream(resolved.filePath).pipe(res);
    return;
  }

  const [startText, endText] = range.replace(/bytes=/, "").split("-");
  const start = Number.parseInt(startText, 10);
  const end = endText ? Number.parseInt(endText, 10) : info.size - 1;
  if (Number.isNaN(start) || Number.isNaN(end) || start > end || end >= info.size) {
    res.status(416).end();
    return;
  }

  res.writeHead(206, {
    "Content-Range": `bytes ${start}-${end}/${info.size}`,
    "Accept-Ranges": "bytes",
    "Content-Length": end - start + 1,
    "Content-Type": contentType
  });
  if (req.method === "HEAD") res.end();
  else createReadStream(resolved.filePath, { start, end }).pipe(res);
}

function findCachedCatalogItem(state: Awaited<ReturnType<typeof readState>>, sourceId: string, vodId: string) {
  const pools = [
    state.trendingCache,
    state.watchlist.map((entry) => entry.item),
    state.scrapeHistory.flatMap((entry) => entry.items)
  ];
  return pools.flat().find((item) => item.sourceId === sourceId && item.vodId === vodId);
}

async function withAbort<T>(task: (signal: AbortSignal) => Promise<T>, timeoutMs = 8000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await task(controller.signal);
  } finally {
    clearTimeout(timer);
  }
}

async function checkSourceHealth(site: SourceSite): Promise<SourceHealthCheck> {
  const checkedAt = new Date().toISOString();
  const url = siteHealthUrl(site);
  const siteName = safeSourceName(site);

  if (!site.enabled) {
    return {
      siteId: site.id,
      siteName,
      status: "disabled",
      ok: false,
      checkedAt,
      message: "资源站已停用",
      url
    };
  }

  const startedAt = performance.now();
  try {
    const response = await withAbort(
      (signal) =>
        fetch(url, {
          signal,
          headers: {
            "user-agent": "MovieHub/0.1 (+local-family-cinema)",
            accept: "application/json,text/xml,application/xml,text/plain,*/*"
          }
        }),
      8000
    );
    const body = await response.text();
    const latencyMs = Math.round(performance.now() - startedAt);
    const sample = body.slice(0, 2048).trim();
    const looksLikeCms = Boolean(sample) && (/vod_|<rss|<list|"\s*list\s*"|"\s*data\s*"|"\s*code\s*"/i.test(sample) || response.ok);

    return {
      siteId: site.id,
      siteName,
      status: response.ok && looksLikeCms ? "online" : "offline",
      ok: response.ok && looksLikeCms,
      latencyMs,
      httpStatus: response.status,
      checkedAt,
      message: response.ok ? (looksLikeCms ? "连通正常" : "响应内容无法识别") : `HTTP ${response.status}`,
      url,
      sampleBytes: body.length
    };
  } catch (error) {
    return {
      siteId: site.id,
      siteName,
      status: "offline",
      ok: false,
      latencyMs: Math.round(performance.now() - startedAt),
      checkedAt,
      message: error instanceof Error ? error.message : "检测失败",
      url
    };
  }
}

async function saveSourceHealthResults(results: SourceHealthCheck[], markAuto = false) {
  return updateState((state) => {
    for (const result of results) {
      state.sourceHealth[result.siteId] = result;
    }
    if (markAuto) state.settings.sourceHealthLastAutoCheckAt = new Date().toISOString();
  });
}

async function checkAllSourceHealth(markAuto = false) {
  const state = await readState();
  const results = await Promise.all(state.sites.map((site) => checkSourceHealth(site)));
  await saveSourceHealthResults(results, markAuto);
  return results;
}

let sourceHealthAutoCheckRunning = false;

async function runScheduledSourceHealthCheck() {
  if (sourceHealthAutoCheckRunning) return;
  const state = await readState();
  const intervalMinutes = Math.max(1, state.settings.sourceHealthCheckIntervalMinutes || 30);
  const lastCheckedAt = state.settings.sourceHealthLastAutoCheckAt ? Date.parse(state.settings.sourceHealthLastAutoCheckAt) : 0;
  if (lastCheckedAt && Date.now() - lastCheckedAt < intervalMinutes * 60 * 1000) return;

  sourceHealthAutoCheckRunning = true;
  try {
    await checkAllSourceHealth(true);
  } finally {
    sourceHealthAutoCheckRunning = false;
  }
}

function toolStability(ok: boolean, latencyMs?: number): ToolStatus["stability"] {
  if (!ok) return "missing";
  if (latencyMs != null && latencyMs > 2500) return "slow";
  return "stable";
}

async function getToolsStatus(): Promise<ToolsStatusResponse> {
  const state = await readState();
  const checkedAt = new Date().toISOString();
  const [ffmpegProbe, ffprobeProbe, nm3u8Probe] = await Promise.all([
    inspectFfmpeg(state.settings.ffmpegPath),
    inspectFfprobe(state.settings.ffmpegPath),
    inspectNm3u8DlRe(state.settings.m3u8DownloaderPath)
  ]);
  const ffmpeg: ToolStatus = {
    id: "ffmpeg",
    label: "ffmpeg",
    ok: ffmpegProbe.ok,
    command: ffmpegProbe.command,
    configuredPath: ffmpegProbe.configuredPath,
    version: ffmpegProbe.version,
    latencyMs: ffmpegProbe.latencyMs,
    stability: toolStability(ffmpegProbe.ok, ffmpegProbe.latencyMs),
    message: ffmpegProbe.message,
    checkedAt
  };
  const ffprobe: ToolStatus = {
    id: "ffprobe",
    label: "ffprobe",
    ok: ffprobeProbe.ok,
    command: ffprobeProbe.command,
    configuredPath: ffprobeProbe.configuredPath,
    version: ffprobeProbe.version,
    latencyMs: ffprobeProbe.latencyMs,
    stability: toolStability(ffprobeProbe.ok, ffprobeProbe.latencyMs),
    message: ffprobeProbe.message,
    checkedAt
  };
  const nM3u8DlRe: ToolStatus = {
    id: "n-m3u8dl-re",
    label: "N_m3u8DL-RE",
    ok: nm3u8Probe.ok,
    command: nm3u8Probe.command,
    configuredPath: nm3u8Probe.configuredPath,
    version: nm3u8Probe.version,
    latencyMs: nm3u8Probe.latencyMs,
    stability: toolStability(nm3u8Probe.ok, nm3u8Probe.latencyMs),
    message: nm3u8Probe.message,
    checkedAt
  };
  return { ffmpeg, ffprobe, nM3u8DlRe, checkedAt };
}

async function readRuntimeLogTail(lines: number) {
  try {
    const info = await stat(runtimeLogFile);
    const text = stripAnsiCodes(await readFile(runtimeLogFile, "utf8"));
    const tail = text
      .split(/\r?\n/)
      .filter((line) => line.trim())
      .slice(-lines);
    return {
      lines: tail,
      size: info.size,
      modifiedAt: info.mtime.toISOString()
    };
  } catch {
    return {
      lines: [],
      size: 0
    };
  }
}

function stripAnsiCodes(value: string) {
  return value.replace(/\x1B\[[0-?]*[ -/]*[@-~]/g, "");
}

async function getRuntimeStatus(host?: string, lineCount = 160): Promise<RuntimeStatusResponse> {
  const [state, tools, library, logs] = await Promise.all([
    readState(),
    getToolsStatus(),
    scanLibrary(host ?? `localhost:${port}`),
    readRuntimeLogTail(lineCount)
  ]);
  const activeDownloads = state.downloads.filter((task) => task.status === "queued" || task.status === "downloading").length;
  const failedDownloads = state.downloads.filter((task) => task.status === "failed").length;
  const canceledDownloads = state.downloads.filter((task) => task.status === "canceled").length;
  const healthResults = Object.values(state.sourceHealth);
  const checkedSites = healthResults.length;
  const offlineSites = healthResults.filter((result) => result.status === "offline").length;
  const unreadNotifications = state.notifications.filter((notice) => !notice.read).length;
  const missingTools = missingRuntimeToolLabels(tools);
  const checks: RuntimeDiagnosticCheck[] = [
    {
      id: "api",
      label: "API 服务",
      status: "ok",
      message: "服务正在响应请求",
      value: `运行 ${Math.floor(process.uptime() / 60)} 分钟`
    },
    {
      id: "library",
      label: "本地片库",
      status: library.length ? "ok" : "warning",
      message: library.length ? "已扫描到本地视频" : "media 目录暂无可展示视频",
      value: `${library.length} 个视频`
    },
    {
      id: "tools",
      label: "工具链",
      status: missingTools.length ? "warning" : "ok",
      message: missingTools.length ? `缺少 ${missingTools.join("、")}` : "ffmpeg、ffprobe、N_m3u8DL-RE 已就绪",
      value: `${3 - missingTools.length}/3`
    },
    {
      id: "downloads",
      label: "下载任务",
      status: failedDownloads ? "warning" : "ok",
      message: failedDownloads
        ? `${failedDownloads} 个任务失败，可在下载管理重试`
        : canceledDownloads
          ? `${canceledDownloads} 个任务已取消，可按需重试`
          : "下载队列没有失败任务",
      value: `${activeDownloads} 个进行中`
    },
    {
      id: "sources",
      label: "资源站",
      status: offlineSites ? "warning" : "ok",
      message: checkedSites ? `${offlineSites} 个资源站异常` : "还没有健康检测记录",
      value: `${state.sites.filter((site) => site.enabled).length}/${state.sites.length} 启用`
    },
    {
      id: "notifications",
      label: "通知",
      status: unreadNotifications > 60 ? "warning" : "ok",
      message: unreadNotifications ? "存在未读通知" : "通知已清理",
      value: `${unreadNotifications} 未读`
    }
  ];
  const memory = process.memoryUsage();
  return {
    api: `http://localhost:${port}`,
    uptimeSeconds: Math.round(process.uptime()),
    memory: {
      rss: memory.rss,
      heapUsed: memory.heapUsed,
      heapTotal: memory.heapTotal
    },
    cwd: process.cwd(),
    mediaDir,
    hlsDir,
    logFile: runtimeLogFile,
    startedAt,
    checkedAt: new Date().toISOString(),
    checks,
    logs
  };
}

async function buildStateBackup(host?: string) {
  const [state, library] = await Promise.all([readState(), scanLibrary(host ?? `localhost:${port}`)]);
  const exportedAt = new Date().toISOString();
  return {
    format: "movie-hub-state-backup",
    version: appVersion,
    exportedAt,
    summary: {
      sites: state.sites.length,
      enabledSites: state.sites.filter((site) => site.enabled).length,
      watchlist: state.watchlist.length,
      downloads: state.downloads.length,
      hlsJobs: state.hlsJobs.length,
      notifications: state.notifications.length,
      scrapeHistory: state.scrapeHistory.length,
      trendingCache: state.trendingCache.length,
      library: library.length
    },
    notes: {
      mediaFilesIncluded: false,
      mediaDir,
      hlsDir,
      description: "仅导出系统配置、资源站、追剧、下载任务、通知和缓存状态；不会包含 media 目录内的视频文件。"
    },
    state: {
      ...state,
      library
    }
  };
}

function backupSummary(state: AppState) {
  return {
    sites: state.sites.length,
    enabledSites: state.sites.filter((site) => site.enabled).length,
    watchlist: state.watchlist.length,
    downloads: state.downloads.length,
    hlsJobs: state.hlsJobs.length,
    notifications: state.notifications.length,
    scrapeHistory: state.scrapeHistory.length,
    trendingCache: state.trendingCache.length,
    library: state.library.length
  };
}

function extractBackupState(payload: unknown) {
  if (!payload || typeof payload !== "object") {
    throw new Error("备份内容不是有效对象");
  }
  const root = payload as Record<string, unknown>;
  if (root.format !== "movie-hub-state-backup") {
    throw new Error("不是 Movie Hub 状态备份文件");
  }
  if (!root.state || typeof root.state !== "object") {
    throw new Error("备份文件缺少 state 字段");
  }
  return root.state as Partial<AppState>;
}

function sanitizeRestoredState(restored: Partial<AppState>, current: AppState): AppState {
  return {
    sites: Array.isArray(restored.sites) ? restored.sites : current.sites,
    sourceHealth: restored.sourceHealth && typeof restored.sourceHealth === "object" && !Array.isArray(restored.sourceHealth) ? restored.sourceHealth : {},
    settings: {
      ...current.settings,
      ...(restored.settings && typeof restored.settings === "object" ? restored.settings : {})
    },
    watchlist: Array.isArray(restored.watchlist) ? restored.watchlist : [],
    downloads: Array.isArray(restored.downloads)
      ? restored.downloads.map((task) =>
          task.status === "downloading" || task.status === "queued"
            ? {
                ...task,
                status: "canceled" as const,
                progress: Math.min(task.progress ?? 0, 96),
                message: "备份恢复后任务已暂停，请手动重试。",
                updatedAt: new Date().toISOString()
              }
            : task
        )
      : [],
    hlsJobs: Array.isArray(restored.hlsJobs)
      ? restored.hlsJobs.map((job) =>
          job.status === "queued" || job.status === "running"
            ? {
                ...job,
                status: "failed" as const,
                progress: Math.min(job.progress ?? 0, 96),
                message: "备份恢复后 HLS 任务已暂停，请重新生成。",
                updatedAt: new Date().toISOString()
              }
            : job
        )
      : [],
    library: current.library,
    notifications: Array.isArray(restored.notifications) ? restored.notifications : [],
    scrapeHistory: Array.isArray(restored.scrapeHistory) ? restored.scrapeHistory : [],
    trendingCache: Array.isArray(restored.trendingCache) ? restored.trendingCache : [],
    trendingUpdatedAt: typeof restored.trendingUpdatedAt === "string" ? restored.trendingUpdatedAt : undefined
  };
}

type CorruptBackupField = {
  path: string;
  value: string;
};

function pushCorruptField(fields: CorruptBackupField[], pathName: string, value: unknown) {
  if (hasCorruptText(value)) {
    fields.push({ path: pathName, value: String(value).slice(0, 80) });
  }
}

function scanCatalogItemText(fields: CorruptBackupField[], prefix: string, item: CatalogItem | undefined) {
  if (!item || typeof item !== "object") return;
  pushCorruptField(fields, `${prefix}.sourceName`, item.sourceName);
  pushCorruptField(fields, `${prefix}.title`, item.title);
  pushCorruptField(fields, `${prefix}.originalTitle`, item.originalTitle);
  pushCorruptField(fields, `${prefix}.typeName`, item.typeName);
  pushCorruptField(fields, `${prefix}.actors`, item.actors);
  pushCorruptField(fields, `${prefix}.director`, item.director);
  pushCorruptField(fields, `${prefix}.remarks`, item.remarks);
  pushCorruptField(fields, `${prefix}.description`, item.description);
  pushCorruptField(fields, `${prefix}.year`, item.year);
  pushCorruptField(fields, `${prefix}.area`, item.area);
  pushCorruptField(fields, `${prefix}.language`, item.language);
  pushCorruptField(fields, `${prefix}.score`, item.score);
  item.episodes?.forEach((episode, index) => {
    pushCorruptField(fields, `${prefix}.episodes[${index}].name`, episode.name);
    pushCorruptField(fields, `${prefix}.episodes[${index}].sourceName`, episode.sourceName);
  });
}

function findCorruptBackupFields(state: AppState) {
  const fields: CorruptBackupField[] = [];
  state.sites.forEach((site, index) => {
    pushCorruptField(fields, `sites[${index}].name`, site.name);
    pushCorruptField(fields, `sites[${index}].notes`, site.notes);
  });
  Object.entries(state.sourceHealth).forEach(([siteId, health]) => {
    pushCorruptField(fields, `sourceHealth.${siteId}.siteName`, health.siteName);
    pushCorruptField(fields, `sourceHealth.${siteId}.message`, health.message);
  });
  state.watchlist.forEach((watch, index) => {
    scanCatalogItemText(fields, `watchlist[${index}].item`, watch.item);
    pushCorruptField(fields, `watchlist[${index}].latestEpisodeName`, watch.latestEpisodeName);
    pushCorruptField(fields, `watchlist[${index}].updateMessage`, watch.updateMessage);
  });
  state.downloads.forEach((task, index) => {
    pushCorruptField(fields, `downloads[${index}].title`, task.title);
    pushCorruptField(fields, `downloads[${index}].episodeName`, task.episodeName);
    pushCorruptField(fields, `downloads[${index}].message`, task.message);
    pushCorruptField(fields, `downloads[${index}].outputDir`, task.outputDir);
    pushCorruptField(fields, `downloads[${index}].outputPath`, task.outputPath);
  });
  state.hlsJobs.forEach((job, index) => {
    pushCorruptField(fields, `hlsJobs[${index}].title`, job.title);
    pushCorruptField(fields, `hlsJobs[${index}].episodeName`, job.episodeName);
    pushCorruptField(fields, `hlsJobs[${index}].fileName`, job.fileName);
    pushCorruptField(fields, `hlsJobs[${index}].message`, job.message);
  });
  state.notifications.forEach((notice, index) => {
    pushCorruptField(fields, `notifications[${index}].title`, notice.title);
    pushCorruptField(fields, `notifications[${index}].message`, notice.message);
  });
  state.scrapeHistory.forEach((entry, index) => {
    pushCorruptField(fields, `scrapeHistory[${index}].keyword`, entry.keyword);
    entry.errors.forEach((error, errorIndex) => pushCorruptField(fields, `scrapeHistory[${index}].errors[${errorIndex}]`, error));
    entry.items.forEach((item, itemIndex) => scanCatalogItemText(fields, `scrapeHistory[${index}].items[${itemIndex}]`, item));
  });
  state.trendingCache.forEach((item, index) => scanCatalogItemText(fields, `trendingCache[${index}]`, item));
  return fields;
}

function corruptBackupMessage(fields: CorruptBackupField[]) {
  const sample = fields
    .slice(0, 5)
    .map((field) => `${field.path}: ${field.value}`)
    .join("；");
  return `备份疑似存在编码损坏，已拒绝恢复。请重新导出 UTF-8 备份。命中 ${fields.length} 处，示例：${sample}`;
}

function missingRuntimeToolLabels(tools: ToolsStatusResponse) {
  const missing: string[] = [];
  if (!tools.ffmpeg.ok) missing.push("ffmpeg");
  if (!tools.nM3u8DlRe.ok) missing.push("N_m3u8DL-RE");
  return missing;
}

function runtimeToolWarningMessage(tools: ToolsStatusResponse) {
  const missing = missingRuntimeToolLabels(tools);
  if (!missing.length) return "";
  if (missing.includes("ffmpeg") && missing.includes("N_m3u8DL-RE")) {
    return "未检测到 ffmpeg 和 N_m3u8DL-RE，请把工具放到 tools 目录，或在系统设置里配置路径。";
  }
  if (missing.includes("ffmpeg")) {
    return "未检测到 ffmpeg，本地 HLS、推流和 ffmpeg 兜底下载会受影响。";
  }
  return "未检测到 N_m3u8DL-RE，m3u8 下载会尝试使用 ffmpeg 兜底。";
}

async function announceMissingRuntimeTools() {
  const tools = await getToolsStatus();
  const message = runtimeToolWarningMessage(tools);
  if (!message) return;

  const title = "工具未就绪";
  const state = await readState();
  const hasUnreadSameNotice = state.notifications.some(
    (notice) => notice.category === "system" && !notice.read && notice.title === title && notice.message === message
  );
  if (!hasUnreadSameNotice) {
    await addNotification({
      title,
      message,
      tone: "warning",
      category: "system"
    });
  }
  console.warn(`[Movie Hub] ${message}`);
}

app.get("/api/state", async (req, res) => {
  const state = await readState();
  const host = req.get("host") ?? `localhost:${port}`;
  const library = await scanLibrary(host);
  res.json({ ...state, library });
});

app.get("/api/stats", async (req, res) => {
  const state = await readState();
  const host = req.get("host") ?? `localhost:${port}`;
  const library = await scanLibrary(host);
  const healthResults = Object.values(state.sourceHealth);
  res.json({
    sites: state.sites.length,
    enabledSites: state.sites.filter((site) => site.enabled).length,
    onlineSites: healthResults.filter((result) => result.status === "online").length,
    offlineSites: healthResults.filter((result) => result.status === "offline").length,
    watchlist: state.watchlist.length,
    downloads: state.downloads.length,
    completedDownloads: state.downloads.filter((task) => task.status === "completed").length,
    library: library.length,
    serverUrls: getAppUrls(host),
    apiUrls: getLanUrls(port),
    unreadNotifications: state.notifications.filter((notice) => !notice.read).length,
    lastScrapeAt: state.scrapeHistory[0]?.createdAt,
    trendingUpdatedAt: state.trendingUpdatedAt
  });
});

app.get("/api/sites", async (_, res) => {
  const state = await readState();
  res.json(state.sites);
});

app.post("/api/sites", async (req, res) => {
  const parsed = normalizeSiteDisplayInput(siteSchema.parse(req.body));
  const now = new Date().toISOString();
  const site: SourceSite = {
    id: `site-${Date.now()}`,
    ...parsed,
    createdAt: now,
    updatedAt: now
  };
  const state = await upsertSite(site);
  await addNotification({
    title: "资源站已添加",
    message: `${site.name} 已加入 CMS 刮削列表。`,
    tone: "success",
    category: "source",
    sourceId: site.id
  });
  res.status(201).json({ site, sites: state.sites });
});

app.post("/api/sites/import-subscription", async (req, res) => {
  try {
    const parsed = siteSubscriptionSchema.parse(req.body);
    const response = await fetch(parsed.url, {
      headers: {
        Accept: "application/json, text/plain, */*",
        "User-Agent": "MovieHub/0.1"
      },
      signal: AbortSignal.timeout(30000)
    });
    if (!response.ok) {
      let detail = "";
      try {
        const errorBody = await response.json();
        detail = typeof errorBody?.message === "string" ? `，${errorBody.message}` : "";
      } catch {
        // Keep the HTTP status as the stable error surface when the body is not JSON.
      }
      res.status(502).json({ error: `订阅获取失败：HTTP ${response.status}${detail}` });
      return;
    }

    let payload: unknown;
    try {
      payload = await response.json();
    } catch {
      res.status(422).json({ error: "订阅内容不是有效 JSON" });
      return;
    }

    const candidates = extractSubscriptionVodSources(payload);
    if (!candidates.length) {
      res.status(422).json({ error: "订阅中未识别到可导入的 MacCMS 视频源，请检查是否为 vod 数组或资源站对象映射格式" });
      return;
    }

    const existing = await readState();
    const knownUrls = new Set(existing.sites.map((site) => normalizeSourceUrl(site.baseUrl)));
    const imported: SourceSite[] = [];
    const skipped: { name: string; baseUrl: string; reason: string }[] = [];
    const failed: { name: string; baseUrl: string; reason: string }[] = [];
    const now = new Date().toISOString();

    for (const item of candidates) {
      const baseUrl = String(item.api).trim();
      const name = cleanImportedSourceName(String(item.name), baseUrl);
      const key = normalizeSourceUrl(baseUrl);
      if (!baseUrl || knownUrls.has(key)) {
        skipped.push({ name, baseUrl, reason: "已存在" });
        continue;
      }

      try {
        const site = siteSchema.parse({
          name,
          baseUrl,
          enabled: parsed.enabled,
          searchable: parsed.searchable,
          apiStyle: parsed.apiStyle,
          notes: `通过订阅导入：${new URL(parsed.url).hostname || "本地订阅"}`
        });
        imported.push({
          id: `site-${Date.now()}-${imported.length}`,
          ...site,
          createdAt: now,
          updatedAt: now
        });
        knownUrls.add(key);
      } catch (error) {
        failed.push({ name, baseUrl, reason: error instanceof Error ? error.message : "格式不支持" });
      }
    }

    let state = existing;
    if (imported.length) {
      state = await updateState((current) => {
        current.sites = [...imported, ...current.sites];
      });
      await addNotification({
        title: "资源站订阅已导入",
        message: `新增 ${imported.length} 个资源站，跳过 ${skipped.length} 个重复项。`,
        tone: "success",
        category: "source"
      });
    }

    res.status(201).json({
      imported,
      skipped,
      failed,
      totals: {
        candidates: candidates.length,
        imported: imported.length,
        skipped: skipped.length,
        failed: failed.length
      },
      sites: state.sites
    });
  } catch (error) {
    res.status(400).json({ error: error instanceof Error ? error.message : "订阅导入失败" });
  }
});

app.put("/api/sites/:id", async (req, res) => {
  const parsed = siteSchema.partial().parse(req.body);
  const state = await readState();
  const site = state.sites.find((item) => item.id === req.params.id);
  if (!site) {
    res.status(404).json({ error: "资源站不存在" });
    return;
  }

  const next = normalizeSiteDisplayInput({
    ...site,
    ...parsed,
    updatedAt: new Date().toISOString()
  });
  const updated = await upsertSite(next);
  await addNotification({
    title: next.enabled ? "资源站已启用" : "资源站已停用",
    message: `${next.name} 配置已更新。`,
    tone: next.enabled ? "success" : "warning",
    category: "source",
    sourceId: next.id
  });
  res.json({ site: next, sites: updated.sites });
});

app.delete("/api/sites/:id", async (req, res) => {
  const before = await readState();
  const site = before.sites.find((item) => item.id === req.params.id);
  const state = await removeSite(req.params.id);
  if (site) {
    await addNotification({
      title: "资源站已删除",
      message: `${site.name} 已从 CMS 列表移除。`,
      tone: "warning",
      category: "source",
      sourceId: site.id
    });
  }
  res.json({ sites: state.sites });
});

app.put("/api/settings", async (req, res) => {
  const parsed = settingsSchema.parse(req.body);
  const state = await updateState((current) => {
    current.settings = {
      ...current.settings,
      ...parsed
    };
  });
  res.json({ settings: state.settings });
});

app.get("/api/emby/status", async (_, res) => {
  res.json(await getEmbyStatus());
});

app.post("/api/emby/sync", async (_, res) => {
  const result = await syncAllCompletedDownloads();
  res.json(result);
});

app.get("/api/tools/status", async (_, res) => {
  res.json(await getToolsStatus());
});

app.get("/api/runtime/status", async (req, res) => {
  const lines = Math.max(20, Math.min(500, Number(req.query.lines ?? 160) || 160));
  const host = req.get("host") ?? `localhost:${port}`;
  res.json(await getRuntimeStatus(host, lines));
});

app.get("/api/backup/state", async (req, res) => {
  const host = req.get("host") ?? `localhost:${port}`;
  const backup = await buildStateBackup(host);
  const timestamp = backup.exportedAt.replace(/[:.]/g, "-");
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Content-Disposition", `attachment; filename="movie-hub-backup-${timestamp}.json"`);
  res.send(`${JSON.stringify(backup, null, 2)}\n`);
});

app.post("/api/backup/restore", async (req, res) => {
  try {
    const parsed = z
      .object({
        backup: z.unknown(),
        confirm: z.literal(true)
      })
      .parse(req.body);
    const current = await readState();
    const activeDownloads = current.downloads.filter((task) => task.status === "queued" || task.status === "downloading").length;
    const activeHlsJobs = current.hlsJobs.filter((job) => job.status === "queued" || job.status === "running").length;
    if (activeDownloads || activeHlsJobs) {
      res.status(409).json({
        error: `当前有 ${activeDownloads} 个下载任务、${activeHlsJobs} 个 HLS 任务仍在运行，请先停止或等待完成后再恢复备份。`
      });
      return;
    }

    const restored = sanitizeRestoredState(extractBackupState(parsed.backup), current);
    const corruptFields = findCorruptBackupFields(restored);
    if (corruptFields.length) {
      const error = corruptBackupMessage(corruptFields);
      console.warn(`[Movie Hub] Rejected backup restore with corrupt text: ${corruptFields.length} fields`);
      res.status(422).json({
        error,
        corruptFields: corruptFields.slice(0, 20)
      });
      return;
    }
    await writeState(restored);
    await addNotification({
      title: "备份已恢复",
      message: `已恢复 ${restored.sites.length} 个资源站、${restored.watchlist.length} 条追剧、${restored.downloads.length} 个下载任务。media 文件仍以本机目录扫描为准。`,
      tone: "success",
      category: "system"
    });
    const nextState = await readState();
    const host = req.get("host") ?? `localhost:${port}`;
    const library = await scanLibrary(host);
    const responseState = { ...nextState, library };
    res.json({
      restoredAt: new Date().toISOString(),
      summary: backupSummary(responseState),
      state: responseState
    });
  } catch (error) {
    res.status(400).json({ error: error instanceof Error ? error.message : "备份恢复失败" });
  }
});

app.get("/api/douban/search", async (req, res) => {
  const keyword = String(req.query.q ?? "").trim();
  if (!keyword) {
    res.json({ results: [], errors: [] });
    return;
  }

  const errors: string[] = [];
  let results: CatalogItem[] = [];
  try {
    results = await searchDoubanSubjects(keyword, 24);
  } catch (error) {
    errors.push(error instanceof Error ? error.message : "豆瓣搜索失败");
  }

  await recordScrapeSnapshot({
    keyword,
    siteId: "douban",
    items: results,
    errors
  });

  await addNotification({
    title: "豆瓣搜索完成",
    message: `关键词「${keyword}」找到 ${results.length} 个豆瓣条目${errors.length ? `，${errors.length} 个异常` : ""}。`,
    tone: errors.length ? "warning" : "success",
    category: "source"
  });

  res.json({ results, errors });
});

app.get("/api/douban/trending", async (req, res) => {
  const state = await readState();
  const page = Number(req.query.page ?? 1);
  const pageSize = Number(req.query.pageSize ?? 20);
  try {
    const result = await fetchDoubanTrendingPage(page, pageSize);
    if (result.items.length) await setTrendingCache(uniqueCatalogItems([...result.items, ...state.trendingCache]));
    res.json(result);
  } catch {
    const safePage = Math.max(1, Math.floor(page || 1));
    const safePageSize = Math.max(1, Math.min(60, Math.floor(pageSize || 20)));
    const cached = state.trendingCache.filter((item) => item.sourceId === "douban");
    const start = (safePage - 1) * safePageSize;
    res.json({
      items: cached.slice(start, start + safePageSize),
      page: safePage,
      pageSize: safePageSize,
      hasMore: cached.length > start + safePageSize
    });
  }
});

app.post("/api/douban/trending/refresh", async (_, res) => {
  const errors: string[] = [];
  let results: CatalogItem[] = [];
  try {
    results = await fetchDoubanTrending(48);
    if (results.length) {
      await setTrendingCache(results);
      await recordScrapeSnapshot({
        keyword: "douban-trending",
        siteId: "douban",
        items: results,
        errors
      });
      await addNotification({
        title: "Douban poster wall refreshed",
        message: `Fetched ${results.length} Douban subject(s).`,
        tone: "success",
        category: "source"
      });
    }
  } catch (error) {
    errors.push(error instanceof Error ? error.message : "Douban trending failed");
  }
  res.json({ results, errors });
});

async function refreshDoubanPosterCache(limit = 48) {
  const results = await fetchDoubanTrending(limit);
  await setTrendingCache(results);
  await recordScrapeSnapshot({
    keyword: "douban-trending",
    siteId: "douban",
    items: results,
    errors: []
  });
  await addNotification({
    title: "Douban poster wall refreshed",
    message: `Fetched ${results.length} Douban subject(s).`,
    tone: "success",
    category: "source"
  });
  return results;
}

app.get("/api/search", async (req, res) => {
  const keyword = String(req.query.q ?? "").trim();
  const siteId = String(req.query.site ?? "all");
  const silent = req.query.silent === "1" || req.query.silent === "true";
  if (!keyword) {
    res.json({ results: [], errors: [] });
    return;
  }

  const state = await readState();
  const sites = state.sites.filter((site) => site.enabled && (siteId === "all" || site.id === siteId));
  const settled = await Promise.allSettled(sites.map((site) => searchSite(site, keyword, 16)));
  const results = settled.flatMap((entry) => (entry.status === "fulfilled" ? entry.value : []));
  const errors = settled
    .filter((entry): entry is PromiseRejectedResult => entry.status === "rejected")
    .map((entry) => (entry.reason instanceof Error ? entry.reason.message : "资源站搜索失败"));
  const uniqueResults = uniqueCatalogItems(results);

  if (!silent) {
    await recordScrapeSnapshot({
      keyword,
      siteId,
      items: uniqueResults,
      errors
    });

    await addNotification({
      title: "刮削完成",
      message: `关键词「${keyword}」找到 ${uniqueResults.length} 条资源${errors.length ? `，${errors.length} 个资源站异常` : ""}。`,
      tone: errors.length ? "warning" : "success",
      category: "source"
    });
  }

  res.json({ results: uniqueResults, errors });
});

async function scrapeTrending(limit = 48) {
  const state = await readState();
  const sites = state.sites.filter((site) => site.enabled).slice(0, 6);
  const sourceSettled = await Promise.allSettled(sites.map((site) => fetchTrendingFromSite(site, Math.ceil(limit / Math.max(1, sites.length)))));
  const sourceResults = uniqueCatalogItems(sourceSettled.flatMap((entry) => (entry.status === "fulfilled" ? entry.value : []))).slice(0, limit);
  const sourceErrors = sourceSettled
    .filter((entry): entry is PromiseRejectedResult => entry.status === "rejected")
    .map((entry) => (entry.reason instanceof Error ? entry.reason.message : "资源站热门刮削失败"));

  try {
    const doubanItems = await fetchDoubanTrending(limit);
    const matchedItems = await findPlayableMatchesForDouban(doubanItems, sites, Math.min(10, limit));
    const results = orderTrendingByDouban(doubanItems, [...matchedItems, ...sourceResults], limit);
    return { results, errors: sourceErrors, cache: state.trendingCache };
  } catch (error) {
    const message = error instanceof Error ? error.message : "豆瓣热门暂时不可用";
    return { results: sourceResults, errors: [...sourceErrors, message], cache: state.trendingCache };
  }
}

async function refreshTrendingCache() {
  const { results, errors } = await scrapeTrending(48);
  if (results.length) {
    await setTrendingCache(results);
    await recordScrapeSnapshot({
      keyword: "热门",
      siteId: "all",
      items: results,
      errors
    });
    await addNotification({
      title: "热门内容已刷新",
      message: `后台刮削到 ${results.length} 条热门资源${errors.length ? `，${errors.length} 个资源站异常` : ""}。`,
      tone: errors.length ? "warning" : "success",
      category: "source"
    });
  }
  return { results, errors };
}

app.get("/api/trending", async (_, res) => {
  const { results, cache } = await scrapeTrending(24);
  if (results.length) {
    await setTrendingCache(results);
    res.json(results);
    return;
  }
  res.json(cache.slice(0, 24));
});

app.post("/api/scrape/trending", async (_, res) => {
  const { results, errors } = await refreshTrendingCache();
  res.json({ results, errors });
});

app.get("/api/sites/:id/health", async (req, res) => {
  const state = await readState();
  const site = state.sites.find((item) => item.id === req.params.id);
  if (!site) {
    res.status(404).json({ error: "资源站不存在" });
    return;
  }
  res.json({ url: siteHealthUrl(site), enabled: site.enabled, result: state.sourceHealth[site.id] });
});

app.post("/api/sites/:id/health/check", async (req, res) => {
  const state = await readState();
  const site = state.sites.find((item) => item.id === req.params.id);
  if (!site) {
    res.status(404).json({ error: "资源站不存在" });
    return;
  }
  const result = await checkSourceHealth(site);
  const updated = await saveSourceHealthResults([result]);
  res.json({ result, sourceHealth: updated.sourceHealth });
});

app.post("/api/sites/health/check", async (_, res) => {
  const results = await checkAllSourceHealth();
  const state = await readState();
  res.json({ results, sourceHealth: state.sourceHealth });
});

app.get("/api/detail/:siteId/:vodId", async (req, res) => {
  const state = await readState();
  const site = state.sites.find((item) => item.id === req.params.siteId);
  if (!site) {
    res.status(404).json({ error: "资源站不存在" });
    return;
  }
  const detail = await fetchDetail(site, req.params.vodId);
  if (!detail) {
    res.status(404).json({ error: "影片不存在" });
    return;
  }
  res.json(detail);
});

app.get("/api/catalog/:sourceId/:vodId", async (req, res) => {
  const sourceId = decodeURIComponent(req.params.sourceId);
  const vodId = decodeURIComponent(req.params.vodId);
  const state = await readState();
  const cached = findCachedCatalogItem(state, sourceId, vodId);

  if (cached) {
    res.json(cached);
    return;
  }

  if (sourceId === "douban") {
    res.status(404).json({ error: "豆瓣条目未在本地缓存中找到，请从首页重新打开" });
    return;
  }

  const site = state.sites.find((item) => item.id === sourceId);
  if (!site) {
    res.status(404).json({ error: "资源站不存在" });
    return;
  }

  const detail = await fetchDetail(site, vodId);
  if (!detail) {
    res.status(404).json({ error: "影片不存在" });
    return;
  }
  res.json(detail);
});

app.post("/api/source-matches", async (req, res) => {
  const subjectSchema = z
    .object({
      id: z.string().min(1),
      sourceId: z.string().min(1),
      sourceName: z.string().min(1),
      vodId: z.string().min(1),
      title: z.string().min(1),
      originalTitle: z.string().optional(),
      kind: z.enum(["movie", "series", "anime", "variety", "unknown"]),
      poster: z.string().optional(),
      backdrop: z.string().optional(),
      year: z.string().optional(),
      area: z.string().optional(),
      language: z.string().optional(),
      typeName: z.string().optional(),
      actors: z.string().optional(),
      director: z.string().optional(),
      remarks: z.string().optional(),
      description: z.string().optional(),
      updatedAt: z.string().optional(),
      score: z.string().optional(),
      episodes: z.array(z.unknown()).optional()
    })
    .passthrough();
  const parsed = z.object({ subject: subjectSchema }).parse(req.body);
  const subject = { ...(parsed.subject as CatalogItem), episodes: [] };
  res.json(await evaluateSourceRoutes(subject));
});

app.get("/api/watchlist", async (_, res) => {
  const state = await readState();
  res.json(state.watchlist);
});

app.post("/api/watchlist", async (req, res) => {
  const item = req.body.item;
  if (!item?.id) {
    res.status(400).json({ error: "缺少影片信息" });
    return;
  }

  const now = new Date().toISOString();
  const watchItem: WatchItem = {
    id: item.id,
    item,
    latestEpisodeName: item.episodes?.at(-1)?.name,
    autoDownload: Boolean(req.body.autoDownload),
    createdAt: now
  };
  const state = await upsertWatchItem(watchItem);
  await addNotification({
    title: autoDownloadText(watchItem.autoDownload),
    message: `${watchItem.item.title} 已加入在看追踪，当前最新为 ${watchItem.latestEpisodeName ?? "未知"}。`,
    tone: "success",
    category: "watch",
    itemId: watchItem.id,
    sourceId: watchItem.item.sourceId
  });

  const latestEpisode = watchItem.item.episodes.at(-1);
  const alreadyQueued = latestEpisode
    ? state.downloads.some((task) => task.url === latestEpisode.url && ["queued", "downloading", "completed"].includes(task.status))
    : false;
  if (watchItem.autoDownload && latestEpisode && !alreadyQueued) {
    await createDownloadTask({
      title: watchItem.item.title,
      episodeName: latestEpisode.name,
      url: latestEpisode.url,
      sourceId: latestEpisode.sourceId
    });
  }

  res.status(201).json({ watchItem, watchlist: state.watchlist });
});

app.delete("/api/watchlist/:id", async (req, res) => {
  const before = await readState();
  const entry = before.watchlist.find((item) => item.id === req.params.id);
  const state = await removeWatchItem(req.params.id);
  if (entry) {
    await addNotification({
      title: "已取消追踪",
      message: `${entry.item.title} 已移出在看列表。`,
      tone: "info",
      category: "watch",
      itemId: entry.id,
      sourceId: entry.item.sourceId
    });
  }
  res.json({ watchlist: state.watchlist });
});

function autoDownloadText(enabled: boolean) {
  return enabled ? "追剧与自动下载已开启" : "追剧提醒已开启";
}

async function checkWatchlistUpdates(markAuto = false) {
  const state = await readState();
  const checked: WatchItem[] = [];

  for (const entry of state.watchlist) {
    const site = state.sites.find((item) => item.id === entry.item.sourceId);
    const now = new Date().toISOString();
    if (!site) {
      checked.push({ ...entry, lastCheckedAt: now, updateMessage: "资源站已不存在" });
      continue;
    }

    try {
      const detail = await fetchDetail(site, entry.item.vodId);
      const latest = detail?.episodes.at(-1)?.name;
      const changed = latest && latest !== entry.latestEpisodeName;
      const latestEpisode = detail?.episodes.at(-1);
      const next: WatchItem = {
        ...entry,
        item: detail ?? entry.item,
        latestEpisodeName: latest ?? entry.latestEpisodeName,
        lastCheckedAt: now,
        updateFoundAt: changed ? now : entry.updateFoundAt,
        updateMessage: changed ? `发现更新：${latest}` : "暂无新集"
      };
      checked.push(next);

      if (changed && detail) {
        await addNotification({
          title: "追剧发现更新",
          message: `${detail.title} 更新到 ${latest}。${entry.autoDownload ? "已准备自动下载。" : "可以进入播放。 "}`,
          tone: "success",
          category: "watch",
          itemId: entry.id,
          sourceId: detail.sourceId
        });
      }

      const alreadyQueued = latestEpisode
        ? state.downloads.some((task) => task.url === latestEpisode.url && ["queued", "downloading", "completed"].includes(task.status))
        : false;
      if (changed && entry.autoDownload && detail && latestEpisode && !alreadyQueued) {
        await createDownloadTask({
          title: detail.title,
          episodeName: latestEpisode.name,
          url: latestEpisode.url,
          sourceId: detail.sourceId
        });
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : "检查失败";
      checked.push({
        ...entry,
        lastCheckedAt: now,
        updateMessage: message
      });
      await addNotification({
        title: "追剧检查失败",
        message: `${entry.item.title}: ${message}`,
        tone: "warning",
        category: "watch",
        itemId: entry.id,
        sourceId: entry.item.sourceId
      });
    }
  }

  await updateState((next) => {
    next.watchlist = checked;
    if (markAuto) next.settings.watchlistLastAutoCheckAt = new Date().toISOString();
  });
  return checked;
}

let watchlistAutoCheckRunning = false;

async function runScheduledWatchlistCheck() {
  if (watchlistAutoCheckRunning) return;
  const state = await readState();
  if (!state.watchlist.length) return;

  const intervalMinutes = Math.max(1, Math.min(1440, state.settings.watchlistCheckIntervalMinutes || 30));
  const lastCheckedAt = state.settings.watchlistLastAutoCheckAt ? Date.parse(state.settings.watchlistLastAutoCheckAt) : 0;
  if (lastCheckedAt && Date.now() - lastCheckedAt < intervalMinutes * 60 * 1000) return;

  watchlistAutoCheckRunning = true;
  try {
    await checkWatchlistUpdates(true);
  } finally {
    watchlistAutoCheckRunning = false;
  }
}

async function resumeDownloadQueue() {
  const state = await readState();
  const pendingTasks = state.downloads.filter((task) => task.status === "queued" || task.status === "downloading");
  await Promise.all(pendingTasks.map((task) => resumeDownloadTask(task)));
  return pendingTasks.length;
}

app.post("/api/watchlist/check", async (_, res) => {
  const checked = await checkWatchlistUpdates();
  res.json(checked);
});

app.get("/api/downloads", async (_, res) => {
  const state = await readState();
  res.json(state.downloads);
});

function downloadStatusClearLabel(status: "completed" | "failed" | "canceled") {
  return status === "completed" ? "已完成" : status === "failed" ? "失败" : "已取消";
}

app.post("/api/downloads/:id/retry", async (req, res) => {
  const state = await readState();
  const task = state.downloads.find((item) => item.id === req.params.id);
  if (!task) {
    res.status(404).json({ error: "下载任务不存在" });
    return;
  }
  if (task.status !== "failed" && task.status !== "canceled") {
    res.status(409).json({ error: "只有失败或已取消的下载任务可以重试" });
    return;
  }

  await resumeDownloadTask(task);
  await addNotification({
    title: "下载任务已重试",
    message: `${task.title} · ${task.episodeName} 已重新加入队列。`,
    tone: "info",
    category: "download",
    taskId: task.id,
    sourceId: task.sourceId
  });
  const nextState = await readState();
  res.json({ task: nextState.downloads.find((item) => item.id === task.id), downloads: nextState.downloads });
});

app.delete("/api/downloads", async (req, res) => {
  const status = z.enum(["completed", "failed", "canceled"]).parse(req.query.status);
  const before = await readState();
  const removable = before.downloads.filter((task) => task.status === status);
  const state = await updateState((current) => {
    current.downloads = current.downloads.filter((task) => task.status !== status);
  });
  if (removable.length) {
    await addNotification({
      title: "下载任务已清理",
      message: `已清理 ${removable.length} 个${downloadStatusClearLabel(status)}任务，本地文件不会被删除。`,
      tone: "info",
      category: "download"
    });
  }
  res.json({ removed: removable.length, downloads: state.downloads });
});

app.delete("/api/downloads/:id", async (req, res) => {
  const before = await readState();
  const task = before.downloads.find((item) => item.id === req.params.id);
  if (task && (task.status === "queued" || task.status === "downloading")) {
    await cancelDownloadTask(task);
    const nextState = await readState();
    res.json({ downloads: nextState.downloads, canceled: true });
    return;
  }
  const state = await removeDownload(req.params.id);
  if (task) {
    await addNotification({
      title: "下载任务已移除",
      message: `${task.title} · ${task.episodeName} 已从队列移除，本地文件不会被删除。`,
      tone: "info",
      category: "download",
      taskId: task.id,
      sourceId: task.sourceId
    });
  }
  res.json({ downloads: state.downloads, canceled: false });
});

app.get("/api/notifications", async (_, res) => {
  const state = await readState();
  res.json(state.notifications);
});

app.post("/api/notifications/read", async (req, res) => {
  const ids = Array.isArray(req.body?.ids) ? req.body.ids.filter((id: unknown): id is string => typeof id === "string") : undefined;
  const state = await markNotificationsRead(ids);
  res.json(state.notifications);
});

app.delete("/api/notifications/read", async (req, res) => {
  const ids = Array.isArray(req.body?.ids) ? req.body.ids.filter((id: unknown): id is string => typeof id === "string") : undefined;
  const state = await clearReadNotifications(ids);
  res.json(state.notifications);
});

app.get("/api/scrapes", async (_, res) => {
  const state = await readState();
  res.json(state.scrapeHistory);
});

app.post("/api/downloads", async (req, res) => {
  const schema = z.object({
    title: z.string().min(1),
    episodeName: z.string().min(1),
    url: z.string().url(),
    sourceId: z.string().min(1)
  });
  const parsed = schema.parse(req.body);
  const task = await createDownloadTask(parsed);
  res.status(201).json(task);
});

app.get("/api/library", async (req, res) => {
  const host = req.get("host") ?? `localhost:${port}`;
  res.json(await scanLibrary(host));
});

app.get("/api/share", async (req, res) => {
  const host = req.get("host") ?? `localhost:${port}`;
  res.json(await buildShareSummary(host));
});

app.post("/api/library/:id/hls", async (req, res) => {
  const job = await buildLocalHls(req.params.id);
  const host = req.get("host") ?? `localhost:${port}`;
  res.status(202).json({
    ...job,
    hlsUrl: `http://${host}/hls/${encodeURIComponent(req.params.id)}/index.m3u8`
  });
});

app.get("/api/server", async (_, res) => {
  res.json({
    api: `http://localhost:${port}`,
    lanUrls: getLanUrls(port),
    mediaDir,
    hlsNote: "本地视频当前以 Range 流直接播放。安装 ffmpeg 后可扩展为自动切片 HLS 输出。"
  });
});

function absolutizeUrl(target: string, base: string) {
  try {
    return new URL(target, base).toString();
  } catch {
    return target;
  }
}

function proxiedStreamUrl(target: string) {
  return `/stream/fetch?url=${encodeURIComponent(target)}`;
}

function proxiedPlaylistUrl(target: string) {
  return `/stream/proxy.m3u8?url=${encodeURIComponent(target)}`;
}

function imageReferer(target: string) {
  try {
    const url = new URL(target);
    if (url.hostname.endsWith("doubanio.com")) return "https://movie.douban.com/";
    return `${url.origin}/`;
  } catch {
    return "https://movie.douban.com/";
  }
}

function rewriteAttributeUri(line: string, attribute: "URI", baseUrl: string) {
  return line.replace(new RegExp(`${attribute}="([^"]+)"`, "g"), (_, uri: string) => {
    const absolute = absolutizeUrl(uri, baseUrl);
    const proxy = /\.m3u8(\?|$)/i.test(absolute) ? proxiedPlaylistUrl(absolute) : proxiedStreamUrl(absolute);
    return `${attribute}="${proxy}"`;
  });
}

function rewriteM3u8(body: string, baseUrl: string) {
  return body
    .split(/\r?\n/)
    .map((line) => {
      const trimmed = line.trim();
      if (!trimmed) return line;

      if ((trimmed.startsWith("#EXT-X-KEY") || trimmed.startsWith("#EXT-X-MAP")) && trimmed.includes("URI=")) {
        return rewriteAttributeUri(line, "URI", baseUrl);
      }

      if (trimmed.startsWith("#")) return line;
      const absolute = absolutizeUrl(trimmed, baseUrl);
      return /\.m3u8(\?|$)/i.test(absolute) ? proxiedPlaylistUrl(absolute) : proxiedStreamUrl(absolute);
    })
    .join("\n");
}

app.get("/image/fetch", async (req, res) => {
  const target = String(req.query.url ?? "");
  if (!/^https?:\/\//i.test(target)) {
    res.status(400).json({ error: "Invalid image url" });
    return;
  }

  const headers: Record<string, string> = {
    "user-agent":
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125 Safari/537.36",
    accept: "image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8",
    referer: imageReferer(target)
  };

  const response = await fetch(target, { headers });
  if (!response.ok) {
    res.status(response.status).end();
    return;
  }

  const contentType = response.headers.get("content-type") ?? "image/jpeg";
  res.setHeader("Content-Type", contentType);
  res.setHeader("Cache-Control", "public, max-age=86400, stale-while-revalidate=604800");
  const contentLength = response.headers.get("content-length");
  if (contentLength) res.setHeader("Content-Length", contentLength);

  if (!response.body) {
    res.end();
    return;
  }

  const { Readable } = await import("node:stream");
  Readable.fromWeb(response.body as Parameters<typeof Readable.fromWeb>[0]).pipe(res);
});

app.get("/stream/proxy.m3u8", async (req, res) => {
  const target = String(req.query.url ?? "");
  if (!/^https?:\/\//i.test(target)) {
    res.status(400).send("#EXTM3U\n# Invalid url");
    return;
  }

  const response = await fetch(target, {
    headers: {
      "user-agent": "MovieHub/0.1 (+local-family-cinema)",
      accept: "application/vnd.apple.mpegurl,application/x-mpegURL,*/*"
    }
  });
  const body = await response.text();
  res.setHeader("Content-Type", "application/vnd.apple.mpegurl; charset=utf-8");
  res.send(rewriteM3u8(body, target));
});

app.get("/stream/fetch", async (req, res) => {
  const target = String(req.query.url ?? "");
  if (!/^https?:\/\//i.test(target)) {
    res.status(400).json({ error: "Invalid url" });
    return;
  }

  const headers: Record<string, string> = {
    "user-agent": "MovieHub/0.1 (+local-family-cinema)"
  };
  const range = req.headers.range;
  if (range) headers.range = range;

  const response = await fetch(target, { headers });
  res.status(response.status);
  response.headers.forEach((value, key) => {
    if (!["content-encoding", "transfer-encoding"].includes(key.toLowerCase())) {
      res.setHeader(key, value);
    }
  });

  if (!response.body) {
    res.end();
    return;
  }

  // Web streams can pipe to Node streams through Readable.fromWeb in modern Node.
  const { Readable } = await import("node:stream");
  Readable.fromWeb(response.body as Parameters<typeof Readable.fromWeb>[0]).pipe(res);
});

app.get(/^\/media\/(.+)$/, (req, res) => {
  req.params.fileName = req.params[0];
  streamLocalVideo(req, res);
});

app.all(/^\/dav\/?(.*)$/, async (req, res) => {
  const target = req.params[0] ?? "";
  try {
    if (req.method === "PROPFIND") {
      await handleDavPropfind(req, res, target);
      return;
    }
    if (req.method === "GET" || req.method === "HEAD") {
      await handleDavRead(req, res, target);
      return;
    }
    res.setHeader("Allow", "GET, HEAD, OPTIONS, PROPFIND");
    res.status(405).end();
  } catch (error) {
    res.status(500).json({ error: error instanceof Error ? error.message : "WebDAV 共享失败" });
  }
});

app.use("/hls", express.static(hlsDir));
app.use("/hls", express.static(legacyHlsDir));
app.use(express.static(path.resolve("dist")));
app.get(/^(?!\/api|\/stream|\/image|\/media|\/hls|\/dav).*/, (_, res) => {
  res.sendFile(path.resolve("dist", "index.html"));
});

app.listen(port, "0.0.0.0", () => {
  console.log(`Movie Hub API listening on http://localhost:${port}`);
  console.log(`Media directory: ${mediaDir}`);
  void announceMissingRuntimeTools().catch((error) => {
    console.error("Runtime tool check failed:", error);
  });
  void settleStaleLocalHlsJobs().catch((error) => {
    console.error("Reset stale local HLS jobs failed:", error);
  });
  void startReadOnlyFtpShare(mediaDir).then((state) => {
    if (state.active) console.log(`Read-only FTP share listening on ftp://localhost:${state.port}`);
    else console.error(`Read-only FTP share failed: ${state.error ?? "unknown error"}`);
  });
  void resumeDownloadQueue()
    .then((count) => {
      if (count) console.log(`Resumed ${count} download task(s).`);
    })
    .catch((error) => {
      console.error("Resume download queue failed:", error);
    });
  setTimeout(() => {
    void refreshDoubanPosterCache().catch((error) => {
      console.error("Initial Douban poster refresh failed:", error);
    });
  }, 4000);
  setInterval(() => {
    void refreshDoubanPosterCache().catch((error) => {
      console.error("Auto Douban poster refresh failed:", error);
    });
  }, 2 * 60 * 60 * 1000);
  setTimeout(() => {
    void runScheduledWatchlistCheck().catch((error) => {
      console.error("Initial watchlist check failed:", error);
    });
  }, 10000);
  setInterval(() => {
    void runScheduledWatchlistCheck().catch((error) => {
      console.error("Auto watchlist check failed:", error);
    });
  }, 60 * 1000);
  setTimeout(() => {
    void runScheduledSourceHealthCheck().catch((error) => {
      console.error("Initial source health check failed:", error);
    });
  }, 6000);
  setInterval(() => {
    void runScheduledSourceHealthCheck().catch((error) => {
      console.error("Auto source health check failed:", error);
    });
  }, 60 * 1000);
});

async function settleStaleLocalHlsJobs() {
  const now = new Date().toISOString();
  await updateState((state) => {
    state.hlsJobs = state.hlsJobs.map((job) =>
      job.status === "queued" || job.status === "running"
        ? {
            ...job,
            status: "failed",
            progress: Math.min(job.progress, 96),
            message: "服务重启，HLS 任务已中断",
            updatedAt: now
          }
        : job
    );
  });
  setTimeout(() => {
    void syncAllCompletedDownloads().catch((error) => {
      console.error("Initial Emby sync failed:", error);
    });
  }, 5000);
}
