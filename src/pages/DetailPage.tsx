import { Bell, Download, HardDrive, Loader2, Play, RefreshCw, Route, Search, Star } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { VideoPlayer } from "../components/VideoPlayer";
import { addWatch, createDownloadTask, getCatalogItem, matchSources } from "../lib/api";
import { imageUrlFor, kindText, playerUrlFor, routeStatusText } from "../lib/format";
import { toolWarningText } from "../lib/toolWarnings";
import type { CatalogItem, Episode, SourceMatchResponse, SourceRoute, SourceRouteMetric, ToolsStatusResponse } from "../types";

type DetailPageProps = {
  sourceId: string;
  vodId: string;
  toolsStatus?: ToolsStatusResponse | null;
  onNotify: (message: string, tone?: "good" | "warn" | "bad") => void;
};

type RouteFilter = "available" | "recommended" | "all" | "problem";

export function DetailPage({ sourceId, vodId, toolsStatus, onNotify }: DetailPageProps) {
  const [subject, setSubject] = useState<CatalogItem | null>(null);
  const [match, setMatch] = useState<SourceMatchResponse | null>(null);
  const [selectedRouteId, setSelectedRouteId] = useState<string | null>(null);
  const [currentEpisodeId, setCurrentEpisodeId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [matching, setMatching] = useState(false);
  const [routeFilter, setRouteFilter] = useState<RouteFilter>("available");
  const [routeQuery, setRouteQuery] = useState("");

  const selectedRoute = useMemo(() => {
    if (!match) return undefined;
    return match.routes.find((route) => route.siteId === selectedRouteId) ?? match.recommendedRoute ?? match.routes.find((route) => route.item);
  }, [match, selectedRouteId]);

  const playableItem = selectedRoute?.item ?? match?.selectedItem ?? subject;
  const episodes = playableItem?.episodes ?? [];
  const currentEpisode = episodes.find((episode) => episode.id === currentEpisodeId) ?? episodes[0];
  const playerUrl = currentEpisode ? playerUrlFor(currentEpisode.url) : "";
  const normalizedRouteQuery = routeQuery.trim().toLocaleLowerCase("zh-CN");
  const filteredRoutes = useMemo(() => {
    const routes = match?.routes ?? [];
    return routes.filter((routeItem) => {
      if (routeFilter === "available" && !routeItem.playable) return false;
      if (routeFilter === "recommended" && match?.recommendedRoute?.siteId !== routeItem.siteId) return false;
      if (routeFilter === "problem" && routeItem.status !== "failed" && routeItem.status !== "missing") return false;
      if (!normalizedRouteQuery) return true;
      return [
        routeItem.siteName,
        routeItem.candidateTitle,
        routeItem.remarks,
        routeItem.error,
        routeItem.quality.label,
        routeStatusText(routeItem),
        ...routeItem.reasons,
        ...routeItem.metrics.flatMap((metric) => [metric.label, metric.value, metric.description])
      ].some((value) => value?.toLocaleLowerCase("zh-CN").includes(normalizedRouteQuery));
    });
  }, [match, normalizedRouteQuery, routeFilter]);
  const routeFilterOptions = useMemo(() => {
    const routes = match?.routes ?? [];
    return [
      { key: "available" as const, label: "可播", count: routes.filter((routeItem) => routeItem.playable).length },
      { key: "recommended" as const, label: "推荐", count: match?.recommendedRoute ? 1 : 0 },
      { key: "all" as const, label: "全部", count: routes.length },
      { key: "problem" as const, label: "异常", count: routes.filter((routeItem) => routeItem.status === "failed" || routeItem.status === "missing").length }
    ];
  }, [match]);

  async function load() {
    setLoading(true);
    try {
      const item = await getCatalogItem(sourceId, vodId);
      setSubject(item);
      await evaluate(item);
    } catch (error) {
      onNotify(error instanceof Error ? error.message : "详情加载失败", "bad");
    } finally {
      setLoading(false);
    }
  }

  async function evaluate(item = subject) {
    if (!item) return;
    setMatching(true);
    try {
      const data = await matchSources(item);
      setMatch(data);
      const recommended = data.recommendedRoute ?? data.routes.find((route) => route.item);
      setSelectedRouteId(recommended?.siteId ?? null);
      setCurrentEpisodeId(recommended?.item?.episodes[0]?.id ?? null);
      onNotify(recommended?.item ? `已推荐 ${recommended.siteName}` : "没有找到可播放线路", recommended?.item ? "good" : "warn");
    } catch (error) {
      onNotify(error instanceof Error ? error.message : "线路评测失败", "bad");
    } finally {
      setMatching(false);
    }
  }

  function selectRoute(routeItem: SourceRoute) {
    setSelectedRouteId(routeItem.siteId);
    setCurrentEpisodeId(routeItem.item?.episodes[0]?.id ?? null);
    onNotify(routeItem.item ? `已切换到 ${routeItem.siteName}` : `${routeItem.siteName} 暂无可播放资源`, routeItem.item ? "good" : "warn");
  }

  async function watch(autoDownload = false) {
    if (!playableItem) return;
    if (autoDownload) {
      const warning = toolWarningText(toolsStatus, "download");
      if (warning) onNotify(warning, "warn");
    }
    await addWatch(playableItem, autoDownload);
    onNotify(autoDownload ? "已开启追剧与自动下载" : "已加入追剧提醒");
  }

  async function downloadEpisode() {
    if (!playableItem || !currentEpisode) return;
    const warning = toolWarningText(toolsStatus, "download");
    if (warning) onNotify(warning, "warn");
    try {
      await createDownloadTask(playableItem, currentEpisode.name, currentEpisode.url, currentEpisode.sourceId);
      onNotify("已加入下载队列");
    } catch (error) {
      onNotify(error instanceof Error ? error.message : "下载任务创建失败", "bad");
    }
  }

  useEffect(() => {
    void load();
  }, [sourceId, vodId]);

  if (loading && !subject) {
    return (
      <div className="center-state">
        <Loader2 className="spin" size={28} />
        <span>正在准备详情页...</span>
      </div>
    );
  }

  if (!subject) {
    return <div className="center-state">没有找到这个条目</div>;
  }

  const heroPoster = imageUrlFor(playableItem?.poster ?? subject.poster);
  const heroBackdrop = imageUrlFor(playableItem?.backdrop ?? playableItem?.poster ?? subject.backdrop ?? subject.poster);

  return (
    <section className="detail-page detail-console">
      <section className="detail-overview" style={{ "--backdrop": heroBackdrop ? `url("${heroBackdrop}")` : "none" } as React.CSSProperties}>
        <div className="detail-poster detail-poster-compact">
          {heroPoster ? <img src={heroPoster} alt={subject.title} /> : <span>{subject.title}</span>}
        </div>
        <div className="detail-copy">
          <p className="eyebrow">{kindText(subject.kind)} / {subject.sourceName}</p>
          <h1>{subject.title}</h1>
          <div className="detail-tags">
            {subject.score && (
              <span>
                <Star size={14} />
                豆瓣 {subject.score}
              </span>
            )}
            {subject.year && <span>{subject.year}</span>}
            {subject.remarks && <span>{subject.remarks}</span>}
            {selectedRoute && <span>当前线路：{selectedRoute.siteName}</span>}
          </div>
          <p>{playableItem?.description ?? subject.description ?? "详情页会根据这个条目并行评估所有已配置资源站，自动选择最优播放线路。"}</p>
          <div className="detail-actions">
            <button type="button" onClick={() => void evaluate()} disabled={matching}>
              {matching ? <Loader2 className="spin" size={17} /> : <RefreshCw size={17} />}
              重新评测
            </button>
            <button type="button" onClick={() => void watch()}>
              <Bell size={17} />
              追踪更新
            </button>
            <button type="button" onClick={() => void watch(true)}>
              <HardDrive size={17} />
              自动下载
            </button>
            <button type="button" onClick={() => void downloadEpisode()} disabled={!currentEpisode}>
              <Download size={17} />
              下载本集
            </button>
          </div>
        </div>
      </section>

      <section className="detail-workbench">
        <section className="watch-player-card detail-player-panel">
          {playerUrl ? (
            <VideoPlayer url={playerUrl} title={`${playableItem?.title ?? subject.title} ${currentEpisode?.name ?? ""}`} />
          ) : (
            <div className="empty-player">
              <Route size={42} />
              <span>{matching ? "正在评测所有资源站线路..." : "暂无可播放分集"}</span>
            </div>
          )}
          <div className="inline-player-meta">
            <strong>{currentEpisode ? currentEpisode.name : "等待选择分集"}</strong>
            <span>{currentEpisode?.sourceName ?? selectedRoute?.siteName ?? "尚未选中线路"}</span>
          </div>
        </section>

        <section className="route-panel detail-routes-panel">
          <div className="panel-title">
            <div>
              <p className="eyebrow">Route Matrix</p>
              <h3>资源站线路评估</h3>
            </div>
            {matching && <Loader2 className="spin" size={18} />}
          </div>
          <div className="route-tools">
            <label className="route-search">
              <Search size={14} />
              <input value={routeQuery} onChange={(event) => setRouteQuery(event.target.value)} placeholder="筛选线路或资源站" />
            </label>
            <div className="route-filter-tabs" aria-label="线路筛选">
              {routeFilterOptions.map((filter) => (
                <button className={routeFilter === filter.key ? "active" : ""} key={filter.key} type="button" onClick={() => setRouteFilter(filter.key)}>
                  {filter.label}
                  <b>{filter.count}</b>
                </button>
              ))}
            </div>
          </div>
          <div className="route-list">
            {filteredRoutes.length ? (
              filteredRoutes.map((routeItem) => (
                <button
                  className={`route-card ${routeItem.status} ${selectedRoute?.siteId === routeItem.siteId ? "active" : ""}`}
                  key={routeItem.siteId}
                  type="button"
                  onClick={() => selectRoute(routeItem)}
                >
                  <span className="route-card-main">
                    <strong>{routeItem.siteName}</strong>
                    <small title={routeItem.error ?? undefined}>
                      {routeStatusText(routeItem)}
                      {match?.recommendedRoute?.siteId === routeItem.siteId ? " / 推荐" : ""}
                      {routeItem.error ? ` / ${routeItem.error}` : ""}
                    </small>
                  </span>
                  <span className="route-signal-strip">
                    {routeSignals(routeItem).map((metric) => (
                      <span className={`route-signal ${metric.tone}`} key={metric.key} title={metric.description ?? metric.label}>
                        <small>{compactMetricLabel(metric)}</small>
                        <strong>{compactMetricValue(metric)}</strong>
                      </span>
                    ))}
                  </span>
                  <span className="route-score-cell">
                    <b>{routeItem.score}</b>
                    <em>{routeItem.quality.label}</em>
                  </span>
                </button>
              ))
            ) : (
              <div className="empty-small">{matching ? "正在并行请求资源站..." : match?.routes.length ? "没有匹配的线路" : "暂无线路评估结果"}</div>
            )}
          </div>
        </section>
      </section>

      <section className="episode-panel detail-episodes-panel detail-episodes-wide">
        <div className="panel-title">
          <div>
            <p className="eyebrow">Episodes</p>
            <h3>分集播放</h3>
          </div>
          <span>{episodes.length} 集</span>
        </div>
        {episodes.length ? (
          <div className="episode-grid">
            {episodes.map((episode: Episode) => (
              <button className={currentEpisode?.id === episode.id ? "active" : ""} key={episode.id} type="button" onClick={() => setCurrentEpisodeId(episode.id)}>
                <Play size={13} />
                <span>{episode.name}</span>
              </button>
            ))}
          </div>
        ) : (
          <div className="empty-small">当前线路没有解析到 m3u8/mp4 分集</div>
        )}
      </section>

    </section>
  );
}

function routeSignals(routeItem: SourceRoute) {
  const keys: SourceRouteMetric["key"][] = ["latency", "speed", "episodes", "stability", "quality", "match"];
  const byKey = new Map(routeItem.metrics.map((metric) => [metric.key, metric]));
  return keys.flatMap((key) => {
    const metric = byKey.get(key);
    return metric ? [metric] : [];
  });
}

function compactMetricLabel(metric: SourceRouteMetric) {
  return {
    latency: "延迟",
    speed: "速度",
    episodes: "集数",
    stability: "稳定",
    quality: "清晰",
    match: "匹配",
    availability: "可用",
    freshness: "新鲜",
    reliability: "可靠"
  }[metric.key];
}

function compactMetricValue(metric: SourceRouteMetric) {
  if (metric.key === "episodes") {
    const count = metric.value.match(/\d+/)?.[0];
    return count ? `${count}集` : metric.value;
  }
  if (metric.key === "latency") {
    const value = Number(metric.value.match(/\d+/)?.[0] ?? 0);
    if (value >= 1000) return `${(value / 1000).toFixed(1)}s`;
    return value ? `${value}ms` : "未知";
  }
  if (metric.key === "speed") {
    const value = Number(metric.value.match(/\d+/)?.[0] ?? 0);
    if (value >= 1000) return `${(value / 1000).toFixed(1)}M`;
    return value ? `${value}k` : "未知";
  }
  if (metric.key === "match") return metric.score >= 90 ? "命中" : metric.score >= 60 ? "近似" : "偏离";
  if (metric.key === "quality") return metric.value.replace("超清/", "").replace("普通", "普清");
  if (metric.key === "stability") {
    return metric.value
      .replace("基本稳定", "稳定")
      .replace("可能卡顿", "卡顿")
      .replace("不可播放", "失败");
  }
  if (metric.key === "reliability") return metric.value.replace("候选", "");
  return metric.value;
}
