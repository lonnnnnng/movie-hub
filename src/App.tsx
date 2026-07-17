import {
  AlertTriangle,
  Bell,
  CheckCircle2,
  Clapperboard,
  DownloadCloud,
  ExternalLink,
  HardDrive,
  Home,
  Loader2,
  Menu,
  RefreshCw,
  Search,
  ServerCog,
  Settings2,
  Share2,
  X
} from "lucide-react";
import { Component, lazy, Suspense, useEffect, useMemo, useRef, useState, type ErrorInfo, type ReactNode } from "react";
import {
  api,
  buildLocalHls,
  checkAllSitesHealth,
  checkSiteHealth,
  checkWatchlist,
  clearDownloads,
  clearReadNotifications,
  deleteSite,
  getState,
  getStats,
  getToolsStatus,
  importSiteSubscription,
  markNotificationsRead,
  removeDownload,
  removeWatch,
  retryDownload,
  saveSettings,
  saveSite
} from "./lib/api";
import { detailPath } from "./lib/format";
import { useStoredState } from "./lib/storage";
import { toolWarningText } from "./lib/toolWarnings";
import type { AppSettings, AppState, CatalogItem, HubNotification, HubStats, LocalVideo, SourceSite, Toast, ToolsStatusResponse, WatchItem } from "./types";

type Route =
  | { name: "home" }
  | { name: "search"; keyword?: string }
  | { name: "sources" }
  | { name: "library" }
  | { name: "share" }
  | { name: "tracking" }
  | { name: "downloads" }
  | { name: "settings" }
  | { name: "detail"; sourceId: string; vodId: string };

type SitePayload = {
  id?: string;
  name: string;
  baseUrl: string;
  enabled: boolean;
  searchable: boolean;
  apiStyle: SourceSite["apiStyle"];
  notes?: string;
};

type SiteImportPayload = {
  url: string;
  enabled: boolean;
  searchable: boolean;
  apiStyle: SourceSite["apiStyle"];
};

type ToastItem = Toast & {
  id: string;
};

const notificationPageSizes = [8, 12, 20, 32] as const;
type NotificationFilter = "all" | "unread" | HubNotification["category"];
type NotificationPageSize = (typeof notificationPageSizes)[number];

const HomePage = lazy(() => import("./pages/HomePage").then((module) => ({ default: module.HomePage })));
const SearchPage = lazy(() => import("./pages/SearchPage").then((module) => ({ default: module.SearchPage })));
const DetailPage = lazy(() => import("./pages/DetailPage").then((module) => ({ default: module.DetailPage })));
const LibraryPage = lazy(() => import("./pages/LibraryPage").then((module) => ({ default: module.LibraryPage })));
const DownloadsPage = lazy(() => import("./pages/DownloadsPage").then((module) => ({ default: module.DownloadsPage })));
const SettingsPage = lazy(() => import("./pages/SettingsPage").then((module) => ({ default: module.SettingsPage })));
const SharePage = lazy(() => import("./pages/SharePage").then((module) => ({ default: module.SharePage })));
const SourcesPage = lazy(() => import("./pages/SourcesPage").then((module) => ({ default: module.SourcesPage })));
const TrackingPage = lazy(() => import("./pages/TrackingPage").then((module) => ({ default: module.TrackingPage })));

const emptyState: AppState = {
  sites: [],
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
};

function parseRoute(pathname = window.location.pathname, search = window.location.search): Route {
  const parts = pathname.split("/").filter(Boolean);
  if (!parts.length) return { name: "home" };
  if (parts[0] === "search") return { name: "search", keyword: new URLSearchParams(search).get("q") ?? "" };
  if (parts[0] === "sources") return { name: "sources" };
  if (parts[0] === "library") return { name: "library" };
  if (parts[0] === "share") return { name: "share" };
  if (parts[0] === "tracking") return { name: "tracking" };
  if (parts[0] === "downloads" || parts[0] === "ops") return { name: "downloads" };
  if (parts[0] === "settings") return { name: "settings" };
  if (parts[0] === "detail" && parts[1] && parts[2]) {
    return {
      name: "detail",
      sourceId: decodeURIComponent(parts[1]),
      vodId: decodeURIComponent(parts.slice(2).join("/"))
    };
  }
  return { name: "home" };
}

function routePath(route: Route) {
  if (route.name === "home") return "/";
  if (route.name === "search") return route.keyword?.trim() ? `/search?q=${encodeURIComponent(route.keyword.trim())}` : "/search";
  if (route.name === "detail") return `/detail/${encodeURIComponent(route.sourceId)}/${encodeURIComponent(route.vodId)}`;
  return `/${route.name}`;
}

export function App() {
  const [route, setRoute] = useState<Route>(() => parseRoute());
  const [state, setState] = useState<AppState>(emptyState);
  const [stateLoaded, setStateLoaded] = useState(false);
  const [stats, setStats] = useState<HubStats | null>(null);
  const [toolsStatus, setToolsStatus] = useState<ToolsStatusResponse | null>(null);
  const [toasts, setToasts] = useState<ToastItem[]>([]);
  const [checking, setChecking] = useState(false);
  const [localVideo, setLocalVideo] = useState<LocalVideo | null>(null);
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);
  const [notificationOpen, setNotificationOpen] = useState(false);
  const [notificationFilter, setNotificationFilter] = useStoredState<NotificationFilter>("movie-hub.notifications.filter", "all", {
    validate: isNotificationFilter
  });
  const [notificationPageSize, setNotificationPageSize] = useStoredState<NotificationPageSize>("movie-hub.notifications.pageSize", 12, {
    validate: isNotificationPageSize
  });
  const [notificationQuery, setNotificationQuery] = useState("");
  const [notificationPage, setNotificationPage] = useState(1);
  const [selectedNotificationId, setSelectedNotificationId] = useState<string | null>(null);
  const announcedToolWarningRef = useRef("");

  const unreadWatch = useMemo(() => state.notifications.filter((notice) => notice.category === "watch" && !notice.read).length, [state.notifications]);
  const unreadNotifications = useMemo(() => state.notifications.filter((notice) => !notice.read).length, [state.notifications]);
  const sortedNotifications = useMemo(() => [...state.notifications].sort((left, right) => right.createdAt.localeCompare(left.createdAt)), [state.notifications]);
  const filteredNotifications = useMemo(() => {
    const query = notificationQuery.trim().toLowerCase();
    return sortedNotifications.filter((notice) => {
      if (notificationFilter === "unread" && notice.read) return false;
      if (notificationFilter !== "all" && notificationFilter !== "unread" && notice.category !== notificationFilter) return false;
      if (!query) return true;
      return [notice.title, notice.message, notice.category].some((value) => value.toLowerCase().includes(query));
    });
  }, [notificationFilter, notificationQuery, sortedNotifications]);
  const notificationPageCount = Math.max(1, Math.ceil(filteredNotifications.length / notificationPageSize));
  const currentNotificationPage = Math.min(notificationPage, notificationPageCount);
  const notificationPageStart = (currentNotificationPage - 1) * notificationPageSize;
  const notificationPageEnd = Math.min(notificationPageStart + notificationPageSize, filteredNotifications.length);
  const pageNotifications = useMemo(
    () => filteredNotifications.slice(notificationPageStart, notificationPageEnd),
    [filteredNotifications, notificationPageEnd, notificationPageStart]
  );
  const filteredUnreadNotificationIds = useMemo(
    () => filteredNotifications.filter((notice) => !notice.read).map((notice) => notice.id),
    [filteredNotifications]
  );
  const filteredReadNotificationIds = useMemo(
    () => filteredNotifications.filter((notice) => notice.read).map((notice) => notice.id),
    [filteredNotifications]
  );
  const selectedNotification = useMemo(
    () => state.notifications.find((notice) => notice.id === selectedNotificationId) ?? null,
    [selectedNotificationId, state.notifications]
  );
  const currentNotificationScopeLabel = notificationFilter === "all" && !notificationQuery.trim() ? "全部通知" : "当前筛选";
  const notificationFilters = [
    { key: "all" as const, label: "全部", count: state.notifications.length },
    { key: "unread" as const, label: "未读", count: unreadNotifications },
    { key: "watch" as const, label: "追剧", count: state.notifications.filter((notice) => notice.category === "watch").length },
    { key: "download" as const, label: "下载", count: state.notifications.filter((notice) => notice.category === "download").length },
    { key: "source" as const, label: "资源站", count: state.notifications.filter((notice) => notice.category === "source").length },
    { key: "system" as const, label: "系统", count: state.notifications.filter((notice) => notice.category === "system").length }
  ];
  const hasActiveDownload = state.downloads.some((task) => task.status === "queued" || task.status === "downloading");
  const hasActiveLocalHls = state.hlsJobs.some((job) => job.status === "queued" || job.status === "running");
  const activeDownloadCount = state.downloads.filter((task) => task.status === "queued" || task.status === "downloading").length;
  const readyToolCount = toolsStatus ? [toolsStatus.ffmpeg, toolsStatus.ffprobe, toolsStatus.nM3u8DlRe].filter((tool) => tool.ok).length : 0;
  const toolWarning = toolWarningText(toolsStatus);

  function notify(message: string, tone: Toast["tone"] = "good") {
    const id = `toast-${Date.now()}-${Math.random().toString(16).slice(2)}`;
    setToasts((current) => [...current.slice(-3), { id, message, tone }]);
    window.setTimeout(() => {
      setToasts((current) => current.filter((toast) => toast.id !== id));
    }, 4200);
  }

  function navigate(nextRoute: Route) {
    const path = routePath(nextRoute);
    window.history.pushState(null, "", path);
    setRoute(nextRoute);
    setMobileMenuOpen(false);
    setNotificationOpen(false);
  }

  function openCatalog(item: CatalogItem) {
    window.history.pushState(null, "", detailPath(item));
    setRoute({ name: "detail", sourceId: item.sourceId, vodId: item.vodId });
    setMobileMenuOpen(false);
    setNotificationOpen(false);
  }

  function openResourceSearch(keyword: string) {
    navigate({ name: "search", keyword });
  }

  async function refreshState() {
    try {
      const [nextState, nextStats] = await Promise.all([getState(), getStats()]);
      setState(nextState);
      setStats(nextStats);
    } finally {
      setStateLoaded(true);
    }
  }

  async function refreshToolsStatus() {
    setToolsStatus(await getToolsStatus());
  }

  async function handleCheckWatchlist() {
    setChecking(true);
    try {
      await checkWatchlist();
      await refreshState();
      notify("追剧更新检查完成");
    } catch (error) {
      notify(error instanceof Error ? error.message : "检查失败", "bad");
    } finally {
      setChecking(false);
    }
  }

  async function handleSaveSite(payload: SitePayload) {
    await saveSite(
      {
        name: payload.name,
        baseUrl: payload.baseUrl,
        enabled: payload.enabled,
        searchable: payload.searchable,
        apiStyle: payload.apiStyle,
        notes: payload.notes?.trim() || undefined
      },
      payload.id
    );
    await refreshState();
    notify(payload.id ? "资源站已更新" : "资源站已添加");
  }

  async function handleImportSiteSubscription(payload: SiteImportPayload) {
    const result = await importSiteSubscription(payload);
    await refreshState();
    // long：重复站点已经按接口地址去重，完成提示必须明确说明这些站点没有再次写入。
    const skippedText = result.totals.skipped ? `，${result.totals.skipped} 个重复站点已跳过` : "";
    const failedText = result.totals.failed ? `，${result.totals.failed} 个导入失败` : "";
    notify(
      `订阅导入完成：新增 ${result.totals.imported} 个${skippedText}${failedText}`,
      result.totals.skipped || result.totals.failed ? "warn" : "good"
    );
    return result;
  }

  async function handleToggleSite(site: SourceSite) {
    await api.send(`/api/sites/${site.id}`, "PUT", { enabled: !site.enabled });
    await refreshState();
  }

  async function handleDeleteSite(site: SourceSite) {
    if (site.builtIn) {
      notify("内置资源站不能删除，可以停用", "warn");
      return;
    }
    await deleteSite(site.id);
    await refreshState();
    notify(`已删除 ${site.name}`, "warn");
  }

  async function handleCheckSiteHealth(site: SourceSite) {
    const data = await checkSiteHealth(site.id);
    await refreshState();
    notify(`${site.name}：${data.result.message ?? (data.result.ok ? "连通正常" : "检测失败")}`, data.result.ok ? "good" : "warn");
  }

  async function handleCheckAllSitesHealth() {
    const data = await checkAllSitesHealth();
    await refreshState();
    const online = data.results.filter((result) => result.status === "online").length;
    notify(`资源站检测完成：${online}/${data.results.length} 在线`, online ? "good" : "warn");
  }

  async function handleSaveSettings(settings: Partial<AppSettings>) {
    await saveSettings(settings);
    await refreshState();
    await refreshToolsStatus().catch(() => undefined);
    notify("设置已保存");
  }

  async function handleBuildHls(video: LocalVideo) {
    try {
      await buildLocalHls(video);
      await refreshState();
      notify("本地视频 HLS 已生成");
    } catch (error) {
      notify(error instanceof Error ? error.message : "HLS 生成失败", "bad");
    }
  }

  async function handleRemoveWatch(id: string) {
    await removeWatch(id);
    await refreshState();
    notify("已移出追剧列表", "warn");
  }

  async function handleRemoveDownload(id: string) {
    const result = await removeDownload(id);
    await refreshState();
    notify(result.canceled ? "下载任务已取消" : "下载任务已移除", result.canceled ? "warn" : "good");
  }

  async function handleRetryDownload(id: string) {
    await retryDownload(id);
    await refreshState();
    notify("下载任务已重新加入队列");
  }

  async function handleClearDownloads(status: "completed" | "failed" | "canceled") {
    const result = await clearDownloads(status);
    await refreshState();
    const label = status === "completed" ? "已完成" : status === "failed" ? "失败" : "已取消";
    notify(`已清理 ${result.removed} 个${label}任务`, result.removed ? "good" : "warn");
  }

  async function markFilteredNotificationsRead() {
    if (!filteredUnreadNotificationIds.length) return;
    await markNotificationsRead(filteredUnreadNotificationIds);
    await refreshState();
    notify(`${currentNotificationScopeLabel}已标记为已读`);
  }

  async function markAllNotificationsRead() {
    await markNotificationsRead();
    await refreshState();
    notify("全部通知已标记为已读");
  }

  async function clearAllReadNotifications() {
    await clearReadNotifications();
    setSelectedNotificationId((current) => {
      const selected = current ? state.notifications.find((notice) => notice.id === current) : null;
      return selected?.read ? null : current;
    });
    await refreshState();
    notify("已清理全部已读通知");
  }

  async function clearFilteredReadNotifications() {
    if (!filteredReadNotificationIds.length) return;
    await clearReadNotifications(filteredReadNotificationIds);
    setSelectedNotificationId((current) => (current && filteredReadNotificationIds.includes(current) ? null : current));
    await refreshState();
    notify(`已清理${currentNotificationScopeLabel}中的已读通知`);
  }

  async function markNotificationRead(id: string) {
    await markNotificationsRead([id]);
    await refreshState();
  }

  function openNotificationTarget(notice: HubNotification) {
    navigate(notificationTargetRoute(notice));
  }

  useEffect(() => {
    void Promise.all([refreshState(), refreshToolsStatus()]).catch((error) => notify(error instanceof Error ? error.message : "状态加载失败", "bad"));
    const onPop = () => {
      setRoute(parseRoute());
      setMobileMenuOpen(false);
    };
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, []);

  useEffect(() => {
    if (!toolWarning || announcedToolWarningRef.current === toolWarning) return;
    announcedToolWarningRef.current = toolWarning;
    notify(toolWarning, "warn");
  }, [toolWarning]);

  useEffect(() => {
    setNotificationPage(1);
  }, [notificationFilter, notificationPageSize, notificationQuery]);

  useEffect(() => {
    if (notificationPage > notificationPageCount) setNotificationPage(notificationPageCount);
  }, [notificationPage, notificationPageCount]);

  useEffect(() => {
    if (selectedNotificationId && !state.notifications.some((notice) => notice.id === selectedNotificationId)) {
      setSelectedNotificationId(null);
    }
  }, [selectedNotificationId, state.notifications]);

  useEffect(() => {
    const timer = window.setInterval(() => {
      void refreshState().catch(() => undefined);
    }, hasActiveDownload || hasActiveLocalHls ? 1500 : 6000);
    return () => window.clearInterval(timer);
  }, [hasActiveDownload, hasActiveLocalHls]);

  return (
    <main className="app-shell">
      <div className="cinema-grain" />
      {toasts.length ? (
        <div className="toast-stack" aria-live="polite" aria-label="系统提示">
          {toasts.map((toast) => (
            <div className={`toast ${toast.tone}`} key={toast.id}>
              {toast.message}
            </div>
          ))}
        </div>
      ) : null}

      <aside className="app-sidebar">
        <button className="brand" type="button" onClick={() => navigate({ name: "home" })}>
          <span className="brand-mark">
            <Clapperboard size={22} />
          </span>
          <span>
            <strong>Movie Hub</strong>
            <small>家庭影院中枢</small>
          </span>
        </button>

        <div className="mobile-breadcrumb" aria-label="当前位置">
          <button className="mobile-home-crumb" type="button" onClick={() => navigate({ name: "home" })}>
            <Clapperboard size={16} />
            <strong>Movie Hub</strong>
          </button>
          <button
            className="mobile-menu-toggle"
            type="button"
            aria-label={`${mobileMenuOpen ? "关闭" : "打开"}主导航，当前位置：${pageTitle(route)}`}
            aria-expanded={mobileMenuOpen}
            aria-controls="main-menu"
            onClick={() => setMobileMenuOpen((open) => !open)}
          >
            {mobileMenuOpen ? <X size={18} /> : <Menu size={18} />}
          </button>
        </div>

        <nav className={`main-menu ${mobileMenuOpen ? "open" : ""}`} id="main-menu">
          <span className="menu-label">工作台</span>
          <MenuButton active={route.name === "home"} icon={<Home size={18} />} label="首页" onClick={() => navigate({ name: "home" })} />
          <MenuButton active={route.name === "sources"} icon={<ServerCog size={18} />} label="资源站管理" onClick={() => navigate({ name: "sources" })} />
          <MenuButton active={route.name === "library"} icon={<HardDrive size={18} />} label="本地片库" onClick={() => navigate({ name: "library" })} />
          <MenuButton active={route.name === "share"} icon={<Share2 size={18} />} label="共享中心" onClick={() => navigate({ name: "share" })} />
          <MenuButton active={route.name === "tracking"} icon={<Bell size={18} />} label={`剧集追踪${unreadWatch ? ` · ${unreadWatch}` : ""}`} onClick={() => navigate({ name: "tracking" })} />
          <MenuButton active={route.name === "downloads"} icon={<DownloadCloud size={18} />} label={`下载管理${activeDownloadCount ? ` · ${activeDownloadCount}` : ""}`} onClick={() => navigate({ name: "downloads" })} />
          <MenuButton active={route.name === "settings"} icon={<Settings2 size={18} />} label="系统设置" onClick={() => navigate({ name: "settings" })} />
        </nav>

        <div className="sidebar-runtime" role="status">
          <span className={`runtime-dot ${readyToolCount === 3 ? "online" : "warning"}`} />
          <span>
            <strong>{readyToolCount === 3 ? "服务运行正常" : "工具需要检查"}</strong>
            <small>{state.sites.filter((site) => site.enabled).length} 个资源站 · {readyToolCount}/3 工具就绪</small>
          </span>
        </div>
      </aside>

      <section className="app-main">
        <header className="topbar">
          <div className="topbar-title">
            <p className="eyebrow">{pageSection(route)}</p>
            <h2>{pageTitle(route)}</h2>
          </div>
          <div className="topbar-actions">
            <div className="topbar-runtime">
              <span className="runtime-dot online" />
              <span>
                <strong>{activeDownloadCount ? `${activeDownloadCount} 个任务进行中` : "系统空闲"}</strong>
                <small>{state.sites.length} 个资源站已接入</small>
              </span>
            </div>
            <button
              className={`notification-trigger ${notificationOpen ? "active" : ""}`}
              type="button"
              onClick={() => setNotificationOpen((open) => !open)}
              aria-expanded={notificationOpen}
              aria-controls="notification-center"
              title="通知中心"
            >
              <Bell size={18} />
              <span>通知</span>
              {unreadNotifications ? <b>{unreadNotifications}</b> : null}
            </button>
          </div>
        </header>

        {notificationOpen ? (
          <section className="notification-center" id="notification-center">
            <div className="notification-center-head">
              <div>
                <p className="eyebrow">Notifications</p>
                <h3>通知中心</h3>
              </div>
              <div className="notification-center-actions">
                <button type="button" onClick={() => void markAllNotificationsRead()} disabled={!unreadNotifications}>
                  全部已读
                </button>
                <button type="button" onClick={() => void clearAllReadNotifications()} disabled={!state.notifications.some((notice) => notice.read)}>
                  清理已读
                </button>
                <button type="button" onClick={() => void markFilteredNotificationsRead()} disabled={!filteredUnreadNotificationIds.length}>
                  当前已读
                </button>
                <button type="button" onClick={() => void clearFilteredReadNotifications()} disabled={!filteredReadNotificationIds.length}>
                  清理当前
                </button>
              </div>
            </div>
            <label className="notification-search">
              <Search size={15} />
              <input value={notificationQuery} onChange={(event) => setNotificationQuery(event.target.value)} placeholder="搜索通知标题或内容" />
            </label>
            <div className="notification-filter-tabs">
              {notificationFilters.map((filter) => (
                <button
                  className={notificationFilter === filter.key ? "active" : ""}
                  key={filter.key}
                  type="button"
                  onClick={() => setNotificationFilter(filter.key)}
                >
                  <span>{filter.label}</span>
                  <b>{filter.count}</b>
                </button>
              ))}
            </div>
            <div className="notification-options">
              <span>
                {filteredNotifications.length ? `${notificationPageStart + 1}-${notificationPageEnd} / ${filteredNotifications.length}` : "0 条"}
              </span>
              <label>
                每页
                <select value={notificationPageSize} onChange={(event) => setNotificationPageSize(Number(event.target.value) as NotificationPageSize)}>
                  {notificationPageSizes.map((size) => (
                    <option value={size} key={size}>
                      {size}
                    </option>
                  ))}
                </select>
              </label>
            </div>
            <div className="notification-list">
              {filteredNotifications.length ? (
                pageNotifications.map((notice) => (
                  <article
                    className={`notification-item ${notice.tone} ${notice.read ? "read" : ""} ${selectedNotificationId === notice.id ? "selected" : ""}`}
                    key={notice.id}
                  >
                    <button
                      className="notification-item-main"
                      type="button"
                      onClick={() => setSelectedNotificationId((current) => (current === notice.id ? null : notice.id))}
                    >
                      <span className={`notification-dot ${notice.tone}`} />
                      <span>
                        <strong>{notice.title}</strong>
                        <em>{notice.message}</em>
                        <small>
                          {notificationCategoryText(notice.category)} · {formatNoticeTime(notice.createdAt)}
                        </small>
                      </span>
                    </button>
                    <div className="notification-item-actions">
                      <button type="button" onClick={() => void markNotificationRead(notice.id)} disabled={notice.read} title="标记为已读">
                        <CheckCircle2 size={14} />
                        已读
                      </button>
                      <button type="button" onClick={() => openNotificationTarget(notice)} title={notificationTargetLabel(notice)}>
                        <ExternalLink size={14} />
                        前往
                      </button>
                    </div>
                  </article>
                ))
              ) : (
                <div className="empty-small">
                  <Bell size={24} />
                  <span>没有匹配的通知</span>
                </div>
              )}
            </div>
            {selectedNotification ? (
              <NotificationDetailCard
                notice={selectedNotification}
                onClose={() => setSelectedNotificationId(null)}
                onMarkRead={() => void markNotificationRead(selectedNotification.id)}
                onOpenTarget={() => openNotificationTarget(selectedNotification)}
              />
            ) : null}
            {filteredNotifications.length > notificationPageSize ? (
              <div className="notification-pagination" aria-label="通知分页">
                <span>
                  第 {currentNotificationPage} / {notificationPageCount} 页 · {notificationPageStart + 1}-{notificationPageEnd} / {filteredNotifications.length}
                </span>
                <div>
                  <button
                    type="button"
                    disabled={currentNotificationPage <= 1}
                    onClick={() => setNotificationPage((value) => Math.max(1, value - 1))}
                  >
                    上一页
                  </button>
                  <button
                    type="button"
                    disabled={currentNotificationPage >= notificationPageCount}
                    onClick={() => setNotificationPage((value) => Math.min(notificationPageCount, value + 1))}
                  >
                    下一页
                  </button>
                </div>
              </div>
            ) : null}
          </section>
        ) : null}

        {toolWarning ? (
          <div className="tool-warning-banner" role="status">
            <AlertTriangle size={19} />
            <div>
              <strong>工具未就绪</strong>
              <span>{toolWarning}</span>
            </div>
            {route.name !== "settings" ? (
              <button type="button" onClick={() => navigate({ name: "settings" })}>
                去配置
              </button>
            ) : null}
          </div>
        ) : null}

        <PageErrorBoundary routeKey={routePath(route)} label={pageTitle(route)} onHome={() => navigate({ name: "home" })}>
          <Suspense fallback={<PageLoading label={pageTitle(route)} />}>
            {route.name === "home" && (
              <HomePage
                state={state}
                stats={stats}
                toolsStatus={toolsStatus}
                onOpen={openCatalog}
                onNotify={notify}
                onSearch={openResourceSearch}
                onOpenDownloads={() => navigate({ name: "downloads" })}
                onOpenSettings={() => navigate({ name: "settings" })}
                onOpenSources={() => navigate({ name: "sources" })}
                onOpenTracking={() => navigate({ name: "tracking" })}
              />
            )}
            {route.name === "search" && <SearchPage sites={state.sites} initialKeyword={route.keyword ?? ""} onOpen={openCatalog} onNotify={notify} />}
            {route.name === "sources" && (
              <SourcesPage
                state={state}
                onSaveSite={handleSaveSite}
                onToggleSite={handleToggleSite}
                onDeleteSite={handleDeleteSite}
                onCheckSite={(site) => handleCheckSiteHealth(site)}
                onCheckAll={() => handleCheckAllSitesHealth()}
                onImportSubscription={handleImportSiteSubscription}
                onNotify={notify}
              />
            )}
            {route.name === "detail" && <DetailPage sourceId={route.sourceId} vodId={route.vodId} toolsStatus={toolsStatus} onNotify={notify} />}
            {route.name === "library" && (
              <LibraryPage
                videos={state.library}
                current={localVideo}
                hlsJobs={state.hlsJobs}
                onPlay={(video) => setLocalVideo(video)}
                onHls={(video) => void handleBuildHls(video)}
                onRefresh={refreshState}
                onNotify={notify}
                loading={!stateLoaded}
              />
            )}
            {route.name === "share" && (
              <SharePage
                settings={state.settings}
                onBuildHls={handleBuildHls}
                onNotify={notify}
                onSaveSettings={handleSaveSettings}
              />
            )}
            {route.name === "tracking" && (
              <TrackingPage
                state={state}
                checking={checking}
                onCheck={() => void handleCheckWatchlist()}
                onOpenWatch={(item: WatchItem) => openCatalog(item.item)}
                onRemoveWatch={(id) => void handleRemoveWatch(id)}
                onMarkAll={() => void markNotificationsRead().then(refreshState)}
                onMarkOne={(id) => void markNotificationsRead([id]).then(refreshState)}
                onClearRead={() => void clearReadNotifications().then(refreshState)}
              />
            )}
            {route.name === "downloads" && (
              <DownloadsPage
                state={state}
                onRemoveDownload={(id) => void handleRemoveDownload(id)}
                onRetryDownload={handleRetryDownload}
                onClearDownloads={handleClearDownloads}
                onRefresh={() => void refreshState()}
                onNotify={notify}
                loading={!stateLoaded}
              />
            )}
            {route.name === "settings" && (
              <SettingsPage
                state={state}
                stats={stats}
                initialToolStatus={toolsStatus}
                onSaveSettings={handleSaveSettings}
                onToolStatusChange={setToolsStatus}
                onStateRestored={(nextState) => {
                  setState(nextState);
                  void getStats().then(setStats).catch(() => undefined);
                }}
                onNotify={notify}
              />
            )}
          </Suspense>
        </PageErrorBoundary>
      </section>
    </main>
  );
}

type PageErrorBoundaryProps = {
  children: ReactNode;
  label: string;
  routeKey: string;
  onHome: () => void;
};

type PageErrorBoundaryState = {
  error: Error | null;
};

class PageErrorBoundary extends Component<PageErrorBoundaryProps, PageErrorBoundaryState> {
  state: PageErrorBoundaryState = { error: null };

  static getDerivedStateFromError(error: Error) {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error("Page failed to render", error, info.componentStack);
  }

  componentDidUpdate(previousProps: PageErrorBoundaryProps) {
    if (previousProps.routeKey !== this.props.routeKey && this.state.error) {
      this.setState({ error: null });
    }
  }

  retry = () => {
    this.setState({ error: null });
  };

  render() {
    if (this.state.error) {
      return <PageLoadError label={this.props.label} error={this.state.error} onRetry={this.retry} onHome={this.props.onHome} />;
    }

    return this.props.children;
  }
}

function PageLoading({ label }: { label: string }) {
  return (
    <div className="page-loading" role="status" aria-live="polite">
      <Loader2 className="spin" size={22} />
      <span>正在加载{label}</span>
    </div>
  );
}

function PageLoadError({ label, error, onRetry, onHome }: { label: string; error: Error; onRetry: () => void; onHome: () => void }) {
  return (
    <div className="page-load-error" role="alert">
      <AlertTriangle size={24} />
      <strong>{label}加载失败</strong>
      <span>{error.message || "页面资源加载异常，可以重试或返回首页。"}</span>
      <div>
        <button type="button" onClick={onRetry}>
          <RefreshCw size={15} />
          重试
        </button>
        <button type="button" onClick={onHome}>
          回首页
        </button>
      </div>
    </div>
  );
}

function MenuButton({ active, icon, label, onClick }: { active: boolean; icon: React.ReactNode; label: string; onClick: () => void }) {
  return (
    <button className={active ? "active" : ""} type="button" onClick={onClick}>
      {icon}
      <span>{label}</span>
    </button>
  );
}

function pageTitle(route: Route) {
  return {
    home: "首页",
    search: "资源站搜索",
    sources: "资源站管理",
    library: "本地片库",
    share: "共享中心",
    tracking: "剧集追踪",
    downloads: "下载管理",
    settings: "系统设置",
    detail: "剧集详情"
  }[route.name];
}

function pageSection(route: Route) {
  return {
    home: "Overview",
    search: "Discovery",
    sources: "Connectivity",
    library: "Library",
    share: "Distribution",
    tracking: "Tracking",
    downloads: "Transfers",
    settings: "System",
    detail: "Playback"
  }[route.name];
}

function NotificationDetailCard({
  notice,
  onClose,
  onMarkRead,
  onOpenTarget
}: {
  notice: HubNotification;
  onClose: () => void;
  onMarkRead: () => void;
  onOpenTarget: () => void;
}) {
  return (
    <aside className={`notification-detail-card ${notice.tone}`}>
      <div className="notification-detail-head">
        <span>{notificationCategoryText(notice.category)}</span>
        <button type="button" onClick={onClose} aria-label="关闭通知详情">
          <X size={15} />
        </button>
      </div>
      <strong>{notice.title}</strong>
      <p>{notice.message}</p>
      <dl>
        <div>
          <dt>状态</dt>
          <dd>{notice.read ? "已读" : "未读"}</dd>
        </div>
        <div>
          <dt>时间</dt>
          <dd>{formatNoticeTime(notice.createdAt, true)}</dd>
        </div>
        {notice.sourceId ? (
          <div>
            <dt>资源站</dt>
            <dd>{notice.sourceId}</dd>
          </div>
        ) : null}
        {notice.taskId ? (
          <div>
            <dt>任务</dt>
            <dd>{notice.taskId}</dd>
          </div>
        ) : null}
        {notice.itemId ? (
          <div>
            <dt>条目</dt>
            <dd>{notice.itemId}</dd>
          </div>
        ) : null}
      </dl>
      <div className="notification-detail-actions">
        <button type="button" onClick={onOpenTarget}>
          <ExternalLink size={14} />
          {notificationTargetLabel(notice)}
        </button>
        <button type="button" onClick={onMarkRead} disabled={notice.read}>
          <CheckCircle2 size={14} />
          标记已读
        </button>
      </div>
    </aside>
  );
}

function isNotificationFilter(value: unknown): value is NotificationFilter {
  return value === "all" || value === "unread" || value === "watch" || value === "download" || value === "source" || value === "system";
}

function isNotificationPageSize(value: unknown): value is NotificationPageSize {
  return typeof value === "number" && notificationPageSizes.includes(value as NotificationPageSize);
}

function formatNoticeTime(value: string, full = false) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString("zh-CN", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    ...(full ? { year: "numeric", second: "2-digit" } : {})
  });
}

function notificationTargetRoute(notice: HubNotification): Route {
  if (notice.category === "watch") return { name: "tracking" };
  if (notice.category === "download") return { name: "downloads" };
  if (notice.category === "source") return { name: "sources" };
  if (notice.category === "system") return { name: "settings" };
  return { name: "home" };
}

function notificationTargetLabel(notice: HubNotification) {
  return {
    watch: "去追踪",
    download: "去下载",
    source: "去资源站",
    system: "去设置"
  }[notice.category];
}

function notificationCategoryText(category: HubNotification["category"]) {
  return {
    watch: "追剧",
    download: "下载",
    source: "资源站",
    system: "系统"
  }[category];
}
