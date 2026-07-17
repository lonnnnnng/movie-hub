import { ArrowDownAZ, Bell, Check, ChevronLeft, ChevronRight, Clock3, DownloadCloud, Eye, Info, RefreshCw, Search, Trash2, X } from "lucide-react";
import { useEffect, useMemo, useState, type FormEvent, type ReactNode } from "react";
import type { AppState, HubNotification, WatchItem } from "../types";
import { formatTime, imageUrlFor } from "../lib/format";
import { useStoredState } from "../lib/storage";

type TrackingPageProps = {
  state: AppState;
  checking: boolean;
  onCheck: () => void;
  onOpenWatch: (item: WatchItem) => void;
  onRemoveWatch: (id: string) => void;
  onMarkAll: () => void;
  onMarkOne: (id: string) => void;
  onClearRead: () => void;
};

type WatchFilter = "all" | "updated" | "auto" | "manual";
type NoticeFilter = "all" | "unread" | "read";
type WatchSort = "activity-desc" | "checked-desc" | "created-desc" | "title-asc" | "source-asc";

const pageSizeOptions = [10, 20, 50, 100];
const watchFiltersValues = ["all", "updated", "auto", "manual"] satisfies WatchFilter[];
const noticeFilterValues = ["all", "unread", "read"] satisfies NoticeFilter[];
const watchSortValues = ["activity-desc", "checked-desc", "created-desc", "title-asc", "source-asc"] satisfies WatchSort[];

export function TrackingPage({
  state,
  checking,
  onCheck,
  onOpenWatch,
  onRemoveWatch,
  onMarkAll,
  onMarkOne,
  onClearRead
}: TrackingPageProps) {
  const [watchQuery, setWatchQuery] = useState("");
  const [selectedWatch, setSelectedWatch] = useState<WatchItem | null>(null);
  const [watchFilter, setWatchFilter] = useStoredState<WatchFilter>("movie-hub.tracking.watchFilter", "all", { validate: isWatchFilter });
  const [watchSort, setWatchSort] = useStoredState<WatchSort>("movie-hub.tracking.watchSort", "activity-desc", { validate: isWatchSort });
  const [watchPage, setWatchPage] = useState(1);
  const [watchPageSize, setWatchPageSize] = useStoredState<number>("movie-hub.tracking.watchPageSize", 10, { validate: isPageSize });
  const [noticeFilter, setNoticeFilter] = useStoredState<NoticeFilter>("movie-hub.tracking.noticeFilter", "all", { validate: isNoticeFilter });
  const [noticePage, setNoticePage] = useState(1);
  const [noticePageSize, setNoticePageSize] = useStoredState<number>("movie-hub.tracking.noticePageSize", 10, { validate: isPageSize });
  const watchNotices = useMemo(
    () => state.notifications.filter((notice) => notice.category === "watch").sort((left, right) => right.createdAt.localeCompare(left.createdAt)),
    [state.notifications]
  );
  const unreadWatchNotices = watchNotices.filter((notice) => !notice.read).length;
  const autoDownloadCount = state.watchlist.filter((item) => item.autoDownload).length;
  const updatedCount = state.watchlist.filter((item) => item.updateFoundAt).length;
  const normalizedWatchQuery = watchQuery.trim().toLowerCase();
  const filteredWatchlist = useMemo(() => {
    return state.watchlist
      .filter((entry) => {
        if (watchFilter === "updated" && !entry.updateFoundAt) return false;
        if (watchFilter === "auto" && !entry.autoDownload) return false;
        if (watchFilter === "manual" && entry.autoDownload) return false;
        if (!normalizedWatchQuery) return true;
        return [
          entry.item.title,
          entry.item.originalTitle,
          entry.item.sourceName,
          entry.latestEpisodeName,
          entry.updateMessage,
          entry.item.remarks,
          entry.item.typeName
        ].some((value) => value?.toLowerCase().includes(normalizedWatchQuery));
      })
      .sort((left, right) => sortWatchItems(left, right, watchSort));
  }, [normalizedWatchQuery, state.watchlist, watchFilter, watchSort]);
  const filteredNotices = useMemo(() => {
    return watchNotices.filter((notice) => {
      if (noticeFilter === "unread") return !notice.read;
      if (noticeFilter === "read") return notice.read;
      return true;
    });
  }, [noticeFilter, watchNotices]);
  const watchPageCount = Math.max(1, Math.ceil(filteredWatchlist.length / watchPageSize));
  const currentWatchPage = Math.min(watchPage, watchPageCount);
  const watchPageStart = (currentWatchPage - 1) * watchPageSize;
  const watchPageEnd = Math.min(watchPageStart + watchPageSize, filteredWatchlist.length);
  const pageWatchlist = useMemo(() => filteredWatchlist.slice(watchPageStart, watchPageEnd), [filteredWatchlist, watchPageEnd, watchPageStart]);
  const noticePageCount = Math.max(1, Math.ceil(filteredNotices.length / noticePageSize));
  const currentNoticePage = Math.min(noticePage, noticePageCount);
  const noticePageStart = (currentNoticePage - 1) * noticePageSize;
  const noticePageEnd = Math.min(noticePageStart + noticePageSize, filteredNotices.length);
  const pageNotices = useMemo(() => filteredNotices.slice(noticePageStart, noticePageEnd), [filteredNotices, noticePageEnd, noticePageStart]);
  const watchFilters = [
    { value: "all" as const, label: "全部", count: state.watchlist.length },
    { value: "updated" as const, label: "有更新", count: updatedCount },
    { value: "auto" as const, label: "自动下载", count: autoDownloadCount },
    { value: "manual" as const, label: "仅提醒", count: state.watchlist.length - autoDownloadCount }
  ];
  const noticeFilters = [
    { value: "all" as const, label: "全部", count: watchNotices.length },
    { value: "unread" as const, label: "未读", count: unreadWatchNotices },
    { value: "read" as const, label: "已读", count: watchNotices.length - unreadWatchNotices }
  ];

  useEffect(() => {
    setWatchPage(1);
  }, [normalizedWatchQuery, watchFilter, watchPageSize, watchSort]);

  useEffect(() => {
    if (watchPage > watchPageCount) setWatchPage(watchPageCount);
  }, [watchPage, watchPageCount]);

  useEffect(() => {
    setNoticePage(1);
  }, [noticeFilter, noticePageSize]);

  useEffect(() => {
    if (noticePage > noticePageCount) setNoticePage(noticePageCount);
  }, [noticePage, noticePageCount]);

  function submitWatchSearch(event: FormEvent) {
    event.preventDefault();
    setWatchPage(1);
  }

  return (
    <section className="page-stack tracking-page">
      <div className="ops-summary management-summary">
        <TrackingStat label="订阅剧集" value={state.watchlist.length} icon={<Bell size={20} />} />
        <TrackingStat label="自动下载" value={autoDownloadCount} icon={<DownloadCloud size={20} />} tone="good" />
        <TrackingStat label="发现更新" value={updatedCount} icon={<RefreshCw size={20} />} tone={updatedCount ? "warn" : undefined} />
        <TrackingStat label="未读动态" value={unreadWatchNotices} icon={<Eye size={20} />} tone={unreadWatchNotices ? "warn" : undefined} />
      </div>

      <section className="panel management-list-panel">
        <div className="panel-title">
          <div>
            <p className="eyebrow">Subscriptions</p>
            <h3>剧集追踪列表</h3>
          </div>
          <div className="panel-title-actions">
            <span className="notice-count">{state.watchlist.length}</span>
            <button className="tool-button" type="button" onClick={onCheck} disabled={checking}>
              <RefreshCw className={checking ? "spin" : ""} size={16} />
              检查更新
            </button>
          </div>
        </div>

        <form className="tracking-toolbar" onSubmit={submitWatchSearch}>
          <label className="tracking-search">
            <Search size={17} />
            <input value={watchQuery} onChange={(event) => setWatchQuery(event.target.value)} placeholder="搜索剧名、资源站、最新集或状态" />
            {watchQuery ? (
              <button type="button" onClick={() => setWatchQuery("")} title="清空搜索">
                <X size={15} />
              </button>
            ) : null}
          </label>
          <button className="tool-button toolbar-search-button" type="submit">
            <Search size={16} />
            搜索
          </button>
          <label className="tracking-sort">
            <ArrowDownAZ size={16} />
            <select value={watchSort} onChange={(event) => setWatchSort(event.target.value as WatchSort)}>
              <option value="activity-desc">最近动态</option>
              <option value="checked-desc">最近检查</option>
              <option value="created-desc">最近订阅</option>
              <option value="title-asc">剧名 A-Z</option>
              <option value="source-asc">资源站 A-Z</option>
            </select>
          </label>
        </form>

        <div className="tracking-filter-tabs" aria-label="剧集追踪筛选">
          {watchFilters.map((filter) => (
            <button
              className={watchFilter === filter.value ? "active" : ""}
              key={filter.value}
              type="button"
              onClick={() => setWatchFilter(filter.value)}
            >
              {filterIcon(filter.value)}
              <span>{filter.label}</span>
              <b>{filter.count}</b>
            </button>
          ))}
        </div>

        {filteredWatchlist.length ? (
          <div className="tracking-list" aria-label="剧集追踪列表">
            <div className="tracking-list-head">
              <span>剧集</span>
              <span>最新状态</span>
              <span>自动下载</span>
              <span>上次检查</span>
              <span>操作</span>
            </div>
            {pageWatchlist.map((entry) => (
              <article key={entry.id} className="tracking-row">
                <div className="tracking-title-cell">
                  <div className="tracking-poster">
                    {entry.item.poster ? <img src={imageUrlFor(entry.item.poster)} alt={entry.item.title} /> : <Bell size={20} />}
                  </div>
                  <div>
                    <strong>{entry.item.title}</strong>
                    <span>{entry.item.sourceName}</span>
                  </div>
                </div>
                <div className="tracking-state-cell">
                  <strong>{entry.latestEpisodeName ?? "未知"}</strong>
                  <span>{entry.updateMessage ?? "等待下一次检查"}</span>
                </div>
                <span className={`status-pill ${entry.autoDownload ? "downloading" : "queued"}`}>
                  {entry.autoDownload ? "开启" : "关闭"}
                </span>
                <span className="tracking-time">
                  <Clock3 size={13} />
                  {formatTime(entry.lastCheckedAt)}
                </span>
                <div className="tracking-row-actions">
                  <button type="button" onClick={() => setSelectedWatch(entry)}>
                    <Info size={14} />
                    详情
                  </button>
                  <button type="button" onClick={() => onOpenWatch(entry)}>
                    打开
                  </button>
                  <button type="button" onClick={() => onRemoveWatch(entry.id)} title="取消追踪">
                    <Trash2 size={14} />
                  </button>
                </div>
              </article>
            ))}
          </div>
        ) : (
          <div className="empty-wall">
            {state.watchlist.length ? <Search size={36} /> : <Bell size={36} />}
            <p>{state.watchlist.length ? "没有匹配的追踪剧集" : "还没有订阅剧集，进入详情页后可以加入追踪。"}</p>
          </div>
        )}

        {filteredWatchlist.length ? (
          <TrackingPagination
            label="剧集追踪分页"
            currentPage={currentWatchPage}
            pageCount={watchPageCount}
            pageStart={watchPageStart}
            pageEnd={watchPageEnd}
            total={filteredWatchlist.length}
            pageSize={watchPageSize}
            onPageSize={setWatchPageSize}
            onPrev={() => setWatchPage((value) => Math.max(1, value - 1))}
            onNext={() => setWatchPage((value) => Math.min(watchPageCount, value + 1))}
          />
        ) : null}
      </section>

      {selectedWatch ? (
        <TrackingDetailModal
          item={selectedWatch}
          onClose={() => setSelectedWatch(null)}
          onOpen={() => {
            setSelectedWatch(null);
            onOpenWatch(selectedWatch);
          }}
          onRemove={() => {
            setSelectedWatch(null);
            onRemoveWatch(selectedWatch.id);
          }}
        />
      ) : null}

      <section className="panel management-list-panel">
        <div className="panel-title">
          <div>
            <p className="eyebrow">Update Feed</p>
            <h3>更新动态</h3>
          </div>
          <div className="panel-title-actions">
            <span className="notice-count">{watchNotices.length}</span>
            <button className="tool-button subtle" type="button" onClick={onMarkAll} disabled={!watchNotices.length || unreadWatchNotices === 0}>
              <Check size={16} />
              全部已读
            </button>
            <button className="tool-button subtle" type="button" onClick={onClearRead} disabled={!watchNotices.some((notice) => notice.read)}>
              <Trash2 size={16} />
              清理已读
            </button>
          </div>
        </div>

        {watchNotices.length ? (
          <div className="tracking-filter-tabs compact" aria-label="更新动态筛选">
            {noticeFilters.map((filter) => (
              <button
                className={noticeFilter === filter.value ? "active" : ""}
                key={filter.value}
                type="button"
                onClick={() => setNoticeFilter(filter.value)}
              >
                {filter.value === "unread" ? <Eye size={14} /> : filter.value === "read" ? <Check size={14} /> : <Bell size={14} />}
                <span>{filter.label}</span>
                <b>{filter.count}</b>
              </button>
            ))}
          </div>
        ) : null}

        {filteredNotices.length ? (
          <div className="tracking-event-list" aria-label="剧集更新动态">
            <div className="tracking-event-head">
              <span>动态</span>
              <span>时间</span>
              <span>状态</span>
              <span>操作</span>
            </div>
            {pageNotices.map((notice) => (
              <TrackingNoticeRow key={notice.id} notice={notice} onMarkOne={onMarkOne} />
            ))}
          </div>
        ) : (
          <div className="empty-wall">
            <Bell size={36} />
            <p>{watchNotices.length ? "没有匹配的更新动态" : "订阅剧集的更新提醒会显示在这里。"}</p>
          </div>
        )}

        {filteredNotices.length ? (
          <TrackingPagination
            label="更新动态分页"
            currentPage={currentNoticePage}
            pageCount={noticePageCount}
            pageStart={noticePageStart}
            pageEnd={noticePageEnd}
            total={filteredNotices.length}
            pageSize={noticePageSize}
            onPageSize={setNoticePageSize}
            onPrev={() => setNoticePage((value) => Math.max(1, value - 1))}
            onNext={() => setNoticePage((value) => Math.min(noticePageCount, value + 1))}
          />
        ) : null}
      </section>
    </section>
  );
}

function TrackingPagination({
  label,
  currentPage,
  pageCount,
  pageStart,
  pageEnd,
  total,
  pageSize,
  onPageSize,
  onPrev,
  onNext
}: {
  label: string;
  currentPage: number;
  pageCount: number;
  pageStart: number;
  pageEnd: number;
  total: number;
  pageSize: number;
  onPageSize: (value: number) => void;
  onPrev: () => void;
  onNext: () => void;
}) {
  return (
    <div className="tracking-pagination" aria-label={label}>
      <span>
        第 {currentPage} / {pageCount} 页 · 显示 {pageStart + 1}-{pageEnd} / {total}
      </span>
      <label>
        每页
        <select value={pageSize} onChange={(event) => onPageSize(Number(event.target.value))}>
          {pageSizeOptions.map((size) => (
            <option key={size} value={size}>
              {size}
            </option>
          ))}
        </select>
      </label>
      <div className="tracking-page-buttons">
        <button type="button" onClick={onPrev} disabled={currentPage <= 1} title="上一页">
          <ChevronLeft size={16} />
          上一页
        </button>
        <button type="button" onClick={onNext} disabled={currentPage >= pageCount} title="下一页">
          下一页
          <ChevronRight size={16} />
        </button>
      </div>
    </div>
  );
}

function TrackingDetailModal({
  item,
  onClose,
  onOpen,
  onRemove
}: {
  item: WatchItem;
  onClose: () => void;
  onOpen: () => void;
  onRemove: () => void;
}) {
  const meta = [item.item.year, item.item.area, item.item.language, item.item.typeName].filter(Boolean).join(" · ");
  const rows = [
    { label: "资源站", value: item.item.sourceName },
    { label: "最新集", value: item.latestEpisodeName ?? "未知" },
    { label: "自动下载", value: item.autoDownload ? "开启" : "关闭" },
    { label: "发现更新", value: item.updateFoundAt ? formatTime(item.updateFoundAt) : "暂无" },
    { label: "上次检查", value: formatTime(item.lastCheckedAt) },
    { label: "订阅时间", value: formatTime(item.createdAt) },
    { label: "资源 ID", value: item.item.vodId }
  ];

  return (
    <div className="tracking-modal-backdrop" role="presentation" onMouseDown={onClose}>
      <section className="tracking-modal" role="dialog" aria-modal="true" aria-label="追剧详情" onMouseDown={(event) => event.stopPropagation()}>
        <div className="tracking-modal-head">
          <div>
            <strong>{item.item.title}</strong>
            <span>{item.item.originalTitle && item.item.originalTitle !== item.item.title ? item.item.originalTitle : meta || item.item.sourceName}</span>
          </div>
          <button type="button" onClick={onClose} title="关闭">
            <X size={18} />
          </button>
        </div>

        <div className="tracking-detail-hero">
          <div className="tracking-detail-poster">
            {item.item.poster ? <img src={imageUrlFor(item.item.poster)} alt={item.item.title} /> : <Bell size={28} />}
          </div>
          <div>
            <span className={`status-pill ${item.updateFoundAt ? "downloading" : "queued"}`}>{item.updateFoundAt ? "有更新" : "追踪中"}</span>
            <p>{item.updateMessage ?? item.item.remarks ?? "等待下一次检查更新。"}</p>
            {meta ? <small>{meta}</small> : null}
          </div>
        </div>

        <div className="tracking-detail-grid">
          {rows.map((row) => (
            <article key={row.label}>
              <span>{row.label}</span>
              <strong title={row.value}>{row.value}</strong>
            </article>
          ))}
        </div>

        {item.item.description ? <p className="tracking-detail-description">{item.item.description}</p> : null}

        <div className="tracking-modal-actions">
          <button type="button" onClick={onOpen}>
            <Eye size={15} />
            打开详情
          </button>
          <button className="danger" type="button" onClick={onRemove}>
            <Trash2 size={15} />
            取消追踪
          </button>
        </div>
      </section>
    </div>
  );
}

function filterIcon(filter: WatchFilter) {
  if (filter === "updated") return <RefreshCw size={14} />;
  if (filter === "auto") return <DownloadCloud size={14} />;
  if (filter === "manual") return <Bell size={14} />;
  return <Eye size={14} />;
}

function isWatchFilter(value: unknown): value is WatchFilter {
  return typeof value === "string" && watchFiltersValues.includes(value as WatchFilter);
}

function isNoticeFilter(value: unknown): value is NoticeFilter {
  return typeof value === "string" && noticeFilterValues.includes(value as NoticeFilter);
}

function isWatchSort(value: unknown): value is WatchSort {
  return typeof value === "string" && watchSortValues.includes(value as WatchSort);
}

function isPageSize(value: unknown): value is number {
  return typeof value === "number" && pageSizeOptions.includes(value);
}

function sortWatchItems(left: WatchItem, right: WatchItem, sort: WatchSort) {
  if (sort === "checked-desc") return (right.lastCheckedAt ?? "").localeCompare(left.lastCheckedAt ?? "");
  if (sort === "created-desc") return right.createdAt.localeCompare(left.createdAt);
  if (sort === "title-asc") return left.item.title.localeCompare(right.item.title, "zh-CN");
  if (sort === "source-asc") {
    return left.item.sourceName.localeCompare(right.item.sourceName, "zh-CN") || left.item.title.localeCompare(right.item.title, "zh-CN");
  }
  return (right.updateFoundAt ?? right.lastCheckedAt ?? right.createdAt).localeCompare(left.updateFoundAt ?? left.lastCheckedAt ?? left.createdAt);
}

function TrackingStat({ label, value, icon, tone }: { label: string; value: number; icon: ReactNode; tone?: "good" | "warn" }) {
  return (
    <article className={`ops-stat ${tone ?? ""}`}>
      <div>
        {icon}
        <span>{label}</span>
      </div>
      <strong>{value}</strong>
    </article>
  );
}

function TrackingNoticeRow({ notice, onMarkOne }: { notice: HubNotification; onMarkOne: (id: string) => void }) {
  return (
    <article className={`tracking-event-row ${notice.tone} ${notice.read ? "read" : ""}`}>
      <div>
        <strong>{notice.title}</strong>
        <span>{notice.message}</span>
      </div>
      <span className="tracking-time">
        <Clock3 size={13} />
        {formatTime(notice.createdAt)}
      </span>
      <span className={`status-pill ${notice.read ? "completed" : "downloading"}`}>{notice.read ? "已读" : "未读"}</span>
      <button type="button" onClick={() => onMarkOne(notice.id)} disabled={notice.read}>
        <Check size={14} />
        标记
      </button>
    </article>
  );
}
