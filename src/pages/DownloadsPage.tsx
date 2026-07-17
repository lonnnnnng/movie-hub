import {
  ArrowDownAZ,
  CheckCircle2,
  ChevronLeft,
  ChevronRight,
  Clock3,
  Copy,
  Download,
  ExternalLink,
  Inbox,
  ListChecks,
  RefreshCw,
  RotateCcw,
  Search,
  Trash2,
  X,
  XCircle
} from "lucide-react";
import { useEffect, useMemo, useState, type FormEvent, type ReactNode } from "react";
import type { AppState, DownloadTask } from "../types";
import { formatTime } from "../lib/format";
import { useStoredState } from "../lib/storage";

type DownloadsPageProps = {
  state: AppState;
  onRemoveDownload: (id: string) => void;
  onRetryDownload: (id: string) => Promise<void> | void;
  onClearDownloads: (status: "completed" | "failed" | "canceled") => Promise<void> | void;
  onRefresh: () => void;
  onNotify: (message: string, tone?: "good" | "warn" | "bad") => void;
  loading?: boolean;
};

type DownloadStatusFilter = "all" | DownloadTask["status"];
type DownloadSortMode = "status" | "updated-desc" | "updated-asc" | "progress-desc" | "title-asc";

const pageSizeOptions = [10, 20, 50, 100];
const downloadStatusFilters = ["all", "queued", "downloading", "completed", "failed", "canceled"] satisfies DownloadStatusFilter[];
const downloadSortModes = ["status", "updated-desc", "updated-asc", "progress-desc", "title-asc"] satisfies DownloadSortMode[];

export function DownloadsPage({ state, onRemoveDownload, onRetryDownload, onClearDownloads, onRefresh, onNotify, loading = false }: DownloadsPageProps) {
  const [retryingFailed, setRetryingFailed] = useState(false);
  const [selectedTask, setSelectedTask] = useState<DownloadTask | null>(null);
  const [query, setQuery] = useState("");
  const [statusFilter, setStatusFilter] = useStoredState<DownloadStatusFilter>("movie-hub.downloads.statusFilter", "all", { validate: isDownloadStatusFilter });
  const [sortMode, setSortMode] = useStoredState<DownloadSortMode>("movie-hub.downloads.sortMode", "status", { validate: isDownloadSortMode });
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useStoredState<number>("movie-hub.downloads.pageSize", 20, { validate: isPageSize });
  const downloads = useMemo(() => sortDownloads(state.downloads, sortMode), [sortMode, state.downloads]);
  const activeDownloads = downloads.filter((task) => task.status === "queued" || task.status === "downloading");
  const completedDownloads = downloads.filter((task) => task.status === "completed");
  const failedDownloads = downloads.filter((task) => task.status === "failed");
  const canceledDownloads = downloads.filter((task) => task.status === "canceled");
  const retryableDownloads = downloads.filter((task) => task.status === "failed" || task.status === "canceled");
  const normalizedQuery = query.trim().toLowerCase();
  const filteredDownloads = useMemo(() => {
    return downloads.filter((task) => {
      if (statusFilter !== "all" && task.status !== statusFilter) return false;
      if (!normalizedQuery) return true;
      return [task.title, task.episodeName, task.message, task.downloader, task.outputPath, task.outputDir].some((value) =>
        value?.toLowerCase().includes(normalizedQuery)
      );
    });
  }, [downloads, normalizedQuery, statusFilter]);
  const pageCount = Math.max(1, Math.ceil(filteredDownloads.length / pageSize));
  const currentPage = Math.min(page, pageCount);
  const pageStart = (currentPage - 1) * pageSize;
  const pageEnd = Math.min(pageStart + pageSize, filteredDownloads.length);
  const pageDownloads = useMemo(() => filteredDownloads.slice(pageStart, pageEnd), [filteredDownloads, pageEnd, pageStart]);
  const visibleCount = (value: number) => (loading ? "..." : value);
  const statusFilters = [
    { value: "all" as const, label: "全部", count: visibleCount(downloads.length) },
    { value: "downloading" as const, label: "下载中", count: visibleCount(downloads.filter((task) => task.status === "downloading").length) },
    { value: "queued" as const, label: "排队", count: visibleCount(downloads.filter((task) => task.status === "queued").length) },
    { value: "failed" as const, label: "失败", count: visibleCount(failedDownloads.length) },
    { value: "canceled" as const, label: "取消", count: visibleCount(canceledDownloads.length) },
    { value: "completed" as const, label: "完成", count: visibleCount(completedDownloads.length) }
  ];

  useEffect(() => {
    setPage(1);
  }, [normalizedQuery, pageSize, sortMode, statusFilter]);

  useEffect(() => {
    if (page > pageCount) setPage(pageCount);
  }, [page, pageCount]);

  async function retryFailedDownloads() {
    if (retryingFailed || !retryableDownloads.length) return;
    setRetryingFailed(true);
    try {
      for (const task of retryableDownloads) {
        await onRetryDownload(task.id);
      }
    } finally {
      setRetryingFailed(false);
    }
  }

  async function copyDownloadText(value: string | undefined, label: string) {
    if (!value) {
      onNotify(`${label}为空，无法复制`, "warn");
      return;
    }
    try {
      await navigator.clipboard.writeText(value);
      onNotify(`${label}已复制`);
    } catch {
      onNotify("复制失败，请检查浏览器剪贴板权限", "bad");
    }
  }

  function submitSearch(event: FormEvent) {
    event.preventDefault();
    setPage(1);
  }

  return (
    <section className="page-stack downloads-page">
      <div className="ops-summary management-summary">
        <DownloadStat label="全部任务" value={visibleCount(downloads.length)} icon={<ListChecks size={20} />} loading={loading} />
        <DownloadStat label="进行中" value={visibleCount(activeDownloads.length)} icon={<Download size={20} />} tone="good" loading={loading} />
        <DownloadStat label="已完成" value={visibleCount(completedDownloads.length)} icon={<Inbox size={20} />} loading={loading} />
        <DownloadStat
          label="失败/取消"
          value={visibleCount(failedDownloads.length + canceledDownloads.length)}
          icon={<XCircle size={20} />}
          tone={failedDownloads.length ? "warn" : undefined}
          loading={loading}
        />
      </div>

      <section className="panel management-list-panel">
        <div className="panel-title">
          <div>
            <p className="eyebrow">Downloads</p>
            <h3>下载任务列表</h3>
          </div>
          <div className="panel-title-actions">
            <span className="notice-count">{visibleCount(downloads.length)}</span>
            <button className="tool-button subtle" type="button" onClick={() => onClearDownloads("completed")} disabled={loading || !completedDownloads.length}>
              <Trash2 size={16} />
              清理完成
            </button>
            <button className="tool-button subtle" type="button" onClick={() => onClearDownloads("failed")} disabled={loading || !failedDownloads.length}>
              <XCircle size={16} />
              清理失败
            </button>
            <button className="tool-button subtle" type="button" onClick={() => onClearDownloads("canceled")} disabled={loading || !canceledDownloads.length}>
              <Trash2 size={16} />
              清理取消
            </button>
            <button className="tool-button subtle" type="button" onClick={() => void retryFailedDownloads()} disabled={loading || !retryableDownloads.length || retryingFailed}>
              <RotateCcw size={16} />
              {retryingFailed ? "重试中" : "重试异常"}
            </button>
            <button className="tool-button subtle" type="button" onClick={onRefresh} disabled={loading}>
              <RefreshCw size={16} />
              刷新
            </button>
          </div>
        </div>

        <form className="download-toolbar" onSubmit={submitSearch}>
          <label className="download-search">
            <Search size={17} />
            <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="搜索标题、集名、下载器或消息" />
            {query ? (
              <button type="button" onClick={() => setQuery("")} title="清空搜索">
                <X size={15} />
              </button>
            ) : null}
          </label>
          <button className="tool-button toolbar-search-button" type="submit" disabled={loading}>
            <Search size={16} />
            搜索
          </button>
          <label className="download-sort">
            <ArrowDownAZ size={16} />
            <select value={sortMode} onChange={(event) => setSortMode(event.target.value as DownloadSortMode)} disabled={loading}>
              <option value="status">状态优先</option>
              <option value="updated-desc">最近更新</option>
              <option value="updated-asc">最早更新</option>
              <option value="progress-desc">进度最高</option>
              <option value="title-asc">标题 A-Z</option>
            </select>
          </label>
        </form>

        <div className="download-filter-tabs" aria-label="下载任务状态筛选">
          {statusFilters.map((filter) => (
            <button
              key={filter.value}
              className={statusFilter === filter.value ? "active" : ""}
              type="button"
              onClick={() => setStatusFilter(filter.value)}
              disabled={loading}
            >
              {statusIcon(filter.value)}
              <span>{filter.label}</span>
              <b>{filter.count}</b>
            </button>
          ))}
        </div>

        {loading ? (
          <div className="download-table-list" aria-label="下载任务加载中">
            <div className="download-table-head">
              <span>任务</span>
              <span>下载器</span>
              <span>状态</span>
              <span>进度</span>
              <span>更新时间</span>
              <span>操作</span>
            </div>
            {Array.from({ length: 5 }).map((_, index) => (
              <DownloadTaskSkeleton key={`download-skeleton-${index}`} />
            ))}
          </div>
        ) : filteredDownloads.length ? (
          <div className="download-table-list" aria-label="下载任务列表">
            <div className="download-table-head">
              <span>任务</span>
              <span>下载器</span>
              <span>状态</span>
              <span>进度</span>
              <span>更新时间</span>
              <span>操作</span>
            </div>
            {pageDownloads.map((task) => (
              <DownloadTaskRow key={task.id} task={task} onOpen={setSelectedTask} onRemove={onRemoveDownload} onRetry={onRetryDownload} />
            ))}
          </div>
        ) : (
          <div className="empty-wall">
            {downloads.length ? <Search size={36} /> : <Download size={36} />}
            <p>{downloads.length ? "没有匹配的下载任务" : "还没有下载任务，进入剧集详情页后可以添加下载。"}</p>
          </div>
        )}

        {!loading && filteredDownloads.length ? (
          <div className="download-pagination" aria-label="下载任务分页">
            <span>
              第 {currentPage} / {pageCount} 页 · 显示 {pageStart + 1}-{pageEnd} / {filteredDownloads.length}
            </span>
            <label>
              每页
              <select value={pageSize} onChange={(event) => setPageSize(Number(event.target.value))}>
                {pageSizeOptions.map((size) => (
                  <option key={size} value={size}>
                    {size}
                  </option>
                ))}
              </select>
            </label>
            <div className="download-page-buttons">
              <button type="button" onClick={() => setPage((value) => Math.max(1, value - 1))} disabled={currentPage <= 1} title="上一页">
                <ChevronLeft size={16} />
                上一页
              </button>
              <button type="button" onClick={() => setPage((value) => Math.min(pageCount, value + 1))} disabled={currentPage >= pageCount} title="下一页">
                下一页
                <ChevronRight size={16} />
              </button>
            </div>
          </div>
        ) : null}
      </section>
      {selectedTask ? (
        <DownloadTaskModal
          task={selectedTask}
          onClose={() => setSelectedTask(null)}
          onCopy={(value, label) => void copyDownloadText(value, label)}
          onRemove={(id) => {
            setSelectedTask(null);
            onRemoveDownload(id);
          }}
          onRetry={(id) => void onRetryDownload(id)}
        />
      ) : null}
    </section>
  );
}

function DownloadStat({
  label,
  value,
  icon,
  tone,
  loading
}: {
  label: string;
  value: number | string;
  icon: ReactNode;
  tone?: "good" | "warn";
  loading?: boolean;
}) {
  return (
    <article className={`ops-stat ${tone ?? ""} ${loading ? "loading" : ""}`}>
      <div>
        {icon}
        <span>{label}</span>
      </div>
      <strong>{value}</strong>
    </article>
  );
}

function DownloadTaskSkeleton() {
  return (
    <article aria-hidden="true" className="download-table-row download-table-skeleton">
      <div className="download-task-cell">
        <span className="skeleton-line wide" />
        <span className="skeleton-line medium" />
        <span className="skeleton-line full" />
      </div>
      <span className="skeleton-line medium" />
      <span className="skeleton-pill" />
      <div className="download-progress-cell">
        <span className="skeleton-line tiny" />
        <div className="skeleton-bar" />
      </div>
      <span className="skeleton-line medium" />
      <div className="download-row-actions">
        <span className="skeleton-action" />
      </div>
    </article>
  );
}

function DownloadTaskRow({
  task,
  onOpen,
  onRemove,
  onRetry
}: {
  task: DownloadTask;
  onOpen: (task: DownloadTask) => void;
  onRemove: (id: string) => void;
  onRetry: (id: string) => Promise<void> | void;
}) {
  const active = task.status === "queued" || task.status === "downloading";
  return (
    <article className={`download-table-row ${task.status}`}>
      <div className="download-task-cell">
        <strong>{task.title}</strong>
        <span>{task.episodeName}</span>
        <small>{task.message ?? "等待下载器处理"}</small>
      </div>
      <span data-label="下载器">{task.downloader ? downloaderLabel(task.downloader) : "--"}</span>
      <span className="download-status-cell" data-label="状态">
        <span className={`status-pill ${task.status}`}>{statusLabel(task.status)}</span>
      </span>
      <div className="download-progress-cell" data-label="进度">
        <b>{task.progress}%</b>
        <div className="progress-bar">
          <span style={{ width: `${task.progress}%` }} />
        </div>
      </div>
      <span className="download-time-cell" data-label="更新时间">
        <span className="tracking-time">
          <Clock3 size={13} />
          {formatTime(task.updatedAt)}
        </span>
      </span>
      <div className="download-row-actions">
        <button type="button" onClick={() => onOpen(task)} title="查看任务详情">
          <ExternalLink size={14} />
          详情
        </button>
        {task.status === "failed" || task.status === "canceled" ? (
          <button type="button" onClick={() => void onRetry(task.id)} title="重试任务">
            <RotateCcw size={14} />
            重试
          </button>
        ) : null}
        <button type="button" onClick={() => onRemove(task.id)} title={active ? "取消下载" : "移除任务"}>
          {active ? <XCircle size={14} /> : <Trash2 size={14} />}
          {active ? "取消" : "移除"}
        </button>
      </div>
    </article>
  );
}

function DownloadTaskModal({
  task,
  onClose,
  onCopy,
  onRemove,
  onRetry
}: {
  task: DownloadTask;
  onClose: () => void;
  onCopy: (value: string | undefined, label: string) => void;
  onRemove: (id: string) => void;
  onRetry: (id: string) => void;
}) {
  const active = task.status === "queued" || task.status === "downloading";
  const retryable = task.status === "failed" || task.status === "canceled";
  const detailRows = [
    { label: "任务 ID", value: task.id },
    { label: "资源地址", value: task.url },
    { label: "输出目录", value: task.outputDir },
    { label: "输出文件", value: task.outputPath },
    { label: "播放列表", value: task.playlistPath },
    { label: "播放地址", value: task.playlistUrl },
    { label: "资源站", value: task.sourceId },
    { label: "创建时间", value: formatTime(task.createdAt) },
    { label: "更新时间", value: formatTime(task.updatedAt) }
  ];
  return (
    <div className="download-modal-backdrop" role="presentation" onMouseDown={onClose}>
      <section className="download-modal" role="dialog" aria-modal="true" aria-label="下载任务详情" onMouseDown={(event) => event.stopPropagation()}>
        <div className="download-modal-head">
          <div>
            <strong>{task.title}</strong>
            <span>{task.episodeName || "未命名剧集"}</span>
          </div>
          <button type="button" onClick={onClose} title="关闭">
            <X size={18} />
          </button>
        </div>

        <div className="download-modal-status">
          <span className={`status-pill ${task.status}`}>{statusLabel(task.status)}</span>
          <b>{task.progress}%</b>
          <div className="progress-bar">
            <span style={{ width: `${task.progress}%` }} />
          </div>
        </div>

        <div className="download-modal-message">
          <span>当前消息</span>
          <p>{task.message ?? "暂无下载器消息"}</p>
        </div>

        <div className="download-detail-grid">
          {detailRows.map((row) => (
            <div className="download-detail-row" key={row.label}>
              <span>{row.label}</span>
              <code title={row.value || undefined}>{row.value || "--"}</code>
              <button type="button" onClick={() => onCopy(row.value, row.label)} disabled={!row.value} title={`复制${row.label}`}>
                <Copy size={14} />
              </button>
            </div>
          ))}
        </div>

        <div className="download-modal-actions">
          {retryable ? (
            <button type="button" onClick={() => onRetry(task.id)}>
              <RotateCcw size={15} />
              重试任务
            </button>
          ) : null}
          <button className="danger" type="button" onClick={() => onRemove(task.id)}>
            {active ? <XCircle size={15} /> : <Trash2 size={15} />}
            {active ? "取消下载" : "移除任务"}
          </button>
        </div>
      </section>
    </div>
  );
}

function downloaderLabel(downloader: NonNullable<DownloadTask["downloader"]>) {
  return downloader === "n-m3u8dl-re" ? "N_m3u8DL-RE" : "ffmpeg";
}

function statusIcon(status: DownloadStatusFilter) {
  if (status === "all") return <ListChecks size={14} />;
  if (status === "queued") return <Clock3 size={14} />;
  if (status === "downloading") return <Download size={14} />;
  if (status === "completed") return <CheckCircle2 size={14} />;
  if (status === "canceled") return <X size={14} />;
  return <XCircle size={14} />;
}

function downloadRank(status: DownloadTask["status"]) {
  return {
    downloading: 0,
    queued: 1,
    failed: 2,
    canceled: 3,
    completed: 4
  }[status];
}

function sortDownloads(downloads: DownloadTask[], sortMode: DownloadSortMode) {
  return [...downloads].sort((left, right) => {
    if (sortMode === "updated-desc") return right.updatedAt.localeCompare(left.updatedAt);
    if (sortMode === "updated-asc") return left.updatedAt.localeCompare(right.updatedAt);
    if (sortMode === "progress-desc") return right.progress - left.progress || right.updatedAt.localeCompare(left.updatedAt);
    if (sortMode === "title-asc") {
      return `${left.title} ${left.episodeName}`.localeCompare(`${right.title} ${right.episodeName}`, "zh-CN") || right.updatedAt.localeCompare(left.updatedAt);
    }
    return downloadRank(left.status) - downloadRank(right.status) || right.updatedAt.localeCompare(left.updatedAt);
  });
}

function statusLabel(status: DownloadTask["status"]) {
  return {
    queued: "排队中",
    downloading: "下载中",
    completed: "已完成",
    failed: "失败",
    canceled: "已取消"
  }[status];
}

function isDownloadStatusFilter(value: unknown): value is DownloadStatusFilter {
  return typeof value === "string" && downloadStatusFilters.includes(value as DownloadStatusFilter);
}

function isDownloadSortMode(value: unknown): value is DownloadSortMode {
  return typeof value === "string" && downloadSortModes.includes(value as DownloadSortMode);
}

function isPageSize(value: unknown): value is number {
  return typeof value === "number" && pageSizeOptions.includes(value);
}
