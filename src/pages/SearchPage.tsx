import { ArrowDownAZ, ChevronDown, ChevronLeft, ChevronRight, Clock3, Filter, History, Loader2, Play, Search, Server, Star, Square, Trash2, X, XCircle } from "lucide-react";
import type { FormEvent } from "react";
import { useEffect, useMemo, useRef, useState } from "react";
import { searchResources } from "../lib/api";
import { imageUrlFor, kindText } from "../lib/format";
import { useStoredState } from "../lib/storage";
import type { CatalogItem, SourceSite } from "../types";

type SearchPageProps = {
  sites: SourceSite[];
  initialKeyword: string;
  onOpen: (item: CatalogItem) => void;
  onNotify: (message: string, tone?: "good" | "warn" | "bad") => void;
};

type SiteSearchStatus = {
  siteId: string;
  siteName: string;
  status: "searching" | "done" | "empty" | "failed";
  count: number;
  elapsedMs?: number;
  message?: string;
};

type ResultFilter = "all" | "playable" | "scored";
type ResultSort = "append" | "score-desc" | "episodes-desc" | "title-asc";

const resultPageSizeOptions = [10, 20, 50, 100];
const resultFilterValues = ["all", "playable", "scored"] satisfies ResultFilter[];
const resultSortValues = ["append", "score-desc", "episodes-desc", "title-asc"] satisfies ResultSort[];
const maxSearchHistory = 8;

function resultKey(item: CatalogItem) {
  return `${item.sourceId}-${item.vodId}`;
}

function uniqueAppend(current: CatalogItem[], incoming: CatalogItem[]) {
  const seen = new Set(current.map(resultKey));
  const next = [...current];
  for (const item of incoming) {
    const key = resultKey(item);
    if (seen.has(key)) continue;
    seen.add(key);
    next.push(item);
  }
  return next;
}

export function SearchPage({ sites, initialKeyword, onOpen, onNotify }: SearchPageProps) {
  const searchRunRef = useRef(0);
  const searchAbortRef = useRef<AbortController | null>(null);
  const searchRemainingRef = useRef(0);
  const lastAutoSearchKeyRef = useRef("");
  const [keyword, setKeyword] = useState(initialKeyword);
  const [siteId, setSiteId] = useState("all");
  const [items, setItems] = useState<CatalogItem[]>([]);
  const [errors, setErrors] = useState<string[]>([]);
  const [siteStatuses, setSiteStatuses] = useState<SiteSearchStatus[]>([]);
  const [pendingCount, setPendingCount] = useState(0);
  const [resultQuery, setResultQuery] = useState("");
  const [searchHistory, setSearchHistory] = useStoredState<string[]>("movie-hub.search.history", [], { validate: isSearchHistory });
  const [resultFilter, setResultFilter] = useStoredState<ResultFilter>("movie-hub.search.resultFilter", "all", { validate: isResultFilter });
  const [resultSourceId, setResultSourceId] = useState("all");
  const [resultSort, setResultSort] = useStoredState<ResultSort>("movie-hub.search.resultSort", "append", { validate: isResultSort });
  const [resultPage, setResultPage] = useState(1);
  const [resultPageSize, setResultPageSize] = useStoredState<number>("movie-hub.search.resultPageSize", 20, { validate: isResultPageSize });
  const searchableSites = useMemo(() => sites.filter((site) => site.enabled && site.searchable), [sites]);
  const loading = pendingCount > 0;
  const completedCount = siteStatuses.filter((site) => site.status !== "searching").length;
  const normalizedResultQuery = resultQuery.trim().toLowerCase();
  const resultSourceOptions = useMemo(() => {
    const sourceMap = new Map<string, { sourceId: string; sourceName: string; count: number }>();
    for (const item of items) {
      const current = sourceMap.get(item.sourceId);
      if (current) {
        current.count += 1;
      } else {
        sourceMap.set(item.sourceId, { sourceId: item.sourceId, sourceName: item.sourceName, count: 1 });
      }
    }
    return [...sourceMap.values()].sort((left, right) => right.count - left.count || left.sourceName.localeCompare(right.sourceName, "zh-CN"));
  }, [items]);
  const filteredItems = useMemo(() => {
    const filtered = items.filter((item) => {
      if (resultSourceId !== "all" && item.sourceId !== resultSourceId) return false;
      if (resultFilter === "playable" && item.episodes.length === 0) return false;
      if (resultFilter === "scored" && !item.score) return false;
      if (!normalizedResultQuery) return true;
      return [item.title, item.originalTitle, item.sourceName, item.typeName, item.remarks, item.description, item.year, item.area, item.language].some((value) =>
        value?.toLowerCase().includes(normalizedResultQuery)
      );
    });

    return [...filtered].sort((left, right) => {
      if (resultSort === "score-desc") return scoreValue(right.score) - scoreValue(left.score);
      if (resultSort === "episodes-desc") return right.episodes.length - left.episodes.length;
      if (resultSort === "title-asc") return left.title.localeCompare(right.title, "zh-CN");
      return 0;
    });
  }, [items, normalizedResultQuery, resultFilter, resultSort, resultSourceId]);
  const resultPageCount = Math.max(1, Math.ceil(filteredItems.length / resultPageSize));
  const currentResultPage = Math.min(resultPage, resultPageCount);
  const resultPageStart = (currentResultPage - 1) * resultPageSize;
  const resultPageEnd = Math.min(resultPageStart + resultPageSize, filteredItems.length);
  const pageItems = useMemo(() => filteredItems.slice(resultPageStart, resultPageEnd), [filteredItems, resultPageEnd, resultPageStart]);
  const resultFilters = [
    { value: "all" as const, label: "全部", count: items.length },
    { value: "playable" as const, label: "有分集", count: items.filter((item) => item.episodes.length > 0).length },
    { value: "scored" as const, label: "有评分", count: items.filter((item) => item.score).length }
  ];
  const selectedResultSourceName =
    resultSourceId === "all" ? "全部资源站" : resultSourceOptions.find((source) => source.sourceId === resultSourceId)?.sourceName ?? "当前资源站";

  useEffect(() => {
    setResultPage(1);
  }, [normalizedResultQuery, resultFilter, resultPageSize, resultSort, resultSourceId]);

  useEffect(() => {
    if (resultSourceId !== "all" && !resultSourceOptions.some((source) => source.sourceId === resultSourceId)) {
      setResultSourceId("all");
    }
  }, [resultSourceId, resultSourceOptions]);

  useEffect(() => {
    if (resultPage > resultPageCount) setResultPage(resultPageCount);
  }, [resultPage, resultPageCount]);

  useEffect(() => {
    const query = initialKeyword.trim();
    setKeyword(query);
    if (!query || !searchableSites.length) return;
    const autoSearchKey = `${query}:${searchableSites.map((site) => site.id).join(",")}`;
    if (lastAutoSearchKeyRef.current === autoSearchKey) return;
    lastAutoSearchKeyRef.current = autoSearchKey;
    setSiteId("all");
    void runSearch(query, "all");
  }, [initialKeyword, searchableSites]);

  useEffect(() => {
    return () => searchAbortRef.current?.abort();
  }, []);

  async function runSearch(query: string, targetSiteId: string) {
    const cleanQuery = query.trim();
    if (!cleanQuery) return;

    const targets = targetSiteId === "all" ? searchableSites : searchableSites.filter((site) => site.id === targetSiteId);
    if (!targets.length) {
      onNotify("没有可搜索的资源站", "warn");
      return;
    }

    const runId = searchRunRef.current + 1;
    searchRunRef.current = runId;
    searchAbortRef.current?.abort();
    const controller = new AbortController();
    searchAbortRef.current = controller;
    searchRemainingRef.current = targets.length;
    setItems([]);
    setErrors([]);
    setResultQuery("");
    setResultSourceId("all");
    setResultPage(1);
    rememberSearch(cleanQuery);
    setPendingCount(targets.length);
    setSiteStatuses(
      targets.map((site) => ({
        siteId: site.id,
        siteName: site.name,
        status: "searching",
        count: 0
      }))
    );

    if (targets.length > 1) onNotify(`开始并行检索 ${targets.length} 个资源站`);

    targets.forEach((site) => {
      void searchOneSite(runId, cleanQuery, site, targets.length > 1, controller.signal);
    });
  }

  function stopSearch() {
    searchAbortRef.current?.abort();
    searchAbortRef.current = null;
    searchRunRef.current += 1;
    setPendingCount(0);
    setSiteStatuses((current) =>
      current.map((entry) =>
        entry.status === "searching"
          ? {
              ...entry,
              status: "failed",
              message: "已停止"
            }
          : entry
      )
    );
    onNotify("已停止当前资源站检索", "warn");
    searchRemainingRef.current = 0;
  }

  async function submit(event: FormEvent) {
    event.preventDefault();
    await runSearch(keyword, siteId);
  }

  function submitResultFilter(event: FormEvent) {
    event.preventDefault();
    setResultPage(1);
  }

  function rememberSearch(query: string) {
    setSearchHistory((current) => [query, ...current.filter((item) => item !== query)].slice(0, maxSearchHistory));
  }

  function useHistoryKeyword(query: string) {
    setKeyword(query);
    setSiteId("all");
    void runSearch(query, "all");
  }

  function clearSearchHistory() {
    setSearchHistory([]);
    onNotify("搜索历史已清空");
  }

  async function searchOneSite(runId: number, query: string, site: SourceSite, silent: boolean, signal: AbortSignal) {
    const startedAt = performance.now();
    try {
      const data = await searchResources(query, site.id, { silent, signal });
      if (searchRunRef.current !== runId) return;

      const elapsedMs = Math.round(performance.now() - startedAt);
      setItems((current) => uniqueAppend(current, data.results));
      setErrors((current) => [...current, ...data.errors.map((error) => `${site.name}: ${error}`)]);
      setSiteStatuses((current) =>
        current.map((entry) =>
          entry.siteId === site.id
            ? {
                ...entry,
                status: data.results.length ? "done" : "empty",
                count: data.results.length,
                elapsedMs,
                message: data.errors[0]
              }
            : entry
        )
      );
    } catch (error) {
      if (searchRunRef.current !== runId) return;
      if (error instanceof DOMException && error.name === "AbortError") return;

      const message = error instanceof Error ? error.message : "资源站搜索失败";
      setErrors((current) => [...current, `${site.name}: ${message}`]);
      setSiteStatuses((current) =>
        current.map((entry) =>
          entry.siteId === site.id
            ? {
                ...entry,
                status: "failed",
                count: 0,
                elapsedMs: Math.round(performance.now() - startedAt),
                message
              }
            : entry
        )
      );
    } finally {
      if (searchRunRef.current === runId) {
        const nextPending = Math.max(0, searchRemainingRef.current - 1);
        searchRemainingRef.current = nextPending;
        setPendingCount(nextPending);
        if (nextPending === 0 && searchAbortRef.current?.signal === signal) {
          searchAbortRef.current = null;
        }
      }
    }
  }

  return (
    <section className="page-stack search-page">
      <form className="searchbar page-search" onSubmit={submit}>
        <Search size={18} />
        <input value={keyword} onChange={(event) => setKeyword(event.target.value)} placeholder="搜索影片、剧集、动漫..." />
        <label>
          <select value={siteId} onChange={(event) => setSiteId(event.target.value)} disabled={loading}>
            <option value="all">全部可搜资源站</option>
            {searchableSites.map((site) => (
              <option key={site.id} value={site.id}>
                {site.name}
              </option>
            ))}
          </select>
          <ChevronDown size={15} />
        </label>
        <button type="submit">
          {loading ? <Loader2 className="spin" size={18} /> : <Search size={18} />}
          {loading ? "重新搜索" : "搜索"}
        </button>
        {loading ? (
          <button className="search-stop-button" type="button" onClick={stopSearch}>
            <Square size={15} />
            停止
          </button>
        ) : null}
      </form>

      {searchHistory.length ? (
        <div className="search-history-strip" aria-label="最近搜索">
          <div>
            <History size={15} />
            <span>最近搜索</span>
          </div>
          {searchHistory.map((entry) => (
            <button type="button" key={entry} onClick={() => useHistoryKeyword(entry)} title={`搜索 ${entry}`}>
              {entry}
            </button>
          ))}
          <button className="search-history-clear" type="button" onClick={clearSearchHistory} title="清空搜索历史">
            <Trash2 size={14} />
          </button>
        </div>
      ) : null}

      {siteStatuses.length > 0 && (
        <div className="search-progress-panel">
          <div className="search-progress-head">
            <span>
              {completedCount}/{siteStatuses.length} 资源站完成
            </span>
            <strong>{items.length} 条结果</strong>
          </div>
          <div className="search-source-grid">
            {siteStatuses.map((site) => (
              <article className={`search-source-chip ${site.status}`} key={site.siteId}>
                {site.status === "searching" ? <Loader2 className="spin" size={14} /> : statusIcon(site.status)}
                <span>{site.siteName}</span>
                <strong>{statusText(site)}</strong>
              </article>
            ))}
          </div>
        </div>
      )}

      {errors.length > 0 && (
        <div className="error-strip">
          {errors.slice(0, 6).map((error) => (
            <span key={error}>{error}</span>
          ))}
        </div>
      )}

      {items.length ? (
        <>
          <section className="search-result-controls" aria-label="搜索结果筛选">
            <form className="search-result-toolbar" onSubmit={submitResultFilter}>
              <label className="search-result-filter-input">
                <Search size={16} />
                <input value={resultQuery} onChange={(event) => setResultQuery(event.target.value)} placeholder="在结果中筛标题、资源站、年份或简介" />
                {resultQuery ? (
                  <button type="button" onClick={() => setResultQuery("")} title="清空过滤">
                    <X size={14} />
                  </button>
                ) : null}
              </label>
              <label className="search-result-sort">
                <ArrowDownAZ size={15} />
                <select value={resultSort} onChange={(event) => setResultSort(event.target.value as ResultSort)}>
                  <option value="append">到达顺序</option>
                  <option value="score-desc">评分优先</option>
                  <option value="episodes-desc">分集最多</option>
                  <option value="title-asc">标题 A-Z</option>
                </select>
              </label>
              <button className="tool-button toolbar-search-button" type="submit">
                <Filter size={15} />
                过滤
              </button>
            </form>

            <div className="search-result-filter-tabs">
              {resultFilters.map((filter) => (
                <button
                  className={resultFilter === filter.value ? "active" : ""}
                  key={filter.value}
                  type="button"
                  onClick={() => setResultFilter(filter.value)}
                >
                  <span>{filter.label}</span>
                  <b>{filter.count}</b>
                </button>
              ))}
            </div>

            {resultSourceOptions.length > 1 ? (
              <div className="search-result-source-strip" aria-label="按资源站筛选搜索结果">
                <button className={resultSourceId === "all" ? "active" : ""} type="button" onClick={() => setResultSourceId("all")}>
                  <Server size={14} />
                  <span>全部来源</span>
                  <b>{items.length}</b>
                </button>
                {resultSourceOptions.map((source) => (
                  <button
                    className={resultSourceId === source.sourceId ? "active" : ""}
                    key={source.sourceId}
                    type="button"
                    onClick={() => setResultSourceId(source.sourceId)}
                  >
                    <Server size={14} />
                    <span>{source.sourceName}</span>
                    <b>{source.count}</b>
                  </button>
                ))}
              </div>
            ) : null}

            <div className="search-result-summary">
              <span>{selectedResultSourceName}</span>
              <b>{filteredItems.length} 条匹配</b>
              {loading ? <small>仍在追加结果</small> : null}
            </div>
          </section>

          {filteredItems.length ? (
            <>
              <div className="search-result-list">
                {pageItems.map((item) => (
                  <SearchResultCard item={item} key={resultKey(item)} onOpen={onOpen} />
                ))}
              </div>
              <div className="search-result-pagination" aria-label="搜索结果分页">
                <span>
                  第 {currentResultPage} / {resultPageCount} 页 · 显示 {resultPageStart + 1}-{resultPageEnd} / {filteredItems.length}
                </span>
                <label>
                  每页
                  <select value={resultPageSize} onChange={(event) => setResultPageSize(Number(event.target.value))}>
                    {resultPageSizeOptions.map((size) => (
                      <option key={size} value={size}>
                        {size}
                      </option>
                    ))}
                  </select>
                </label>
                <div className="search-result-page-buttons">
                  <button type="button" onClick={() => setResultPage((value) => Math.max(1, value - 1))} disabled={currentResultPage <= 1}>
                    <ChevronLeft size={16} />
                    上一页
                  </button>
                  <button type="button" onClick={() => setResultPage((value) => Math.min(resultPageCount, value + 1))} disabled={currentResultPage >= resultPageCount}>
                    下一页
                    <ChevronRight size={16} />
                  </button>
                </div>
              </div>
            </>
          ) : (
            <div className="empty-wall">没有匹配的结果</div>
          )}
        </>
      ) : (
        <div className="empty-wall">{loading ? "正在并行搜索资源站，结果会陆续出现..." : "搜索结果会出现在这里"}</div>
      )}
    </section>
  );
}

function scoreValue(score?: string) {
  if (!score) return -1;
  const value = Number(score);
  return Number.isFinite(value) ? value : -1;
}

function statusText(site: SiteSearchStatus) {
  if (site.status === "searching") return "检索中";
  if (site.status === "failed") return "失败";
  if (site.status === "empty") return site.elapsedMs ? `无结果 · ${site.elapsedMs}ms` : "无结果";
  return site.elapsedMs ? `${site.count} 条 · ${site.elapsedMs}ms` : `${site.count} 条`;
}

function statusIcon(status: SiteSearchStatus["status"]) {
  if (status === "failed") return <XCircle size={14} />;
  if (status === "empty") return <Clock3 size={14} />;
  return <Server size={14} />;
}

function isResultFilter(value: unknown): value is ResultFilter {
  return typeof value === "string" && resultFilterValues.includes(value as ResultFilter);
}

function isResultSort(value: unknown): value is ResultSort {
  return typeof value === "string" && resultSortValues.includes(value as ResultSort);
}

function isResultPageSize(value: unknown): value is number {
  return typeof value === "number" && resultPageSizeOptions.includes(value);
}

function isSearchHistory(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}

function SearchResultCard({ item, onOpen }: { item: CatalogItem; onOpen: (item: CatalogItem) => void }) {
  const meta = [item.year, item.area, item.language, item.typeName ?? kindText(item.kind)].filter(Boolean).join(" · ");
  const episodeCount = item.episodes.length;

  return (
    <article className="search-result-card">
      <button className="search-result-poster" type="button" onClick={() => onOpen(item)}>
        {item.poster ? <img src={imageUrlFor(item.poster)} alt={item.title} loading="lazy" /> : <span>{item.title}</span>}
        {item.score && (
          <b>
            <Star size={12} />
            {item.score}
          </b>
        )}
      </button>
      <div className="search-result-copy">
        <div>
          <p className="eyebrow">{item.sourceName}</p>
          <h3>{item.title}</h3>
          {item.originalTitle && item.originalTitle !== item.title && <small>{item.originalTitle}</small>}
        </div>
        <div className="search-result-tags">
          {meta && <span>{meta}</span>}
          {item.remarks && <span>{item.remarks}</span>}
          <span>{episodeCount ? `${episodeCount} 集` : "暂无分集"}</span>
        </div>
        {item.description && <p>{item.description}</p>}
      </div>
      <button className="search-result-action" type="button" onClick={() => onOpen(item)}>
        <Play size={16} />
        打开
      </button>
    </article>
  );
}
