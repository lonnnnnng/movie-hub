import {
  Check,
  Copy,
  Database,
  FileVideo,
  FolderInput,
  HardDrive,
  Loader2,
  PlaySquare,
  RadioTower,
  RefreshCw,
  Save,
  Search,
  Server,
  ShieldCheck,
  Wifi,
  X
} from "lucide-react";
import { FormEvent, useEffect, useMemo, useState, type ReactNode } from "react";
import { getShareSummary } from "../lib/api";
import { fileSize, formatTime, mediaProbeSummary } from "../lib/format";
import { useStoredState } from "../lib/storage";
import type { AppSettings, LocalVideo, ShareProtocolInfo, ShareSummary, Toast } from "../types";

type SharePageProps = {
  settings: AppSettings;
  onBuildHls: (video: LocalVideo) => void | Promise<void>;
  onNotify: (message: string, tone?: Toast["tone"]) => void;
  onSaveSettings: (settings: Partial<AppSettings>) => void | Promise<void>;
};

type ShareTab = ShareProtocolInfo["id"];
type ShareMediaFilter = "all" | "hls-ready" | "hls-missing";

const protocolOrder: ShareTab[] = ["hls", "webdav", "smb", "ftp"];
const sharePageSizeOptions = [10, 20, 50, 100];
const shareMediaFilters = ["all", "hls-ready", "hls-missing"] satisfies ShareMediaFilter[];

export function SharePage({ settings, onBuildHls, onNotify, onSaveSettings }: SharePageProps) {
  const [summary, setSummary] = useState<ShareSummary | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [saving, setSaving] = useState(false);
  const [buildingId, setBuildingId] = useState<string | null>(null);
  const [copied, setCopied] = useState<string | null>(null);
  const [activeProtocol, setActiveProtocol] = useStoredState<ShareTab>("movie-hub.share.activeProtocol", "hls", { validate: isShareTab });
  const [draft, setDraft] = useState({
    shareSmbUrl: settings.shareSmbUrl ?? "",
    shareFtpUrl: settings.shareFtpUrl ?? ""
  });

  useEffect(() => {
    setDraft({
      shareSmbUrl: settings.shareSmbUrl ?? "",
      shareFtpUrl: settings.shareFtpUrl ?? ""
    });
  }, [settings.shareFtpUrl, settings.shareSmbUrl]);

  useEffect(() => {
    void refreshSummary(true);
  }, []);

  const videos = summary?.videos ?? [];
  const directReady = videos.length;
  const hlsReady = summary?.hlsReady ?? 0;
  const hlsRatio = directReady ? Math.round((hlsReady / directReady) * 100) : 0;
  const activeProtocols = useMemo(
    () => summary?.protocols.filter((protocol) => protocol.status !== "disabled").length ?? 0,
    [summary?.protocols]
  );
  const protocols = useMemo(
    () =>
      protocolOrder
        .map((id) => summary?.protocols.find((protocol) => protocol.id === id))
        .filter((protocol): protocol is ShareProtocolInfo => Boolean(protocol)),
    [summary?.protocols]
  );
  const selectedProtocol = protocols.find((protocol) => protocol.id === activeProtocol) ?? protocols[0];

  useEffect(() => {
    if (protocols.length && !protocols.some((protocol) => protocol.id === activeProtocol)) {
      setActiveProtocol(protocols[0].id);
    }
  }, [activeProtocol, protocols]);

  async function refreshSummary(initial = false) {
    if (initial) setLoading(true);
    else setRefreshing(true);
    try {
      setSummary(await getShareSummary());
    } catch (error) {
      onNotify(error instanceof Error ? error.message : "共享状态加载失败", "bad");
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }

  async function copyValue(value: string, label = "地址") {
    try {
      await writeClipboard(value);
      setCopied(value);
      window.setTimeout(() => setCopied(null), 1600);
      onNotify(`${label}已复制`);
    } catch {
      onNotify("复制失败，请手动选中地址复制", "warn");
    }
  }

  async function submit(event: FormEvent) {
    event.preventDefault();
    setSaving(true);
    try {
      await onSaveSettings({
        shareSmbUrl: draft.shareSmbUrl.trim(),
        shareFtpUrl: draft.shareFtpUrl.trim()
      });
      await refreshSummary();
    } catch (error) {
      onNotify(error instanceof Error ? error.message : "共享地址保存失败", "bad");
    } finally {
      setSaving(false);
    }
  }

  async function buildHls(video: LocalVideo) {
    setBuildingId(video.id);
    try {
      await onBuildHls(video);
      await refreshSummary();
    } finally {
      setBuildingId(null);
    }
  }

  return (
    <section className="page-stack share-page">
      <div className="share-summary">
        <ShareStat label="本地视频" value={directReady} icon={<FileVideo size={20} />} />
        <ShareStat label="HLS 就绪" value={`${hlsReady}/${directReady}`} meta={`${hlsRatio}%`} icon={<RadioTower size={20} />} tone="good" />
        <ShareStat label="共享协议" value={activeProtocols} icon={<Wifi size={20} />} tone="gold" />
        <ShareStat label="媒体体积" value={fileSize(summary?.totalSize ?? 0)} icon={<HardDrive size={20} />} />
      </div>

      {loading || !selectedProtocol ? (
        <section className="panel">
          <div className="empty-small">
            <Loader2 className="spin" size={24} />
            <span>正在读取共享状态</span>
          </div>
        </section>
      ) : (
        <section className="share-tab-shell">
          <div className="tab-strip share-tab-strip" role="tablist" aria-label="共享协议类型">
            {protocols.map((protocol) => (
              <button
                key={protocol.id}
                className={`tab-button ${activeProtocol === protocol.id ? "active" : ""}`}
                type="button"
                role="tab"
                aria-selected={activeProtocol === protocol.id}
                onClick={() => setActiveProtocol(protocol.id)}
              >
                <span className="tab-button-icon">{protocolIcon(protocol.id)}</span>
                <span>
                  <strong>{shortProtocolLabel(protocol.id)}</strong>
                  <small>
                    {statusText(protocol.status)} · {protocol.urls.length || 0} 地址
                  </small>
                </span>
              </button>
            ))}
          </div>

          <div className="share-tab-content" role="tabpanel">
            <div className="share-protocol-detail-grid">
              <ProtocolCard protocol={selectedProtocol} copied={copied} onCopy={copyValue} featured />
              {selectedProtocol.id === "smb" || selectedProtocol.id === "ftp" ? (
                <ExternalAddressCard
                  protocol={selectedProtocol}
                  draft={draft}
                  saving={saving}
                  onChange={setDraft}
                  onSubmit={submit}
                />
              ) : (
                <ProtocolOverview protocol={selectedProtocol} summary={summary} videoCount={videos.length} />
              )}
            </div>

            <section className="panel share-library-panel">
              <div className="panel-title">
                <div>
                  <p className="eyebrow">Local Videos</p>
                  <h3>{shortProtocolLabel(selectedProtocol.id)} 视频索引</h3>
                </div>
                <div className="panel-title-actions">
                  <span className="share-refresh-time">更新于 {formatTime(summary?.generatedAt)}</span>
                  <button className="tool-button subtle" type="button" onClick={() => void refreshSummary()} disabled={refreshing}>
                    {refreshing ? <Loader2 className="spin" size={16} /> : <RefreshCw size={16} />}
                    刷新
                  </button>
                </div>
              </div>

              <ShareProtocolMediaList
                key={selectedProtocol.id}
                protocol={selectedProtocol}
                summary={summary}
                videos={videos}
                buildingId={buildingId}
                copied={copied}
                onBuildHls={buildHls}
                onCopy={copyValue}
              />
            </section>
          </div>
        </section>
      )}
    </section>
  );
}

function ShareStat({
  label,
  value,
  meta,
  icon,
  tone
}: {
  label: string;
  value: string | number;
  meta?: string;
  icon: ReactNode;
  tone?: "good" | "gold";
}) {
  return (
    <article className={`share-stat ${tone ?? ""}`}>
      <div>
        {icon}
        <span>{label}</span>
      </div>
      <strong>{value}</strong>
      {meta && <small>{meta}</small>}
    </article>
  );
}

function ProtocolCard({
  protocol,
  copied,
  onCopy,
  featured = false
}: {
  protocol: ShareProtocolInfo;
  copied: string | null;
  onCopy: (value: string, label?: string) => void | Promise<void>;
  featured?: boolean;
}) {
  return (
    <article className={`share-protocol-card ${protocol.status} ${featured ? "featured" : ""}`}>
      <div className="share-protocol-head">
        <span className="share-protocol-icon">{protocolIcon(protocol.id)}</span>
        <div>
          <strong>{protocol.label}</strong>
          <small>{statusText(protocol.status)}</small>
        </div>
      </div>
      <p>{protocol.description}</p>
      {protocol.rootPath && <span className="share-root">{protocol.rootPath}</span>}

      <div className="share-url-list">
        {protocol.urls.length ? (
          protocol.urls.map((url) => (
            <button type="button" key={url} onClick={() => void onCopy(url, protocol.label)}>
              <span>{url}</span>
              {copied === url ? <Check size={15} /> : <Copy size={15} />}
            </button>
          ))
        ) : (
          <span className="share-empty-url">暂未配置地址</span>
        )}
      </div>
      {protocol.note && <em>{protocol.note}</em>}
    </article>
  );
}

function ExternalAddressCard({
  protocol,
  draft,
  saving,
  onChange,
  onSubmit
}: {
  protocol: ShareProtocolInfo;
  draft: { shareSmbUrl: string; shareFtpUrl: string };
  saving: boolean;
  onChange: (draft: { shareSmbUrl: string; shareFtpUrl: string }) => void;
  onSubmit: (event: FormEvent) => void;
}) {
  const firstField = protocol.id === "ftp" ? "shareFtpUrl" : "shareSmbUrl";
  const secondField = protocol.id === "ftp" ? "shareSmbUrl" : "shareFtpUrl";

  return (
    <section className="panel share-settings-card">
      <div className="panel-title">
        <div>
          <p className="eyebrow">External</p>
          <h3>{protocol.id === "ftp" ? "FTP 地址" : "SMB 地址"}</h3>
        </div>
        <Server size={20} />
      </div>

      <form className="share-settings-form" onSubmit={onSubmit}>
        <ShareAddressField field={firstField} draft={draft} onChange={onChange} />
        <ShareAddressField field={secondField} draft={draft} onChange={onChange} />
        <p className="share-help">外部共享由 NAS 或系统服务提供，保存后会进入对应协议页展示。</p>
        <button className="tool-button" type="submit" disabled={saving}>
          {saving ? <Loader2 className="spin" size={16} /> : <Save size={16} />}
          保存地址
        </button>
      </form>
    </section>
  );
}

function ShareAddressField({
  field,
  draft,
  onChange
}: {
  field: "shareSmbUrl" | "shareFtpUrl";
  draft: { shareSmbUrl: string; shareFtpUrl: string };
  onChange: (draft: { shareSmbUrl: string; shareFtpUrl: string }) => void;
}) {
  const isSmb = field === "shareSmbUrl";
  return (
    <label>
      <span>{isSmb ? "SMB 地址" : "FTP 地址"}</span>
      <input
        value={draft[field]}
        onChange={(event) => onChange({ ...draft, [field]: event.target.value })}
        placeholder={isSmb ? "smb://192.168.1.10/Media" : "ftp://192.168.1.10/media"}
      />
    </label>
  );
}

function ProtocolOverview({ protocol, summary, videoCount }: { protocol: ShareProtocolInfo; summary: ShareSummary | null; videoCount: number }) {
  return (
    <section className="panel share-protocol-guide">
      <div className="panel-title">
        <div>
          <p className="eyebrow">Scope</p>
          <h3>共享范围</h3>
        </div>
        <ShieldCheck size={20} />
      </div>
      <div className="share-paths">
        <span>
          <Database size={14} />
          media: {summary?.mediaDir ?? "--"}
        </span>
        <span>
          <FolderInput size={14} />
          hls: {summary?.hlsDir ?? "--"}
        </span>
      </div>
      <div className="share-protocol-facts">
        <InfoTile label="视频" value={videoCount} />
        <InfoTile label="地址" value={protocol.urls.length} />
        <InfoTile label="状态" value={statusText(protocol.status)} />
      </div>
    </section>
  );
}

function InfoTile({ label, value }: { label: string; value: string | number }) {
  return (
    <div className="share-info-tile">
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  );
}

function ShareProtocolMediaList({
  protocol,
  summary,
  videos,
  buildingId,
  copied,
  onBuildHls,
  onCopy
}: {
  protocol: ShareProtocolInfo;
  summary: ShareSummary | null;
  videos: LocalVideo[];
  buildingId: string | null;
  copied: string | null;
  onBuildHls: (video: LocalVideo) => void | Promise<void>;
  onCopy: (value: string, label?: string) => void | Promise<void>;
}) {
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useStoredState<ShareMediaFilter>(`movie-hub.share.${protocol.id}.mediaFilter`, "all", { validate: isShareMediaFilter });
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useStoredState<number>(`movie-hub.share.${protocol.id}.pageSize`, 20, { validate: isSharePageSize });
  const [bulkBuilding, setBulkBuilding] = useState(false);
  const normalizedQuery = query.trim().toLowerCase();
  const filteredVideos = useMemo(() => {
    return videos.filter((video) => {
      if (filter === "hls-ready" && !video.hlsUrl) return false;
      if (filter === "hls-missing" && video.hlsUrl) return false;
      if (!normalizedQuery) return true;
      return [video.title, video.episodeName, video.fileName, video.path, mediaProbeSummary(video.probe)].some((value) =>
        value?.toLowerCase().includes(normalizedQuery)
      );
    });
  }, [filter, normalizedQuery, videos]);
  const pageCount = Math.max(1, Math.ceil(filteredVideos.length / pageSize));
  const currentPage = Math.min(page, pageCount);
  const pageStart = (currentPage - 1) * pageSize;
  const pageEnd = Math.min(pageStart + pageSize, filteredVideos.length);
  const pageVideos = useMemo(() => filteredVideos.slice(pageStart, pageEnd), [filteredVideos, pageEnd, pageStart]);
  const hlsReady = videos.filter((video) => video.hlsUrl).length;
  const pendingFilteredHlsVideos = filteredVideos.filter((video) => !video.hlsUrl);
  const mediaFilters = [
    { value: "all" as const, label: "全部", count: videos.length },
    { value: "hls-ready" as const, label: "HLS 就绪", count: hlsReady },
    { value: "hls-missing" as const, label: "待生成", count: videos.length - hlsReady }
  ];

  useEffect(() => {
    setPage(1);
  }, [filter, normalizedQuery, pageSize, protocol.id]);

  useEffect(() => {
    if (page > pageCount) setPage(pageCount);
  }, [page, pageCount]);

  function submitSearch(event: FormEvent) {
    event.preventDefault();
    setPage(1);
  }

  async function buildFilteredHls() {
    if (bulkBuilding || protocol.id !== "hls" || !pendingFilteredHlsVideos.length) return;
    setBulkBuilding(true);
    try {
      for (const video of pendingFilteredHlsVideos) {
        await onBuildHls(video);
      }
    } finally {
      setBulkBuilding(false);
    }
  }

  if (!videos.length) {
    return (
      <div className="empty-wall">
        <HardDrive size={34} />
        <p>media 目录里还没有可共享的视频文件</p>
      </div>
    );
  }

  return (
    <>
      <form className="share-media-toolbar" onSubmit={submitSearch}>
        <label className="share-media-search">
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
        {protocol.id === "hls" ? (
          <button
            className="tool-button subtle"
            type="button"
            onClick={() => void buildFilteredHls()}
            disabled={!pendingFilteredHlsVideos.length || bulkBuilding}
          >
            {bulkBuilding ? <Loader2 className="spin" size={16} /> : <RadioTower size={16} />}
            {bulkBuilding ? "生成中" : "批量生成"}
          </button>
        ) : null}
      </form>

      <div className="share-media-filter-tabs" aria-label="共享视频筛选">
        {mediaFilters.map((item) => (
          <button className={filter === item.value ? "active" : ""} key={item.value} type="button" onClick={() => setFilter(item.value)}>
            {item.value === "hls-ready" ? <RadioTower size={14} /> : item.value === "hls-missing" ? <Loader2 size={14} /> : <FileVideo size={14} />}
            <span>{item.label}</span>
            <b>{item.count}</b>
          </button>
        ))}
      </div>

      {filteredVideos.length ? (
        <>
          <div className="share-video-list">
            {pageVideos.map((video) => (
              <VideoShareRow
                key={video.id}
                protocol={protocol}
                summary={summary}
                video={video}
                building={buildingId === video.id}
                copied={copied}
                onBuildHls={() => void onBuildHls(video)}
                onCopy={onCopy}
              />
            ))}
          </div>
          <div className="share-media-pagination" aria-label="共享视频分页">
            <span>
              第 {currentPage} / {pageCount} 页 · 显示 {pageStart + 1}-{pageEnd} / {filteredVideos.length}
            </span>
            <label>
              每页
              <select value={pageSize} onChange={(event) => setPageSize(Number(event.target.value))}>
                {sharePageSizeOptions.map((size) => (
                  <option key={size} value={size}>
                    {size}
                  </option>
                ))}
              </select>
            </label>
            <div className="share-media-page-buttons">
              <button type="button" onClick={() => setPage((value) => Math.max(1, value - 1))} disabled={currentPage <= 1} title="上一页">
                上一页
              </button>
              <button type="button" onClick={() => setPage((value) => Math.min(pageCount, value + 1))} disabled={currentPage >= pageCount} title="下一页">
                下一页
              </button>
            </div>
          </div>
        </>
      ) : (
        <div className="empty-wall">
          <Search size={34} />
          <p>没有匹配的共享视频</p>
        </div>
      )}
    </>
  );
}

function VideoShareRow({
  protocol,
  summary,
  video,
  building,
  copied,
  onBuildHls,
  onCopy
}: {
  protocol: ShareProtocolInfo;
  summary: ShareSummary | null;
  video: LocalVideo;
  building: boolean;
  copied: string | null;
  onBuildHls: () => void;
  onCopy: (value: string, label?: string) => void | Promise<void>;
}) {
  const url = protocolVideoUrl(protocol, video, summary?.mediaDir);
  const canBuildHls = protocol.id === "hls" && !video.hlsUrl;
  const actionText = protocolActionText(protocol.id);
  const location = protocol.id === "hls" ? (video.hlsUrl ? "m3u8 已生成" : "等待生成 HLS") : relativeVideoPath(video, summary?.mediaDir);

  return (
    <article className="share-video-row">
      <div className="share-video-icon">
        <PlaySquare size={24} />
      </div>
      <div className="share-video-copy">
        <strong>{video.title}</strong>
        <span>
          {video.episodeName ?? video.fileName}
          {video.probe ? ` | ${mediaProbeSummary(video.probe)}` : ""}
        </span>
        <small>
          {location} · {fileSize(video.size)} · {formatTime(video.modifiedAt)}
        </small>
      </div>
      <div className="share-copy-row compact">
        {canBuildHls ? (
          <button type="button" onClick={onBuildHls} disabled={building}>
            {building ? <Loader2 className="spin" size={15} /> : <RadioTower size={15} />}
            <span>生成 HLS</span>
          </button>
        ) : (
          <button type="button" onClick={() => url && void onCopy(url, `${shortProtocolLabel(protocol.id)} 地址`)} disabled={!url}>
            <span>{actionText}</span>
            {url && copied === url ? <Check size={15} /> : <Copy size={15} />}
          </button>
        )}
      </div>
    </article>
  );
}

function protocolIcon(id: ShareProtocolInfo["id"]) {
  return {
    hls: <RadioTower size={19} />,
    webdav: <Database size={19} />,
    smb: <Server size={19} />,
    ftp: <FolderInput size={19} />
  }[id];
}

function statusText(status: ShareProtocolInfo["status"]) {
  return {
    active: "内置可用",
    external: "外部入口",
    disabled: "未配置"
  }[status];
}

function shortProtocolLabel(id: ShareTab) {
  return {
    hls: "HLS",
    webdav: "WebDAV",
    smb: "SMB",
    ftp: "FTP"
  }[id];
}

function protocolActionText(id: ShareTab) {
  return {
    hls: "复制 HLS",
    webdav: "复制 WebDAV",
    smb: "复制 SMB",
    ftp: "复制 FTP"
  }[id];
}

function protocolVideoUrl(protocol: ShareProtocolInfo, video: LocalVideo, mediaDir?: string) {
  if (protocol.id === "hls") return video.hlsUrl;
  const root = protocol.urls[0];
  if (!root) return undefined;
  const relative = relativeVideoPath(video, mediaDir);
  if (protocol.id === "smb" && !/^smb:\/\//i.test(root)) {
    return `${root.replace(/[\\/]+$/, "")}\\${relative.replace(/\//g, "\\")}`;
  }
  return `${root.replace(/\/+$/, "")}/${encodeRelativePath(relative)}`;
}

function relativeVideoPath(video: LocalVideo, mediaDir?: string) {
  const normalizedPath = normalizeFsPath(video.path);
  const normalizedRoot = normalizeFsPath(mediaDir ?? "");
  if (normalizedRoot && normalizedPath.startsWith(`${normalizedRoot}/`)) {
    return normalizedPath.slice(normalizedRoot.length + 1);
  }
  return video.fileName;
}

function normalizeFsPath(value: string) {
  return value.replace(/\\/g, "/").replace(/\/+$/, "");
}

function encodeRelativePath(value: string) {
  return value
    .split("/")
    .filter(Boolean)
    .map((part) => encodeURIComponent(part))
    .join("/");
}

function isShareTab(value: unknown): value is ShareTab {
  return typeof value === "string" && protocolOrder.includes(value as ShareTab);
}

function isShareMediaFilter(value: unknown): value is ShareMediaFilter {
  return typeof value === "string" && shareMediaFilters.includes(value as ShareMediaFilter);
}

function isSharePageSize(value: unknown): value is number {
  return typeof value === "number" && sharePageSizeOptions.includes(value);
}

async function writeClipboard(value: string) {
  if (navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(value);
    return;
  }

  const textarea = document.createElement("textarea");
  textarea.value = value;
  textarea.style.position = "fixed";
  textarea.style.opacity = "0";
  document.body.appendChild(textarea);
  textarea.select();
  try {
    document.execCommand("copy");
  } finally {
    textarea.remove();
  }
}
