import {
  ArrowDownAZ,
  CheckCircle2,
  ChevronLeft,
  ChevronRight,
  Clock3,
  Copy,
  ExternalLink,
  Film,
  HardDrive,
  Play,
  RadioTower,
  RefreshCw,
  Router,
  Search,
  X,
  XCircle
} from "lucide-react";
import type { FormEvent, ReactNode } from "react";
import { useEffect, useMemo, useState } from "react";
import { VideoPlayer } from "../components/VideoPlayer";
import { fileSize, formatTime, mediaProbeSummary } from "../lib/format";
import { useStoredState } from "../lib/storage";
import type { LocalHlsJob, LocalVideo } from "../types";

type LibraryPageProps = {
  videos: LocalVideo[];
  hlsJobs: LocalHlsJob[];
  current?: LocalVideo | null;
  onPlay: (video: LocalVideo) => void;
  onHls: (video: LocalVideo) => void;
  onRefresh: () => Promise<void> | void;
  onNotify: (message: string, tone?: "good" | "warn" | "bad") => void;
  loading?: boolean;
};

type HlsFilter = "all" | "ready" | "running" | "missing" | "failed";
type LibrarySortMode = "modified-desc" | "modified-asc" | "title-asc" | "size-desc" | "size-asc";

const hlsFilters = ["all", "ready", "running", "missing", "failed"] satisfies HlsFilter[];
const librarySortModes = ["modified-desc", "modified-asc", "title-asc", "size-desc", "size-asc"] satisfies LibrarySortMode[];
const pageSizeOptions = [10, 20, 50, 100];

export function LibraryPage({ videos, hlsJobs, onPlay, onHls, onRefresh, onNotify, loading = false }: LibraryPageProps) {
  const [playingVideo, setPlayingVideo] = useState<LocalVideo | null>(null);
  const [progressVideo, setProgressVideo] = useState<LocalVideo | null>(null);
  const [detailsVideo, setDetailsVideo] = useState<LocalVideo | null>(null);
  const [copyTarget, setCopyTarget] = useState<{ title: string; url: string; label: string } | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [query, setQuery] = useState("");
  const [hlsFilter, setHlsFilter] = useStoredState<HlsFilter>("movie-hub.library.hlsFilter", "all", { validate: isHlsFilter });
  const [sortMode, setSortMode] = useStoredState<LibrarySortMode>("movie-hub.library.sortMode", "modified-desc", { validate: isLibrarySortMode });
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useStoredState<number>("movie-hub.library.pageSize", 20, { validate: isPageSize });

  const sortedVideos = useMemo(
    () =>
      [...videos].sort((left, right) => {
        if (sortMode === "title-asc") return videoDisplayTitle(left).localeCompare(videoDisplayTitle(right), "zh-CN");
        if (sortMode === "size-desc") return right.size - left.size || videoDisplayTitle(left).localeCompare(videoDisplayTitle(right), "zh-CN");
        if (sortMode === "size-asc") return left.size - right.size || videoDisplayTitle(left).localeCompare(videoDisplayTitle(right), "zh-CN");

        const leftTime = safeTime(left.modifiedAt);
        const rightTime = safeTime(right.modifiedAt);
        return sortMode === "modified-asc" ? leftTime - rightTime : rightTime - leftTime;
      }),
    [sortMode, videos]
  );

  const jobsByVideoId = useMemo(() => {
    const map = new Map<string, LocalHlsJob>();
    for (const job of hlsJobs) {
      const current = map.get(job.videoId);
      if (!current || job.updatedAt.localeCompare(current.updatedAt) > 0) {
        map.set(job.videoId, job);
      }
    }
    return map;
  }, [hlsJobs]);

  const normalizedQuery = query.trim().toLowerCase();
  const hlsFilterOptions = useMemo(() => {
    const count = (filter: HlsFilter) =>
      sortedVideos.filter((video) => {
        if (filter === "all") return true;
        return videoHlsFilter(video, jobsByVideoId.get(video.id)) === filter;
      }).length;
    return [
      { value: "all" as const, label: "全部", count: sortedVideos.length },
      { value: "ready" as const, label: "已就绪", count: count("ready") },
      { value: "running" as const, label: "生成中", count: count("running") },
      { value: "missing" as const, label: "未生成", count: count("missing") },
      { value: "failed" as const, label: "失败", count: count("failed") }
    ];
  }, [jobsByVideoId, sortedVideos]);
  const visibleVideos = useMemo(() => {
    return sortedVideos.filter((video) => {
      if (hlsFilter !== "all" && videoHlsFilter(video, jobsByVideoId.get(video.id)) !== hlsFilter) return false;
      if (!normalizedQuery) return true;
      return [video.title, video.episodeName, video.fileName, video.path].some((value) => value?.toLowerCase().includes(normalizedQuery));
    });
  }, [hlsFilter, jobsByVideoId, normalizedQuery, sortedVideos]);

  const pageCount = Math.max(1, Math.ceil(visibleVideos.length / pageSize));
  const currentPage = Math.min(page, pageCount);
  const pageStart = (currentPage - 1) * pageSize;
  const pageEnd = Math.min(pageStart + pageSize, visibleVideos.length);
  const pageVideos = useMemo(() => visibleVideos.slice(pageStart, pageEnd), [pageEnd, pageStart, visibleVideos]);
  const progressJob = progressVideo ? jobsByVideoId.get(progressVideo.id) : undefined;

  useEffect(() => {
    setPage(1);
  }, [hlsFilter, normalizedQuery, pageSize, sortMode]);

  useEffect(() => {
    if (page > pageCount) {
      setPage(pageCount);
    }
  }, [page, pageCount]);

  function play(video: LocalVideo) {
    onPlay(video);
    setPlayingVideo(video);
  }

  function openHlsProgress(video: LocalVideo) {
    setProgressVideo(video);
    const job = jobsByVideoId.get(video.id);
    if (!video.hlsUrl && !job) {
      onHls(video);
    }
  }

  function submitSearch(event: FormEvent) {
    event.preventDefault();
    setPage(1);
  }

  async function refreshLibrary() {
    if (refreshing || loading) return;
    setRefreshing(true);
    try {
      await onRefresh();
    } finally {
      setRefreshing(false);
    }
  }

  async function copyPlayUrl(video: LocalVideo) {
    const url = video.hlsUrl ?? video.streamUrl;
    const label = video.hlsUrl ? "HLS 地址" : "播放地址";
    try {
      await copyText(url);
      onNotify(`${label}已复制`);
    } catch {
      setCopyTarget({ title: video.title, url, label });
      onNotify("浏览器限制了自动复制，请在弹框中手动复制", "warn");
    }
  }

  async function copyLibraryValue(value: string | undefined, label: string) {
    if (!value) {
      onNotify(`${label}为空，无法复制`, "warn");
      return;
    }
    try {
      await copyText(value);
      onNotify(`${label}已复制`);
    } catch {
      setCopyTarget({ title: detailsVideo?.title ?? "本地资源", url: value, label });
      onNotify("浏览器限制了自动复制，请在弹框中手动复制", "warn");
    }
  }

  return (
    <section className="page-stack library-page">
      <form className="library-toolbar" onSubmit={submitSearch}>
        <label className="library-search">
          <Search size={17} />
          <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="搜索标题、集名、文件名或路径" />
          {query ? (
            <button type="button" onClick={() => setQuery("")} title="清空搜索">
              <X size={15} />
            </button>
          ) : null}
        </label>
        <button className="tool-button toolbar-search-button" type="submit">
          <Search size={16} />
          搜索
        </button>
        <label className="library-sort">
          <ArrowDownAZ size={16} />
          <select value={sortMode} onChange={(event) => setSortMode(event.target.value as LibrarySortMode)}>
            <option value="modified-desc">最新修改</option>
            <option value="modified-asc">最早修改</option>
            <option value="title-asc">片名 A-Z</option>
            <option value="size-desc">文件最大</option>
            <option value="size-asc">文件最小</option>
          </select>
        </label>
        <button className="tool-button subtle library-refresh-button" type="button" onClick={() => void refreshLibrary()} disabled={loading || refreshing}>
          <RefreshCw className={refreshing || loading ? "spin" : ""} size={16} />
          刷新片库
        </button>
      </form>

      <div className="library-filter-tabs" aria-label="本地片库 HLS 状态筛选">
        {hlsFilterOptions.map((filter) => (
          <button
            className={hlsFilter === filter.value ? "active" : ""}
            disabled={loading}
            key={filter.value}
            type="button"
            onClick={() => setHlsFilter(filter.value)}
          >
            {hlsFilterIcon(filter.value)}
            <span>{filter.label}</span>
            <b>{loading ? "..." : filter.count}</b>
          </button>
        ))}
      </div>

      {loading ? (
        <div className="library-list" aria-label="本地片库加载中">
          <div className="library-list-head">
            <span>资源</span>
            <span>大小</span>
            <span>修改时间</span>
            <span>HLS</span>
            <span>操作</span>
          </div>
          {Array.from({ length: 6 }).map((_, index) => (
            <LibraryRowSkeleton key={`library-skeleton-${index}`} />
          ))}
        </div>
      ) : visibleVideos.length ? (
        <div className="library-list" aria-label="本地资源列表">
          <div className="library-list-head">
            <span>资源</span>
            <span>大小</span>
            <span>修改时间</span>
            <span>HLS</span>
            <span>操作</span>
          </div>
          {pageVideos.map((video) => {
            const job = jobsByVideoId.get(video.id);
            const hlsReady = Boolean(video.hlsUrl || job?.status === "completed");

            return (
              <article key={video.id} className="library-row">
                <div className="library-row-main">
                  <div className="library-icon">
                    <Film size={22} />
                  </div>
                  <div className="library-row-copy">
                    <strong>{video.title}</strong>
                    <span>
                      {video.episodeName ?? video.fileName}
                      {video.probe ? ` | ${mediaProbeSummary(video.probe)}` : ""}
                    </span>
                    <small title={video.path}>{video.path}</small>
                  </div>
                </div>
                <span className="library-row-size">{fileSize(video.size)}</span>
                <span className="library-row-time">
                  <Clock3 size={13} />
                  {formatTime(video.modifiedAt)}
                </span>
                <span className={`status-pill ${statusClass(job?.status, hlsReady)}`}>
                  {job ? hlsStatusIcon(job.status) : hlsReady ? <CheckCircle2 size={14} /> : <Router size={14} />}
                  {job ? statusText(job.status) : hlsReady ? "已就绪" : "未生成"}
                </span>
                <div className="library-row-actions">
                  <button type="button" onClick={() => play(video)} title="播放">
                    <Play size={15} />
                    播放
                  </button>
                  <button type="button" onClick={() => setDetailsVideo(video)} title="查看资源详情">
                    <ExternalLink size={15} />
                    详情
                  </button>
                  <button type="button" onClick={() => void copyPlayUrl(video)} title={video.hlsUrl ? "复制 HLS 地址" : "复制播放地址"}>
                    <Copy size={15} />
                    复制
                  </button>
                  <button type="button" onClick={() => openHlsProgress(video)} title={hlsReady || job ? "查看 HLS 进度" : "生成 HLS"}>
                    <Router size={15} />
                    {job || hlsReady ? "进度" : "生成"}
                  </button>
                </div>
              </article>
            );
          })}
        </div>
      ) : (
        <div className="empty-wall">
          {normalizedQuery ? <Search size={36} /> : <HardDrive size={36} />}
          <p>{normalizedQuery ? "没有匹配的本地资源" : "把视频文件放进 media 目录后会自动出现在这里"}</p>
        </div>
      )}

      {!loading && visibleVideos.length ? (
        <div className="library-pagination" aria-label="本地片库分页">
          <span>
            第 {currentPage} / {pageCount} 页 · 显示 {pageStart + 1}-{pageEnd} / {visibleVideos.length}
          </span>
          <label>
            每页
            <select value={pageSize} onChange={(event) => setPageSize(Number(event.target.value))}>
              <option value={10}>10</option>
              <option value={20}>20</option>
              <option value={50}>50</option>
              <option value={100}>100</option>
            </select>
          </label>
          <div className="library-page-buttons">
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

      {playingVideo ? (
        <LibraryModal title={playingVideo.title} subtitle={playingVideo.episodeName ?? playingVideo.fileName} onClose={() => setPlayingVideo(null)} wide>
          <VideoPlayer url={playingVideo.hlsUrl ?? playingVideo.streamUrl} title={playingVideo.title} />
        </LibraryModal>
      ) : null}

      {detailsVideo ? (
        <LibraryModal title="本地资源详情" subtitle={detailsVideo.title} onClose={() => setDetailsVideo(null)} details>
          <LibraryVideoDetails
            video={detailsVideo}
            job={jobsByVideoId.get(detailsVideo.id)}
            onCopy={(value, label) => void copyLibraryValue(value, label)}
            onHls={() => {
              setDetailsVideo(null);
              openHlsProgress(detailsVideo);
            }}
            onPlay={() => {
              setDetailsVideo(null);
              play(detailsVideo);
            }}
          />
        </LibraryModal>
      ) : null}

      {progressVideo ? (
        <LibraryModal title="HLS 切片进度" subtitle={progressVideo.episodeName ?? progressVideo.fileName} onClose={() => setProgressVideo(null)}>
          <HlsProgress video={progressVideo} job={progressJob} />
        </LibraryModal>
      ) : null}

      {copyTarget ? (
        <LibraryModal title={`复制${copyTarget.label}`} subtitle={copyTarget.title} onClose={() => setCopyTarget(null)}>
          <CopyUrlPanel target={copyTarget} onNotify={onNotify} />
        </LibraryModal>
      ) : null}
    </section>
  );
}

function videoDisplayTitle(video: LocalVideo) {
  return [video.title, video.episodeName, video.fileName].filter(Boolean).join(" ");
}

function safeTime(value: string) {
  const time = new Date(value).getTime();
  return Number.isNaN(time) ? 0 : time;
}

async function copyText(value: string) {
  if (navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(value);
    return;
  }

  const textarea = document.createElement("textarea");
  textarea.value = value;
  textarea.setAttribute("readonly", "true");
  textarea.style.position = "fixed";
  textarea.style.left = "-9999px";
  textarea.style.top = "0";
  document.body.appendChild(textarea);
  textarea.select();
  const copied = document.execCommand("copy");
  textarea.remove();
  if (!copied) throw new Error("copy failed");
}

function LibraryRowSkeleton() {
  return (
    <article aria-hidden="true" className="library-row library-row-skeleton">
      <div className="library-row-main">
        <span className="library-icon skeleton-icon" />
        <div className="library-row-copy">
          <span className="skeleton-line wide" />
          <span className="skeleton-line medium" />
          <span className="skeleton-line full" />
        </div>
      </div>
      <span className="skeleton-line medium" />
      <span className="skeleton-line medium" />
      <span className="skeleton-pill" />
      <div className="library-row-actions">
        <span className="skeleton-action" />
        <span className="skeleton-action" />
      </div>
    </article>
  );
}

function CopyUrlPanel({
  target,
  onNotify
}: {
  target: { title: string; url: string; label: string };
  onNotify: (message: string, tone?: "good" | "warn" | "bad") => void;
}) {
  async function retryCopy() {
    try {
      await copyText(target.url);
      onNotify(`${target.label}已复制`);
    } catch {
      onNotify("仍然无法自动复制，请手动选中地址", "warn");
    }
  }

  return (
    <div className="library-copy-panel">
      <span>浏览器限制了自动复制，可以手动选中下方地址。</span>
      <textarea readOnly value={target.url} onFocus={(event) => event.currentTarget.select()} />
      <button className="tool-button" type="button" onClick={() => void retryCopy()}>
        <Copy size={16} />
        再试一次
      </button>
    </div>
  );
}

function LibraryVideoDetails({
  video,
  job,
  onCopy,
  onHls,
  onPlay
}: {
  video: LocalVideo;
  job?: LocalHlsJob;
  onCopy: (value: string | undefined, label: string) => void;
  onHls: () => void;
  onPlay: () => void;
}) {
  const hlsReady = Boolean(video.hlsUrl || job?.status === "completed");
  const status = job?.status ?? (video.hlsUrl ? "completed" : undefined);
  const detailRows = [
    { label: "文件名", value: video.fileName },
    { label: "本地路径", value: video.path },
    { label: "播放地址", value: video.streamUrl },
    { label: "HLS 地址", value: video.hlsUrl },
    { label: "视频 ID", value: video.id },
    { label: "文件大小", value: fileSize(video.size) },
    { label: "修改时间", value: formatTime(video.modifiedAt) }
  ];
  const probeRows = mediaProbeRows(video);

  return (
    <div className="library-details">
      <div className="library-details-hero">
        <div className="library-details-icon">
          <Film size={28} />
        </div>
        <div>
          <strong>{video.title}</strong>
          <span>{video.episodeName ?? video.fileName}</span>
          <small>{mediaProbeSummary(video.probe) || "暂无媒体探测信息"}</small>
        </div>
      </div>

      <div className="library-details-status">
        <span className={`status-pill ${statusClass(status, hlsReady)}`}>
          {status ? hlsStatusIcon(status) : <Router size={14} />}
          {status ? statusText(status) : "未生成"}
        </span>
        <b>{job?.progress ?? (hlsReady ? 100 : 0)}%</b>
        <div className="progress-bar">
          <span style={{ width: `${job?.progress ?? (hlsReady ? 100 : 0)}%` }} />
        </div>
      </div>

      <div className="library-detail-grid">
        {detailRows.map((row) => (
          <div className="library-detail-row" key={row.label}>
            <span>{row.label}</span>
            <code title={row.value || undefined}>{row.value || "--"}</code>
            <button type="button" onClick={() => onCopy(row.value, row.label)} disabled={!row.value} title={`复制${row.label}`}>
              <Copy size={14} />
            </button>
          </div>
        ))}
      </div>

      <div className="library-probe-grid">
        {probeRows.map((row) => (
          <article key={row.label}>
            <span>{row.label}</span>
            <strong>{row.value}</strong>
          </article>
        ))}
      </div>

      <div className="library-details-note">
        <RadioTower size={16} />
        <span>{job?.message ?? (hlsReady ? "HLS 已生成，可用于共享中心和移动端播放。" : "还没有 HLS 切片，可以从这里打开进度并触发生成。")}</span>
      </div>

      <div className="library-details-actions">
        <button type="button" onClick={onPlay}>
          <Play size={15} />
          播放
        </button>
        <button type="button" onClick={onHls}>
          <Router size={15} />
          {hlsReady || job ? "查看 HLS" : "生成 HLS"}
        </button>
      </div>
    </div>
  );
}

function LibraryModal({
  title,
  subtitle,
  wide,
  details,
  onClose,
  children
}: {
  title: string;
  subtitle?: string;
  wide?: boolean;
  details?: boolean;
  onClose: () => void;
  children: ReactNode;
}) {
  return (
    <div className="library-modal-backdrop" role="presentation" onMouseDown={onClose}>
      <section
        className={`library-modal ${wide ? "wide" : ""} ${details ? "details" : ""}`}
        role="dialog"
        aria-modal="true"
        aria-label={title}
        onMouseDown={(event) => event.stopPropagation()}
      >
        <div className="library-modal-head">
          <div>
            <strong>{title}</strong>
            {subtitle ? <span>{subtitle}</span> : null}
          </div>
          <button type="button" onClick={onClose} title="关闭">
            <X size={18} />
          </button>
        </div>
        {children}
      </section>
    </div>
  );
}

function mediaProbeRows(video: LocalVideo) {
  const probe = video.probe;
  return [
    { label: "时长", value: probe?.durationSeconds != null ? mediaProbeDuration(probe.durationSeconds) : "--" },
    { label: "分辨率", value: probe?.width && probe.height ? `${probe.width}x${probe.height}` : "--" },
    { label: "视频编码", value: probe?.videoCodec ?? "--" },
    { label: "音频编码", value: probe?.audioCodec ?? "--" },
    { label: "码率", value: probe?.bitrateKbps ? `${Math.round(probe.bitrateKbps)} kbps` : "--" },
    { label: "封装", value: probe?.containerFormat ?? "--" }
  ];
}

function mediaProbeDuration(seconds: number) {
  const total = Math.max(0, Math.round(seconds));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const secs = total % 60;
  if (hours) return `${hours}:${String(minutes).padStart(2, "0")}:${String(secs).padStart(2, "0")}`;
  return `${minutes}:${String(secs).padStart(2, "0")}`;
}

function HlsProgress({ video, job }: { video: LocalVideo; job?: LocalHlsJob }) {
  const progress = job?.progress ?? (video.hlsUrl ? 100 : 0);
  const status = job?.status ?? (video.hlsUrl ? "completed" : undefined);

  return (
    <div className="library-progress">
      <div className="library-progress-top">
        <span className={`status-pill ${statusClass(status, Boolean(video.hlsUrl))}`}>
          {status ? hlsStatusIcon(status) : <RadioTower size={14} />}
          {status ? statusText(status) : "等待任务"}
        </span>
        <b>{progress}%</b>
      </div>
      <div className="progress-bar library-progress-bar">
        <span style={{ width: `${progress}%` }} />
      </div>
      <div className="library-progress-meta">
        <span>{job?.message ?? (video.hlsUrl ? "HLS 已生成，可直接播放" : "任务已提交，等待后台创建切片进度")}</span>
        <small>{job ? `更新时间 ${new Date(job.updatedAt).toLocaleString()}` : video.path}</small>
      </div>
    </div>
  );
}

function statusClass(status?: LocalHlsJob["status"], ready = false) {
  if (status === "running" || status === "queued") return "downloading";
  if (status === "completed" || ready) return "completed";
  if (status === "failed") return "failed";
  return "queued";
}

function videoHlsFilter(video: LocalVideo, job?: LocalHlsJob): HlsFilter {
  if (job?.status === "failed") return "failed";
  if (job?.status === "queued" || job?.status === "running") return "running";
  if (job?.status === "completed" || video.hlsUrl) return "ready";
  return "missing";
}

function hlsFilterIcon(filter: HlsFilter) {
  if (filter === "ready") return <CheckCircle2 size={14} />;
  if (filter === "running") return <RadioTower size={14} />;
  if (filter === "failed") return <XCircle size={14} />;
  if (filter === "missing") return <Router size={14} />;
  return <Film size={14} />;
}

function isHlsFilter(value: unknown): value is HlsFilter {
  return typeof value === "string" && hlsFilters.includes(value as HlsFilter);
}

function isLibrarySortMode(value: unknown): value is LibrarySortMode {
  return typeof value === "string" && librarySortModes.includes(value as LibrarySortMode);
}

function isPageSize(value: unknown): value is number {
  return typeof value === "number" && pageSizeOptions.includes(value);
}

function statusText(status: LocalHlsJob["status"]) {
  return {
    queued: "排队",
    running: "生成中",
    completed: "完成",
    failed: "失败"
  }[status];
}

function hlsStatusIcon(status: LocalHlsJob["status"]) {
  if (status === "completed") return <CheckCircle2 size={14} />;
  if (status === "failed") return <XCircle size={14} />;
  return <RadioTower size={14} />;
}
