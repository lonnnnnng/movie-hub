import { Bell, ChevronLeft, ChevronRight, DownloadCloud, Loader2, RefreshCw, Search, ServerCog, Wrench } from "lucide-react";
import type { CSSProperties, FormEvent, ReactNode } from "react";
import { useEffect, useRef, useState } from "react";
import { PosterCard } from "../components/PosterCard";
import { getDoubanTrending } from "../lib/api";
import { formatTime } from "../lib/format";
import { missingToolLabels } from "../lib/toolWarnings";
import type { AppState, CatalogItem, HubStats, ToolsStatusResponse } from "../types";

type HomePageProps = {
  state: AppState;
  stats: HubStats | null;
  toolsStatus: ToolsStatusResponse | null;
  onOpen: (item: CatalogItem) => void;
  onSearch: (keyword: string) => void;
  onNotify: (message: string, tone?: "good" | "warn" | "bad") => void;
  onOpenDownloads: () => void;
  onOpenSettings: () => void;
  onOpenSources: () => void;
  onOpenTracking: () => void;
};

type PosterLayout = {
  columns: number;
  rows: number;
  pageSize: number;
};

const DEFAULT_LAYOUT: PosterLayout = {
  columns: 5,
  rows: 2,
  pageSize: 10
};

const MOBILE_BREAKPOINT = 820;
const MOBILE_LAYOUT: PosterLayout = {
  columns: 2,
  rows: 5,
  pageSize: 10
};

export function HomePage({
  state,
  stats,
  toolsStatus,
  onOpen,
  onSearch,
  onNotify,
  onOpenDownloads,
  onOpenSettings,
  onOpenSources,
  onOpenTracking
}: HomePageProps) {
  const wallRef = useRef<HTMLDivElement | null>(null);
  const pagerRef = useRef<HTMLDivElement | null>(null);
  const lastPageSizeRef = useRef(DEFAULT_LAYOUT.pageSize);
  const [items, setItems] = useState<CatalogItem[]>([]);
  const [page, setPage] = useState(1);
  const [hasMore, setHasMore] = useState(false);
  const [loading, setLoading] = useState(true);
  const [refreshKey, setRefreshKey] = useState(0);
  const [layout, setLayout] = useState<PosterLayout>(DEFAULT_LAYOUT);
  const [searchKeyword, setSearchKeyword] = useState("");
  const activeDownloads = state.downloads.filter((task) => task.status === "queued" || task.status === "downloading");
  const latestDownload = activeDownloads[0] ?? state.downloads[0];
  const unreadWatchNotices = state.notifications.filter((notice) => notice.category === "watch" && !notice.read).length;
  const watchUpdates = state.watchlist.filter((item) => Boolean(item.updateFoundAt || item.updateMessage)).length;
  const healthResults = Object.values(state.sourceHealth);
  const onlineSites = stats?.onlineSites ?? healthResults.filter((result) => result.status === "online").length;
  const checkedSites = healthResults.length;
  const missingTools = missingToolLabels(toolsStatus);
  const latestWatchCheck = state.settings.watchlistLastAutoCheckAt ?? state.watchlist.map((item) => item.lastCheckedAt).filter(Boolean).sort().at(-1);
  const latestSourceCheck =
    state.settings.sourceHealthLastAutoCheckAt ?? healthResults.map((item) => item.checkedAt).filter(Boolean).sort().at(-1);

  useEffect(() => {
    function measurePosterWall() {
      const wall = wallRef.current;
      if (!wall) return;

      const viewportWidth = window.innerWidth;

      if (viewportWidth > MOBILE_BREAKPOINT) {
        setLayout((current) =>
          current.columns === DEFAULT_LAYOUT.columns && current.rows === DEFAULT_LAYOUT.rows && current.pageSize === DEFAULT_LAYOUT.pageSize
            ? current
            : DEFAULT_LAYOUT
        );
        return;
      }

      setLayout((current) =>
        current.columns === MOBILE_LAYOUT.columns && current.rows === MOBILE_LAYOUT.rows && current.pageSize === MOBILE_LAYOUT.pageSize
          ? current
          : MOBILE_LAYOUT
      );
    }

    const frame = window.requestAnimationFrame(measurePosterWall);
    const observer = new ResizeObserver(measurePosterWall);
    if (wallRef.current) observer.observe(wallRef.current);
    window.addEventListener("resize", measurePosterWall);

    return () => {
      window.cancelAnimationFrame(frame);
      observer.disconnect();
      window.removeEventListener("resize", measurePosterWall);
    };
  }, []);

  useEffect(() => {
    if (lastPageSizeRef.current === layout.pageSize) return;
    lastPageSizeRef.current = layout.pageSize;
    setPage(1);
  }, [layout.pageSize]);

  useEffect(() => {
    let ignore = false;

    async function load() {
      setLoading(true);
      try {
        const data = await getDoubanTrending(page, layout.pageSize);
        if (ignore) return;
        setItems(data.items);
        setPage(data.page);
        setHasMore(data.hasMore);
      } catch (error) {
        if (!ignore) onNotify(error instanceof Error ? error.message : "豆瓣海报墙加载失败", "bad");
      } finally {
        if (!ignore) setLoading(false);
      }
    }

    void load();

    return () => {
      ignore = true;
    };
  }, [layout.pageSize, page, refreshKey]);

  function submitSearch(event: FormEvent) {
    event.preventDefault();
    const keyword = searchKeyword.trim();
    if (!keyword) {
      onNotify("请输入搜索关键词", "warn");
      return;
    }
    onSearch(keyword);
  }

  const wallStyle: CSSProperties = {
    gridTemplateColumns: `repeat(${layout.columns}, minmax(0, 1fr))`
  };

  return (
    <section className="page-stack home-page">
      <div className="home-command-row">
        <form className="searchbar home-searchbar" onSubmit={submitSearch}>
          <Search size={18} />
          <input value={searchKeyword} onChange={(event) => setSearchKeyword(event.target.value)} placeholder="搜索资源站里的影片、剧集或动漫" />
          <button type="submit">
            <Search size={16} />
            搜索
          </button>
          <button
            className="home-refresh-button"
            type="button"
            onClick={() => setRefreshKey((current) => current + 1)}
            disabled={loading}
            aria-label="刷新首页海报"
            title="刷新首页海报"
          >
            {loading ? <Loader2 className="spin" size={16} /> : <RefreshCw size={16} />}
          </button>
        </form>
      </div>

      <section className="home-ops-strip" aria-label="运行概览">
        <HomeOpsCard
          icon={<DownloadCloud size={18} />}
          label="下载"
          value={activeDownloads.length ? `${activeDownloads.length} 个进行中` : `${state.downloads.length} 个任务`}
          detail={latestDownload ? `${latestDownload.title} · ${downloadStatusText(latestDownload.status)} ${Math.round(latestDownload.progress)}%` : "暂无下载任务"}
          tone={activeDownloads.length ? "busy" : state.downloads.some((task) => task.status === "failed") ? "warn" : "good"}
          onClick={onOpenDownloads}
        />
        <HomeOpsCard
          icon={<Bell size={18} />}
          label="追剧"
          value={unreadWatchNotices ? `${unreadWatchNotices} 条未读` : `${state.watchlist.length} 部追踪`}
          detail={watchUpdates ? `${watchUpdates} 部有更新 · ${formatTime(latestWatchCheck)}` : `最近检查 ${formatTime(latestWatchCheck)}`}
          tone={unreadWatchNotices || watchUpdates ? "busy" : "good"}
          onClick={onOpenTracking}
        />
        <HomeOpsCard
          icon={<ServerCog size={18} />}
          label="资源站"
          value={`${stats?.enabledSites ?? state.sites.filter((site) => site.enabled).length}/${stats?.sites ?? state.sites.length} 启用`}
          detail={checkedSites ? `${onlineSites}/${checkedSites} 在线 · ${formatTime(latestSourceCheck)}` : "尚未完成连通性检测"}
          tone={checkedSites && onlineSites === 0 ? "warn" : "good"}
          onClick={onOpenSources}
        />
        <HomeOpsCard
          icon={<Wrench size={18} />}
          label="工具"
          value={missingTools.length ? `${missingTools.length} 项缺失` : "全部就绪"}
          detail={missingTools.length ? `缺少 ${missingTools.join("、")}` : "ffmpeg、ffprobe、N_m3u8DL-RE 可用"}
          tone={missingTools.length ? "warn" : "good"}
          onClick={onOpenSettings}
        />
      </section>

      {items.length || loading ? (
        <div className="poster-wall" ref={wallRef} style={wallStyle}>
          {loading
            ? Array.from({ length: layout.pageSize }).map((_, index) => (
                <article aria-hidden="true" className="poster-card poster-skeleton" key={`poster-skeleton-${index}`}>
                  <span className="poster-frame" />
                  <span className="poster-copy">
                    <strong />
                    <small />
                  </span>
                </article>
              ))
            : items.map((item) => <PosterCard item={item} key={`${item.sourceId}-${item.vodId}`} onOpen={onOpen} />)}
          {!loading &&
            !items.length &&
            Array.from({ length: layout.pageSize }).map((_, index) => (
              <article aria-hidden="true" className="poster-card poster-skeleton" key={`poster-skeleton-${index}`}>
                <span className="poster-frame" />
                <span className="poster-copy">
                  <strong />
                  <small />
                </span>
              </article>
            ))}
        </div>
      ) : (
        <div className="empty-wall">暂时没有海报数据</div>
      )}

      <div className="pager" ref={pagerRef}>
        <button type="button" disabled={loading || page <= 1} onClick={() => setPage((current) => Math.max(1, current - 1))}>
          <ChevronLeft size={16} />
          上一页
        </button>
        <span>
          第 {page} 页 · {layout.columns} 列 × {layout.rows} 行 · 每页 {layout.pageSize} 条
        </span>
        <button type="button" disabled={loading || !hasMore} onClick={() => setPage((current) => current + 1)}>
          下一页
          <ChevronRight size={16} />
        </button>
      </div>
    </section>
  );
}

function HomeOpsCard({
  icon,
  label,
  value,
  detail,
  tone,
  onClick
}: {
  icon: ReactNode;
  label: string;
  value: string;
  detail: string;
  tone: "good" | "busy" | "warn";
  onClick: () => void;
}) {
  return (
    <button className={`home-ops-card ${tone}`} type="button" onClick={onClick}>
      <span className="home-ops-icon">{icon}</span>
      <span>
        <small>{label}</small>
        <strong>{value}</strong>
        <em>{detail}</em>
      </span>
    </button>
  );
}

function downloadStatusText(status: AppState["downloads"][number]["status"]) {
  return {
    queued: "排队",
    downloading: "下载",
    completed: "完成",
    failed: "失败",
    canceled: "取消"
  }[status];
}
