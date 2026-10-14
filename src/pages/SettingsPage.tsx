import { Activity, Archive, CheckCircle2, ClipboardPaste, Clock3, Copy, Cpu, Database, Download, HardDrive, Loader2, PlayCircle, RefreshCw, Save, Search, Settings2, TerminalSquare, Trash2, Wrench, X } from "lucide-react";
import { FormEvent, useEffect, useMemo, useState, type ReactNode } from "react";
import { ServerCard, StatDeck } from "../components/Panels";
import { downloadStateBackup, getRuntimeStatus, getToolsStatus, restoreStateBackup, syncEmby } from "../lib/api";
import { fileSize, formatTime } from "../lib/format";
import {
  MAX_PLAYBACK_PROGRESS_ENTRIES,
  clearAllPlaybackProgress,
  clearPlaybackProgressEntry,
  formatDuration,
  getPlaybackProgressSummary,
  type PlaybackProgressEntry
} from "../lib/playerProgress";
import { clearStoredPreferences, createStoredPreferenceExport, getStoredPreferenceSummary, importStoredPreferences, useStoredState } from "../lib/storage";
import type { AppSettings, AppState, HubStats, RuntimeDiagnosticCheck, RuntimeStatusResponse, ToolStatus, ToolsStatusResponse } from "../types";

type SettingsPageProps = {
  state: AppState;
  stats: HubStats | null;
  initialToolStatus?: ToolsStatusResponse | null;
  onSaveSettings: (settings: Partial<AppSettings>) => void | Promise<void>;
  onToolStatusChange?: (status: ToolsStatusResponse) => void;
  onStateRestored?: (state: AppState) => void;
  onNotify: (message: string, tone?: "good" | "warn" | "bad") => void;
};

type SettingsTab = "system" | "app" | "tools";
type RuntimeLogFilter = "all" | "error" | "api" | "download" | "source" | "tool";
const settingsTabs = ["system", "app", "tools"] satisfies SettingsTab[];
const runtimeLogFilterValues = ["all", "error", "api", "download", "source", "tool"] satisfies RuntimeLogFilter[];
const runtimeLogLineOptions = [80, 160, 300, 500];
type BackupPreview = {
  filename: string;
  exportedAt?: string;
  version?: string;
  payload?: unknown;
  valid: boolean;
  message: string;
  corruptFields: { path: string; value: string }[];
  summary: {
    sites: number;
    enabledSites: number;
    watchlist: number;
    downloads: number;
    hlsJobs: number;
    notifications: number;
    library: number;
  };
};

function settingsDraft(settings: AppSettings) {
  return {
    sourceHealthCheckIntervalMinutes: settings.sourceHealthCheckIntervalMinutes,
    watchlistCheckIntervalMinutes: settings.watchlistCheckIntervalMinutes,
    ffmpegPath: settings.ffmpegPath ?? "",
    ffmpegHlsSegmentSeconds: settings.ffmpegHlsSegmentSeconds,
    ffmpegReconnectDelaySeconds: settings.ffmpegReconnectDelaySeconds,
    ffmpegDownloadInputArgs: settings.ffmpegDownloadInputArgs ?? "",
    ffmpegDownloadOutputArgs: settings.ffmpegDownloadOutputArgs ?? "",
    ffmpegHlsInputArgs: settings.ffmpegHlsInputArgs ?? "",
    ffmpegHlsOutputArgs: settings.ffmpegHlsOutputArgs ?? "",
    m3u8DownloaderPath: settings.m3u8DownloaderPath ?? "",
    m3u8DownloaderThreads: settings.m3u8DownloaderThreads,
    m3u8DownloaderRetryCount: settings.m3u8DownloaderRetryCount,
    m3u8DownloaderTimeoutSeconds: settings.m3u8DownloaderTimeoutSeconds,
    m3u8DownloaderHeaders: settings.m3u8DownloaderHeaders ?? "",
    m3u8DownloaderProxy: settings.m3u8DownloaderProxy ?? "",
    m3u8DownloaderMaxSpeed: settings.m3u8DownloaderMaxSpeed ?? "",
    m3u8DownloaderMuxAfterDone: settings.m3u8DownloaderMuxAfterDone ?? "",
    m3u8DownloaderExtraArgs: settings.m3u8DownloaderExtraArgs ?? "",
    shareSmbUrl: settings.shareSmbUrl ?? "",
    shareFtpUrl: settings.shareFtpUrl ?? "",
    embyEnabled: settings.embyEnabled,
    embyOutputDir: settings.embyOutputDir,
    embyBaseUrl: settings.embyBaseUrl,
    embyServerUrl: settings.embyServerUrl,
    embyApiKey: settings.embyApiKey,
    embySyncOnDownload: settings.embySyncOnDownload
  };
}

export function SettingsPage({ state, stats, initialToolStatus, onSaveSettings, onToolStatusChange, onStateRestored, onNotify }: SettingsPageProps) {
  const [draft, setDraft] = useState(() => settingsDraft(state.settings));
  const [activeTab, setActiveTab] = useStoredState<SettingsTab>("movie-hub.settings.activeTab", "system", { validate: isSettingsTab });
  const [toolStatus, setToolStatus] = useState<ToolsStatusResponse | null>(initialToolStatus ?? null);
  const [runtimeStatus, setRuntimeStatus] = useState<RuntimeStatusResponse | null>(null);
  const [checkingTools, setCheckingTools] = useState(true);
  const [checkingRuntime, setCheckingRuntime] = useState(true);
  const [exportingBackup, setExportingBackup] = useState(false);
  const [restoringBackup, setRestoringBackup] = useState(false);
  const [backupPreview, setBackupPreview] = useState<BackupPreview | null>(null);
  const [restoreConfirmOpen, setRestoreConfirmOpen] = useState(false);
  const [runtimeLogQuery, setRuntimeLogQuery] = useState("");
  const [runtimeLogFilter, setRuntimeLogFilter] = useStoredState<RuntimeLogFilter>("movie-hub.settings.runtimeLogFilter", "all", {
    validate: isRuntimeLogFilter
  });
  const [runtimeLogLines, setRuntimeLogLines] = useStoredState<number>("movie-hub.settings.runtimeLogLines", 160, { validate: isRuntimeLogLines });
  const [preferenceImportOpen, setPreferenceImportOpen] = useState(false);
  const [preferenceImportText, setPreferenceImportText] = useState("");
  const [playbackProgressSummary, setPlaybackProgressSummary] = useState(() => getPlaybackProgressSummary());
  const [preferenceSummary, setPreferenceSummary] = useState(() => getStoredPreferenceSummary());
  const [saving, setSaving] = useState(false);
  const runtimeLogItems = useMemo(() => runtimeStatus?.logs.lines.map((line, index) => ({ line, index })) ?? [], [runtimeStatus]);
  const runtimeLogFiltered = useMemo(() => {
    const query = runtimeLogQuery.trim().toLocaleLowerCase("zh-CN");
    return runtimeLogItems.filter((item) => {
      const normalized = item.line.toLocaleLowerCase("zh-CN");
      if (runtimeLogFilter !== "all" && !runtimeLogMatchesFilter(normalized, runtimeLogFilter)) return false;
      return !query || normalized.includes(query);
    });
  }, [runtimeLogFilter, runtimeLogItems, runtimeLogQuery]);
  const runtimeLogFilters = [
    { key: "all" as const, label: "全部", count: runtimeLogItems.length },
    { key: "error" as const, label: "错误", count: runtimeLogItems.filter((item) => runtimeLogMatchesFilter(item.line.toLocaleLowerCase("zh-CN"), "error")).length },
    { key: "api" as const, label: "API", count: runtimeLogItems.filter((item) => runtimeLogMatchesFilter(item.line.toLocaleLowerCase("zh-CN"), "api")).length },
    { key: "download" as const, label: "下载", count: runtimeLogItems.filter((item) => runtimeLogMatchesFilter(item.line.toLocaleLowerCase("zh-CN"), "download")).length },
    { key: "source" as const, label: "资源站", count: runtimeLogItems.filter((item) => runtimeLogMatchesFilter(item.line.toLocaleLowerCase("zh-CN"), "source")).length },
    { key: "tool" as const, label: "工具", count: runtimeLogItems.filter((item) => runtimeLogMatchesFilter(item.line.toLocaleLowerCase("zh-CN"), "tool")).length }
  ];

  useEffect(() => {
    setDraft(settingsDraft(state.settings));
  }, [state.settings]);

  useEffect(() => {
    void refreshTools();
  }, []);

  useEffect(() => {
    void refreshRuntime();
  }, [runtimeLogLines]);

  useEffect(() => {
    if (initialToolStatus) setToolStatus(initialToolStatus);
  }, [initialToolStatus]);

  useEffect(() => {
    setPlaybackProgressSummary(getPlaybackProgressSummary());
    setPreferenceSummary(getStoredPreferenceSummary());
  }, [activeTab]);

  async function refreshTools() {
    setCheckingTools(true);
    try {
      const next = await getToolsStatus();
      setToolStatus(next);
      onToolStatusChange?.(next);
    } finally {
      setCheckingTools(false);
    }
  }

  async function refreshRuntime() {
    setCheckingRuntime(true);
    try {
      setRuntimeStatus(await getRuntimeStatus(runtimeLogLines));
    } finally {
      setCheckingRuntime(false);
    }
  }

  async function copyRuntimeLogs() {
    const lines = runtimeLogFiltered.map((item) => item.line);
    if (!lines.length) {
      onNotify("暂无可复制的运行日志", "warn");
      return;
    }
    try {
      await navigator.clipboard.writeText(lines.join("\n"));
      onNotify("运行日志已复制");
    } catch {
      onNotify("复制失败，请手动选中日志内容", "bad");
    }
  }

  async function exportStateBackup() {
    setExportingBackup(true);
    try {
      const result = await downloadStateBackup();
      onNotify(`备份已导出：${result.filename}`);
    } catch (error) {
      onNotify(error instanceof Error ? error.message : "备份导出失败", "bad");
    } finally {
      setExportingBackup(false);
    }
  }

  async function previewBackupFile(file?: File) {
    if (!file) return;
    try {
      const parsed = JSON.parse(await file.text()) as unknown;
      const payload = parseBackupPayload(parsed, file.name);
      setBackupPreview({ ...payload, payload: parsed });
      onNotify(payload.valid ? "备份文件预检完成" : payload.message, payload.valid ? "good" : "warn");
    } catch (error) {
      setBackupPreview({
        filename: file.name,
        valid: false,
        message: error instanceof Error ? error.message : "备份文件无法解析",
        corruptFields: [],
        summary: {
          sites: 0,
          enabledSites: 0,
          watchlist: 0,
          downloads: 0,
          hlsJobs: 0,
          notifications: 0,
          library: 0
        }
      });
      onNotify("备份文件无法解析", "bad");
    }
  }

  async function restoreBackup() {
    if (!backupPreview?.valid || !backupPreview.payload) {
      onNotify("请先选择有效的备份文件", "warn");
      return;
    }
    setRestoringBackup(true);
    try {
      const result = await restoreStateBackup(backupPreview.payload);
      onStateRestored?.(result.state);
      setBackupPreview(null);
      setRestoreConfirmOpen(false);
      await refreshRuntime();
      await refreshTools();
      onNotify(`备份已恢复：${result.summary.sites} 个资源站，${result.summary.watchlist} 条追剧`);
    } catch (error) {
      onNotify(error instanceof Error ? error.message : "备份恢复失败", "bad");
    } finally {
      setRestoringBackup(false);
    }
  }

  async function submit(event: FormEvent) {
    event.preventDefault();
    setSaving(true);
    try {
      await onSaveSettings({
        sourceHealthCheckIntervalMinutes: clampInt(draft.sourceHealthCheckIntervalMinutes, 1, 1440, 30),
        watchlistCheckIntervalMinutes: clampInt(draft.watchlistCheckIntervalMinutes, 1, 1440, 30),
        ffmpegPath: draft.ffmpegPath.trim(),
        ffmpegHlsSegmentSeconds: clampInt(draft.ffmpegHlsSegmentSeconds, 2, 30, 6),
        ffmpegReconnectDelaySeconds: clampInt(draft.ffmpegReconnectDelaySeconds, 1, 60, 5),
        ffmpegDownloadInputArgs: draft.ffmpegDownloadInputArgs.trim(),
        ffmpegDownloadOutputArgs: draft.ffmpegDownloadOutputArgs.trim(),
        ffmpegHlsInputArgs: draft.ffmpegHlsInputArgs.trim(),
        ffmpegHlsOutputArgs: draft.ffmpegHlsOutputArgs.trim(),
        m3u8DownloaderPath: draft.m3u8DownloaderPath.trim(),
        m3u8DownloaderThreads: clampInt(draft.m3u8DownloaderThreads, 1, 64, 16),
        m3u8DownloaderRetryCount: clampInt(draft.m3u8DownloaderRetryCount, 1, 20, 6),
        m3u8DownloaderTimeoutSeconds: clampInt(draft.m3u8DownloaderTimeoutSeconds, 5, 120, 30),
        m3u8DownloaderHeaders: draft.m3u8DownloaderHeaders.trim(),
        m3u8DownloaderProxy: draft.m3u8DownloaderProxy.trim(),
        m3u8DownloaderMaxSpeed: draft.m3u8DownloaderMaxSpeed.trim(),
        m3u8DownloaderMuxAfterDone: draft.m3u8DownloaderMuxAfterDone.trim(),
        m3u8DownloaderExtraArgs: draft.m3u8DownloaderExtraArgs.trim(),
        shareSmbUrl: draft.shareSmbUrl.trim(),
        shareFtpUrl: draft.shareFtpUrl.trim(),
        embyEnabled: draft.embyEnabled,
        embyOutputDir: draft.embyOutputDir.trim(),
        embyBaseUrl: draft.embyBaseUrl.trim(),
        embyServerUrl: draft.embyServerUrl.trim(),
        embyApiKey: draft.embyApiKey.trim(),
        embySyncOnDownload: draft.embySyncOnDownload
      });
      await refreshTools();
    } finally {
      setSaving(false);
    }
  }

  async function runEmbySync() {
    try {
      const result = await syncEmby();
      onNotify(result.message ?? `Emby 已同步 ${result.synced} 个文件${result.failed ? `，失败 ${result.failed} 个` : ""}`, result.failed ? "warn" : "good");
    } catch (error) {
      onNotify(error instanceof Error ? error.message : "Emby 同步失败", "bad");
    }
  }

  function clearPlaybackMemory() {
    const removed = clearAllPlaybackProgress();
    setPlaybackProgressSummary(getPlaybackProgressSummary());
    onNotify(removed ? `已清理 ${removed} 条播放进度` : "暂无可清理的播放进度", removed ? "good" : "warn");
  }

  function clearPlaybackMemoryEntry(entry: PlaybackProgressEntry) {
    const removed = clearPlaybackProgressEntry(entry.key);
    setPlaybackProgressSummary(getPlaybackProgressSummary());
    onNotify(removed ? `已删除播放进度：${entry.title || "未命名视频"}` : "播放进度删除失败", removed ? "good" : "bad");
  }

  function clearLocalPreferences() {
    const removed = clearStoredPreferences();
    setPreferenceSummary(getStoredPreferenceSummary());
    onNotify(removed ? `已重置 ${removed} 项本地偏好，刷新后生效` : "暂无可重置的本地偏好", removed ? "good" : "warn");
  }

  async function copyLocalPreferences() {
    if (!preferenceSummary.count) {
      onNotify("暂无可复制的本地偏好", "warn");
      return;
    }
    try {
      await navigator.clipboard.writeText(JSON.stringify(createStoredPreferenceExport(), null, 2));
      onNotify(`本地偏好已复制：${preferenceSummary.count} 项`);
    } catch {
      onNotify("复制失败，请检查浏览器剪贴板权限", "bad");
    }
  }

  function downloadLocalPreferences() {
    if (!preferenceSummary.count) {
      onNotify("暂无可导出的本地偏好", "warn");
      return;
    }
    const blob = new Blob([JSON.stringify(createStoredPreferenceExport(), null, 2)], { type: "application/json;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = `movie-hub-preferences-${new Date().toISOString().replace(/[:.]/g, "-")}.json`;
    document.body.append(anchor);
    anchor.click();
    anchor.remove();
    URL.revokeObjectURL(url);
    onNotify(`本地偏好已导出：${preferenceSummary.count} 项`);
  }

  function importLocalPreferences() {
    try {
      const result = importStoredPreferences(JSON.parse(preferenceImportText));
      setPreferenceSummary(getStoredPreferenceSummary());
      if (result.imported) {
        setPreferenceImportOpen(false);
        setPreferenceImportText("");
        onNotify(`已导入 ${result.imported} 项本地偏好，刷新页面后生效${result.skipped ? `，跳过 ${result.skipped} 项` : ""}`);
        return;
      }
      onNotify(result.total ? "没有可导入的本地偏好" : "偏好内容格式不正确", "warn");
    } catch {
      onNotify("偏好 JSON 无法解析", "bad");
    }
  }

  return (
    <section className="page-stack settings-page">
      <form className="settings-tab-form" onSubmit={submit}>
        <div className="tab-strip settings-tab-strip" role="tablist" aria-label="设置分类">
          <SettingsTabButton
            active={activeTab === "system"}
            icon={<Database size={18} />}
            title="系统设置"
            meta="服务与数据"
            onClick={() => setActiveTab("system")}
          />
          <SettingsTabButton
            active={activeTab === "app"}
            icon={<Settings2 size={18} />}
            title="应用设置"
            meta="检测与共享"
            onClick={() => setActiveTab("app")}
          />
          <SettingsTabButton
            active={activeTab === "tools"}
            icon={<Wrench size={18} />}
            title="工具设置"
            meta="ffmpeg / 下载器"
            onClick={() => setActiveTab("tools")}
          />
        </div>

        {activeTab === "system" && (
          <div className="settings-tab-content" role="tabpanel">
            <StatDeck stats={stats} />
            <div className="settings-console-grid">
              <ServerCard stats={stats} library={state.library} />
              <section className="panel settings-overview-panel">
                <div className="panel-title">
                  <div>
                    <p className="eyebrow">Runtime</p>
                    <h3>系统状态</h3>
                  </div>
                  <Activity size={20} />
                </div>
                <div className="settings-info-grid">
                  <SettingsInfoTile label="启用资源站" value={stats ? `${stats.enabledSites}/${stats.sites}` : "--"} />
                  <SettingsInfoTile label="本地视频" value={state.library.length} />
                  <SettingsInfoTile label="下载任务" value={state.downloads.length} />
                  <SettingsInfoTile label="HLS 任务" value={state.hlsJobs.length} />
                </div>
              </section>
            </div>

            <section className="panel runtime-panel">
              <div className="panel-title">
                <div>
                  <p className="eyebrow">Operations</p>
                  <h3>运行诊断</h3>
                </div>
                <div className="panel-title-actions">
                  <button className="tool-button subtle" type="button" onClick={() => void exportStateBackup()} disabled={exportingBackup}>
                    {exportingBackup ? <Loader2 className="spin" size={16} /> : <Archive size={16} />}
                    导出备份
                  </button>
                  <label className="tool-button subtle backup-upload-button">
                    <Archive size={16} />
                    预检备份
                    <input type="file" accept="application/json,.json" onChange={(event) => void previewBackupFile(event.target.files?.[0])} />
                  </label>
                  <button className="tool-button subtle" type="button" onClick={() => void copyRuntimeLogs()} disabled={!runtimeLogFiltered.length}>
                    <Copy size={16} />
                    复制当前日志
                  </button>
                  <button className="tool-button subtle" type="button" onClick={() => void refreshRuntime()} disabled={checkingRuntime}>
                    {checkingRuntime ? <Loader2 className="spin" size={16} /> : <RefreshCw size={16} />}
                    刷新诊断
                  </button>
                </div>
              </div>

              <div className="runtime-summary">
                <SettingsInfoTile label="API 运行" value={runtimeStatus ? formatUptime(runtimeStatus.uptimeSeconds) : "--"} />
                <SettingsInfoTile label="内存占用" value={runtimeStatus ? fileSize(runtimeStatus.memory.rss) : "--"} />
                <SettingsInfoTile label="日志大小" value={runtimeStatus ? fileSize(runtimeStatus.logs.size) : "--"} />
                <SettingsInfoTile label="最近日志" value={runtimeStatus ? runtimeStatus.logs.lines.length : "--"} />
              </div>

              <div className="backup-note">
                <Archive size={17} />
                <span>备份包含系统设置、资源站、追剧、下载任务、通知和缓存状态；不会包含 media 目录内的视频文件。</span>
              </div>

              {backupPreview ? (
                <div className={`backup-preview ${backupPreview.valid ? "ok" : "warning"}`}>
                  <div className="backup-preview-head">
                    <span>{backupPreview.valid ? <CheckCircle2 size={17} /> : <Activity size={17} />}</span>
                    <div>
                      <strong>{backupPreview.filename}</strong>
                      <small>{backupPreview.message}</small>
                    </div>
                    <button type="button" onClick={() => setBackupPreview(null)} aria-label="关闭备份预检">
                      <X size={15} />
                    </button>
                  </div>
                  <div className="backup-preview-grid">
                    <SettingsInfoTile label="资源站" value={`${backupPreview.summary.enabledSites}/${backupPreview.summary.sites}`} />
                    <SettingsInfoTile label="追剧" value={backupPreview.summary.watchlist} />
                    <SettingsInfoTile label="下载任务" value={backupPreview.summary.downloads} />
                    <SettingsInfoTile label="本地记录" value={backupPreview.summary.library} />
                  </div>
                  <small>
                    版本 {backupPreview.version ?? "--"} · 导出时间 {formatTime(backupPreview.exportedAt)}
                  </small>
                  {backupPreview.corruptFields.length ? (
                    <div className="backup-preview-alert">
                      <strong>检测到疑似编码损坏</strong>
                      <span>{backupPreview.corruptFields.length} 处内容包含乱码特征，请重新导出 UTF-8 备份后再恢复。</span>
                      <small>{backupPreview.corruptFields.slice(0, 3).map((field) => `${field.path}: ${field.value}`).join("；")}</small>
                    </div>
                  ) : null}
                  {backupPreview.valid ? (
                    <div className="backup-restore-actions">
                      <button className="tool-button subtle" type="button" onClick={() => setRestoreConfirmOpen(true)} disabled={restoringBackup}>
                        {restoringBackup ? <Loader2 className="spin" size={16} /> : <Archive size={16} />}
                        恢复此备份
                      </button>
                      <span>只恢复系统状态，不会导入或删除 media 目录文件。</span>
                    </div>
                  ) : null}
                </div>
              ) : null}

              <div className="runtime-layout">
                <div className="runtime-check-grid">
                  {runtimeStatus?.checks.length ? (
                    runtimeStatus.checks.map((check) => <RuntimeCheckCard check={check} key={check.id} />)
                  ) : (
                    <div className="empty-small">
                      {checkingRuntime ? <Loader2 className="spin" size={24} /> : <Activity size={24} />}
                      <span>{checkingRuntime ? "正在读取运行诊断" : "暂无运行诊断数据"}</span>
                    </div>
                  )}
                </div>

                <div className="runtime-log-box">
                  <div className="runtime-log-controls">
                    <label className="runtime-log-search">
                      <Search size={15} />
                      <input value={runtimeLogQuery} onChange={(event) => setRuntimeLogQuery(event.target.value)} placeholder="搜索运行日志" />
                      {runtimeLogQuery ? (
                        <button type="button" onClick={() => setRuntimeLogQuery("")} aria-label="清空日志搜索">
                          <X size={14} />
                        </button>
                      ) : null}
                    </label>
                    <label className="runtime-log-lines">
                      <span>行数</span>
                      <select value={runtimeLogLines} onChange={(event) => setRuntimeLogLines(Number(event.target.value))}>
                        {runtimeLogLineOptions.map((lineCount) => (
                          <option key={lineCount} value={lineCount}>
                            {lineCount}
                          </option>
                        ))}
                      </select>
                    </label>
                  </div>
                  <div className="runtime-log-filters" aria-label="运行日志筛选">
                    {runtimeLogFilters.map((filter) => (
                      <button
                        className={runtimeLogFilter === filter.key ? "active" : ""}
                        type="button"
                        key={filter.key}
                        onClick={() => setRuntimeLogFilter(filter.key)}
                      >
                        <span>{filter.label}</span>
                        <b>{filter.count}</b>
                      </button>
                    ))}
                  </div>
                  <div className="runtime-path-list">
                    <span title={runtimeStatus?.logFile}>日志：{runtimeStatus?.logFile ?? "--"}</span>
                    <span title={runtimeStatus?.mediaDir}>媒体：{runtimeStatus?.mediaDir ?? "--"}</span>
                  </div>
                  <pre>{runtimeLogFiltered.length ? runtimeLogFiltered.map((item) => item.line).join("\n") : runtimeStatus?.logs.lines.length ? "没有匹配的运行日志" : "暂无运行日志"}</pre>
                  <div className="runtime-log-foot">
                    <span>
                      显示 {runtimeLogFiltered.length}/{runtimeLogItems.length} 行
                    </span>
                    <span>更新时间：{formatTime(runtimeStatus?.logs.modifiedAt ?? runtimeStatus?.checkedAt)}</span>
                  </div>
                </div>
              </div>
            </section>
          </div>
        )}

        {restoreConfirmOpen && backupPreview?.valid ? (
          <RestoreBackupModal
            preview={backupPreview}
            restoring={restoringBackup}
            onClose={() => setRestoreConfirmOpen(false)}
            onConfirm={() => void restoreBackup()}
          />
        ) : null}

        {preferenceImportOpen ? (
          <PreferenceImportModal
            value={preferenceImportText}
            onChange={setPreferenceImportText}
            onLoadFile={(text) => setPreferenceImportText(text)}
            onClose={() => setPreferenceImportOpen(false)}
            onImport={importLocalPreferences}
          />
        ) : null}

        {activeTab === "app" && (
          <div className="settings-tab-content" role="tabpanel">
            <div className="settings-app-grid">
              <section className="panel settings-card">
                <div className="panel-title">
                  <div>
                    <p className="eyebrow">Auto Checks</p>
                    <h3>自动检测</h3>
                  </div>
                  <Activity size={20} />
                </div>
                <div className="settings-form dense-grid settings-app-fields">
                  <NumberField
                    label="健康检查 分"
                    value={draft.sourceHealthCheckIntervalMinutes}
                    min={1}
                    max={1440}
                    onChange={(value) => setDraft({ ...draft, sourceHealthCheckIntervalMinutes: value })}
                  />
                  <NumberField
                    label="追剧检查 分"
                    value={draft.watchlistCheckIntervalMinutes}
                    min={1}
                    max={1440}
                    onChange={(value) => setDraft({ ...draft, watchlistCheckIntervalMinutes: value })}
                  />
                </div>
                <div className="settings-check-history">
                  <span>
                    <Clock3 size={15} />
                    资源站：{formatTime(state.settings.sourceHealthLastAutoCheckAt)}
                  </span>
                  <span>
                    <Clock3 size={15} />
                    追剧：{formatTime(state.settings.watchlistLastAutoCheckAt)}
                  </span>
                </div>
              </section>

              <section className="panel settings-card playback-memory-card">
                <div className="panel-title">
                  <div>
                    <p className="eyebrow">Playback</p>
                    <h3>播放记录</h3>
                  </div>
                  <PlayCircle size={20} />
                </div>
                <div className="playback-memory-summary">
                  <SettingsInfoTile label="断点记录" value={playbackProgressSummary.count} />
                  <SettingsInfoTile label="最近更新" value={formatTime(playbackProgressSummary.latestAt)} />
                </div>
                {playbackProgressSummary.entries.length ? (
                  <div className="playback-memory-list" aria-label="最近播放断点">
                    {playbackProgressSummary.entries.slice(0, 5).map((entry) => (
                      <PlaybackProgressRow entry={entry} key={entry.key} onRemove={() => clearPlaybackMemoryEntry(entry)} />
                    ))}
                    {playbackProgressSummary.entries.length > 5 ? (
                      <span className="playback-memory-more">仅显示最近 5 条，完整记录会自动按时间保留。</span>
                    ) : null}
                  </div>
                ) : (
                  <div className="playback-memory-empty">暂无断点记录，播放超过 20 秒后会自动保存。</div>
                )}
                <div className="settings-action-note">
                  <span>用于播放器断点续播，只保存在当前浏览器，自动保留最近 {MAX_PLAYBACK_PROGRESS_ENTRIES} 条。</span>
                  <button className="tool-button subtle danger" type="button" onClick={clearPlaybackMemory} disabled={!playbackProgressSummary.count}>
                    <Trash2 size={16} />
                    清理播放记录
                  </button>
                </div>
              </section>

              <section className="panel settings-card local-preference-card">
                <div className="panel-title">
                  <div>
                    <p className="eyebrow">Local UI</p>
                    <h3>本地偏好</h3>
                  </div>
                  <Settings2 size={20} />
                </div>
                <div className="local-preference-summary">
                  <SettingsInfoTile label="偏好项目" value={preferenceSummary.count} />
                  <SettingsInfoTile label="存储范围" value="当前浏览器" />
                </div>
                {preferenceSummary.entries.length ? (
                  <div className="local-preference-list" aria-label="本地界面偏好">
                    {preferenceSummary.entries.slice(0, 6).map((entry) => (
                      <span key={entry.key} title={entry.key}>
                        {entry.label}
                      </span>
                    ))}
                    {preferenceSummary.entries.length > 6 ? <b>另有 {preferenceSummary.entries.length - 6} 项</b> : null}
                  </div>
                ) : (
                  <div className="playback-memory-empty">暂无本地界面偏好。</div>
                )}
                <div className="settings-action-note local-preference-actions">
                  <span className="settings-action-copy">重置筛选、分页、tab、倍速等界面偏好；不会清理播放断点。</span>
                  <div className="settings-action-buttons">
                    <button className="tool-button subtle" type="button" onClick={() => window.location.reload()}>
                      <RefreshCw size={16} />
                      刷新生效
                    </button>
                    <button className="tool-button subtle" type="button" onClick={() => void copyLocalPreferences()} disabled={!preferenceSummary.count}>
                      <Copy size={16} />
                      复制偏好
                    </button>
                    <button className="tool-button subtle" type="button" onClick={downloadLocalPreferences} disabled={!preferenceSummary.count}>
                      <Download size={16} />
                      下载偏好
                    </button>
                    <button className="tool-button subtle" type="button" onClick={() => setPreferenceImportOpen(true)}>
                      <ClipboardPaste size={16} />
                      导入偏好
                    </button>
                    <button className="tool-button subtle danger" type="button" onClick={clearLocalPreferences} disabled={!preferenceSummary.count}>
                      <Trash2 size={16} />
                      重置偏好
                    </button>
                  </div>
                </div>
              </section>

              <section className="panel settings-card">
                <div className="panel-title">
                  <div>
                    <p className="eyebrow">Share</p>
                    <h3>共享外部地址</h3>
                  </div>
                  <HardDrive size={20} />
                </div>
                <div className="settings-form compact">
                  <TextField
                    label="SMB 地址"
                    value={draft.shareSmbUrl}
                    onChange={(value) => setDraft({ ...draft, shareSmbUrl: value })}
                    placeholder="smb://192.168.1.10/Media"
                  />
                  <TextField
                    label="FTP 地址"
                    value={draft.shareFtpUrl}
                    onChange={(value) => setDraft({ ...draft, shareFtpUrl: value })}
                    placeholder="ftp://192.168.1.10/media"
                  />
                </div>
              </section>

              <section className="panel settings-card">
                <div className="panel-title">
                  <div>
                    <p className="eyebrow">Emby</p>
                    <h3>Emby 剧库同步</h3>
                  </div>
                  <PlayCircle size={20} />
                </div>
                <div className="settings-form compact">
                  <label className="toggle-row">
                    <span>启用 Emby 同步</span>
                    <input type="checkbox" checked={draft.embyEnabled} onChange={(event) => setDraft({ ...draft, embyEnabled: event.target.checked })} />
                  </label>
                  <label className="toggle-row">
                    <span>下载完成后立即同步</span>
                    <input type="checkbox" checked={draft.embySyncOnDownload} onChange={(event) => setDraft({ ...draft, embySyncOnDownload: event.target.checked })} />
                  </label>
                  <TextField
                    label="导出目录"
                    value={draft.embyOutputDir}
                    onChange={(value) => setDraft({ ...draft, embyOutputDir: value })}
                    placeholder="/home/lee/movie-hub/media/Emby"
                    hint="把这个目录添加到 Emby 的剧集库。"
                  />
                  <TextField
                    label="Movie Hub 播放地址"
                    value={draft.embyBaseUrl}
                    onChange={(value) => setDraft({ ...draft, embyBaseUrl: value })}
                    placeholder="http://192.168.1.2:8787"
                    hint="必须是 Emby 主机能访问的地址。"
                  />
                  <TextField
                    label="Emby Server URL"
                    value={draft.embyServerUrl}
                    onChange={(value) => setDraft({ ...draft, embyServerUrl: value })}
                    placeholder="http://127.0.0.1:8096"
                  />
                  <TextField
                    label="Emby API Key"
                    value={draft.embyApiKey}
                    onChange={(value) => setDraft({ ...draft, embyApiKey: value })}
                    placeholder="粘贴 Emby API Key"
                  />
                  <button className="tool-button subtle" type="button" onClick={() => void runEmbySync()} disabled={!draft.embyEnabled}>
                    <RefreshCw size={16} />
                    立即同步已有下载
                  </button>
                </div>
              </section>
            </div>
          </div>
        )}

        {activeTab === "tools" && (
          <div className="settings-tab-content" role="tabpanel">
            <section className="panel settings-tools-panel">
              <div className="panel-title">
                <div>
                  <p className="eyebrow">Toolchain</p>
                  <h3>工具状态</h3>
                </div>
                <div className="panel-title-actions">
                  <button className="tool-button subtle" type="button" onClick={() => void refreshTools()} disabled={checkingTools}>
                    {checkingTools ? <Loader2 className="spin" size={16} /> : <RefreshCw size={16} />}
                    检测工具
                  </button>
                  <TerminalSquare size={20} />
                </div>
              </div>

              <div className="tool-status-grid">
                <ToolStatusCard tool={toolStatus?.ffmpeg} loading={checkingTools} />
                <ToolStatusCard tool={toolStatus?.ffprobe} loading={checkingTools} />
                <ToolStatusCard tool={toolStatus?.nM3u8DlRe} loading={checkingTools} />
              </div>
            </section>

            <div className="settings-tool-grid">
              <section className="panel settings-card tool-config-card">
                <div className="panel-title">
                  <div>
                    <p className="eyebrow">Executables</p>
                    <h3>路径配置</h3>
                  </div>
                  <Wrench size={20} />
                </div>
                <div className="settings-form compact">
                  <TextField
                    label="ffmpeg 路径"
                    value={draft.ffmpegPath}
                    onChange={(value) => setDraft({ ...draft, ffmpegPath: value })}
                    placeholder="留空自动查找，或填 C:\\Tools\\ffmpeg.exe"
                  />
                  <TextField
                    label="N_m3u8DL-RE 路径"
                    value={draft.m3u8DownloaderPath}
                    onChange={(value) => setDraft({ ...draft, m3u8DownloaderPath: value })}
                    placeholder="留空自动查找，或填 tools\\N_m3u8DL-RE.exe"
                  />
                </div>
              </section>

              <section className="panel settings-card tool-config-card">
                <div className="panel-title">
                  <div>
                    <p className="eyebrow">Download Params</p>
                    <h3>基础参数</h3>
                  </div>
                  <Cpu size={20} />
                </div>
                <div className="settings-form dense-grid">
                  <NumberField label="m3u8 线程" value={draft.m3u8DownloaderThreads} min={1} max={64} onChange={(value) => setDraft({ ...draft, m3u8DownloaderThreads: value })} />
                  <NumberField label="m3u8 重试" value={draft.m3u8DownloaderRetryCount} min={1} max={20} onChange={(value) => setDraft({ ...draft, m3u8DownloaderRetryCount: value })} />
                  <NumberField label="请求超时 秒" value={draft.m3u8DownloaderTimeoutSeconds} min={5} max={120} onChange={(value) => setDraft({ ...draft, m3u8DownloaderTimeoutSeconds: value })} />
                  <NumberField label="HLS 分片 秒" value={draft.ffmpegHlsSegmentSeconds} min={2} max={30} onChange={(value) => setDraft({ ...draft, ffmpegHlsSegmentSeconds: value })} />
                  <NumberField label="重连延迟 秒" value={draft.ffmpegReconnectDelaySeconds} min={1} max={60} onChange={(value) => setDraft({ ...draft, ffmpegReconnectDelaySeconds: value })} />
                </div>
              </section>
            </div>

            <div className="settings-param-help">
              <strong>自定义参数说明</strong>
              <span>N_m3u8DL-RE 额外参数追加到系统下载命令末尾；ffmpeg 参数按输入位和输出位插入。</span>
            </div>

            <div className="settings-tool-split">
              <section className="panel settings-card tool-config-card">
                <div className="panel-title">
                  <div>
                    <p className="eyebrow">N_m3u8DL-RE</p>
                    <h3>下载器参数</h3>
                  </div>
                  <TerminalSquare size={20} />
                </div>
                <div className="settings-form advanced-grid">
                  <TextField
                    label="请求头"
                    value={draft.m3u8DownloaderHeaders}
                    onChange={(value) => setDraft({ ...draft, m3u8DownloaderHeaders: value })}
                    multiline
                    placeholder={"Cookie: xxx\nReferer: https://example.com"}
                    hint="一行一个请求头，会转换为多个 -H 参数；留空时使用默认 User-Agent。"
                  />
                  <TextField
                    label="代理"
                    value={draft.m3u8DownloaderProxy}
                    onChange={(value) => setDraft({ ...draft, m3u8DownloaderProxy: value })}
                    placeholder="http://127.0.0.1:7890"
                    hint="对应 --custom-proxy。"
                  />
                  <TextField
                    label="限速"
                    value={draft.m3u8DownloaderMaxSpeed}
                    onChange={(value) => setDraft({ ...draft, m3u8DownloaderMaxSpeed: value })}
                    placeholder="15M 或 800K"
                    hint="对应 --max-speed。"
                  />
                  <TextField
                    label="混流参数"
                    value={draft.m3u8DownloaderMuxAfterDone}
                    onChange={(value) => setDraft({ ...draft, m3u8DownloaderMuxAfterDone: value })}
                    placeholder="format=mp4"
                    hint="对应 -M；留空时默认 format=mp4。"
                  />
                  <TextField
                    label="额外参数"
                    value={draft.m3u8DownloaderExtraArgs}
                    onChange={(value) => setDraft({ ...draft, m3u8DownloaderExtraArgs: value })}
                    multiline
                    placeholder={'--append-url-params --select-video "res=1080" --custom-range "0-100"'}
                    hint="按命令行写法填写，支持引号；例如 --key、--custom-hls-key、--select-audio。"
                  />
                </div>
              </section>

              <section className="panel settings-card tool-config-card">
                <div className="panel-title">
                  <div>
                    <p className="eyebrow">ffmpeg</p>
                    <h3>转码参数</h3>
                  </div>
                  <Cpu size={20} />
                </div>
                <div className="settings-form advanced-grid">
                  <TextField
                    label="下载输入参数"
                    value={draft.ffmpegDownloadInputArgs}
                    onChange={(value) => setDraft({ ...draft, ffmpegDownloadInputArgs: value })}
                    placeholder="-rw_timeout 15000000"
                    hint="插入到下载命令的 -i 前。"
                  />
                  <TextField
                    label="下载输出参数"
                    value={draft.ffmpegDownloadOutputArgs}
                    onChange={(value) => setDraft({ ...draft, ffmpegDownloadOutputArgs: value })}
                    placeholder="-movflags +faststart"
                    hint="插入到下载输出 mp4 路径前。"
                  />
                  <TextField
                    label="HLS 输入参数"
                    value={draft.ffmpegHlsInputArgs}
                    onChange={(value) => setDraft({ ...draft, ffmpegHlsInputArgs: value })}
                    placeholder="-hwaccel auto"
                    hint="插入到本地片库生成 HLS 的 -i 前。"
                  />
                  <TextField
                    label="HLS 输出参数"
                    value={draft.ffmpegHlsOutputArgs}
                    onChange={(value) => setDraft({ ...draft, ffmpegHlsOutputArgs: value })}
                    placeholder="-hls_flags independent_segments"
                    hint="插入到 HLS playlist 路径前。"
                  />
                </div>
              </section>
            </div>
          </div>
        )}

        <div className="settings-submit-row">
          <button className="tool-button" type="submit" disabled={saving}>
            {saving ? <Loader2 className="spin" size={16} /> : <Save size={16} />}
            保存设置
          </button>
        </div>
      </form>
    </section>
  );
}

function SettingsTabButton({
  active,
  icon,
  title,
  meta,
  onClick
}: {
  active: boolean;
  icon: ReactNode;
  title: string;
  meta: string;
  onClick: () => void;
}) {
  return (
    <button className={`tab-button ${active ? "active" : ""}`} type="button" role="tab" aria-selected={active} onClick={onClick}>
      <span className="tab-button-icon">{icon}</span>
      <span>
        <strong>{title}</strong>
        <small>{meta}</small>
      </span>
    </button>
  );
}

function SettingsInfoTile({ label, value }: { label: string; value: string | number }) {
  return (
    <div className="settings-info-tile">
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  );
}

function RuntimeCheckCard({ check }: { check: RuntimeDiagnosticCheck }) {
  return (
    <article className={`runtime-check-card ${check.status}`}>
      <div>
        <span>{check.status === "ok" ? <CheckCircle2 size={17} /> : <Activity size={17} />}</span>
        <strong>{check.label}</strong>
        {check.value ? <b>{check.value}</b> : null}
      </div>
      <p>{check.message}</p>
    </article>
  );
}

function ToolStatusCard({ tool, loading }: { tool?: ToolStatus; loading: boolean }) {
  const state = tool?.stability ?? "missing";
  return (
    <article className={`tool-status-card ${state}`}>
      <div className="tool-status-head">
        <span>
          {loading ? <Loader2 className="spin" size={18} /> : tool?.ok ? <Activity size={18} /> : <HardDrive size={18} />}
        </span>
        <div>
          <strong>{tool?.label ?? "检测中"}</strong>
          <small>{toolStatusText(tool, loading)}</small>
        </div>
      </div>
      <p>{tool?.version ?? tool?.message ?? "正在读取工具状态"}</p>
      <div className="tool-status-meta">
        <span>{tool?.command ?? "--"}</span>
        <b>{tool?.latencyMs == null ? "--" : `${tool.latencyMs}ms`}</b>
      </div>
    </article>
  );
}

function PlaybackProgressRow({ entry, onRemove }: { entry: PlaybackProgressEntry; onRemove: () => void }) {
  const progressPercent = entry.duration > 0 ? Math.min(99, Math.max(1, Math.round((entry.time / entry.duration) * 100))) : 0;
  return (
    <article className="playback-memory-row">
      <div>
        <strong>{entry.title || "未命名视频"}</strong>
        <span title={entry.source || undefined}>{entry.source || "本地播放源"}</span>
      </div>
      <b>
        {formatDuration(entry.time)} / {formatDuration(entry.duration)}
      </b>
      <small title={`最近更新：${formatTime(entry.updatedAt)}`}>{progressPercent}%</small>
      <button type="button" onClick={onRemove} title="删除这条播放记录" aria-label={`删除 ${entry.title || "未命名视频"} 的播放记录`}>
        <Trash2 size={14} />
      </button>
    </article>
  );
}

function NumberField({
  label,
  value,
  min,
  max,
  onChange
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  onChange: (value: number) => void;
}) {
  return (
    <label>
      <span>{label}</span>
      <input type="number" min={min} max={max} value={value} onChange={(event) => onChange(Number(event.target.value))} />
    </label>
  );
}

function TextField({
  label,
  value,
  placeholder,
  hint,
  multiline = false,
  onChange
}: {
  label: string;
  value: string;
  placeholder?: string;
  hint?: string;
  multiline?: boolean;
  onChange: (value: string) => void;
}) {
  return (
    <label className={multiline ? "settings-wide-field" : undefined}>
      <span>{label}</span>
      {multiline ? (
        <textarea value={value} placeholder={placeholder} onChange={(event) => onChange(event.target.value)} />
      ) : (
        <input value={value} placeholder={placeholder} onChange={(event) => onChange(event.target.value)} />
      )}
      {hint && <small>{hint}</small>}
    </label>
  );
}

function RestoreBackupModal({
  preview,
  restoring,
  onClose,
  onConfirm
}: {
  preview: BackupPreview;
  restoring: boolean;
  onClose: () => void;
  onConfirm: () => void;
}) {
  return (
    <div className="settings-modal-backdrop" role="presentation" onMouseDown={restoring ? undefined : onClose}>
      <section className="settings-modal" role="dialog" aria-modal="true" aria-label="确认恢复备份" onMouseDown={(event) => event.stopPropagation()}>
        <div className="settings-modal-head">
          <div>
            <strong>确认恢复备份</strong>
            <span>{preview.filename}</span>
          </div>
          <button type="button" onClick={onClose} disabled={restoring} title="关闭">
            <X size={18} />
          </button>
        </div>
        <div className="backup-restore-warning">
          <Archive size={20} />
          <div>
            <strong>当前系统状态会被备份覆盖</strong>
            <span>系统设置、资源站、追剧、下载任务、通知和缓存状态会恢复到备份内容；media 目录内的视频文件不会被删除或导入。</span>
          </div>
        </div>
        <div className="backup-preview-grid">
          <SettingsInfoTile label="资源站" value={`${preview.summary.enabledSites}/${preview.summary.sites}`} />
          <SettingsInfoTile label="追剧" value={preview.summary.watchlist} />
          <SettingsInfoTile label="下载任务" value={preview.summary.downloads} />
          <SettingsInfoTile label="本地记录" value={preview.summary.library} />
        </div>
        <div className="settings-modal-actions">
          <button type="button" onClick={onClose} disabled={restoring}>
            取消
          </button>
          <button className="danger" type="button" onClick={onConfirm} disabled={restoring}>
            {restoring ? <Loader2 className="spin" size={15} /> : <Archive size={15} />}
            {restoring ? "恢复中" : "确认恢复"}
          </button>
        </div>
      </section>
    </div>
  );
}

function PreferenceImportModal({
  value,
  onChange,
  onLoadFile,
  onClose,
  onImport
}: {
  value: string;
  onChange: (value: string) => void;
  onLoadFile: (value: string) => void;
  onClose: () => void;
  onImport: () => void;
}) {
  const canImport = value.trim().length > 0;
  async function loadFile(file?: File) {
    if (!file) return;
    onLoadFile(await file.text());
  }
  return (
    <div className="settings-modal-backdrop" role="presentation" onMouseDown={onClose}>
      <section className="settings-modal preference-import-modal" role="dialog" aria-modal="true" aria-label="导入本地偏好" onMouseDown={(event) => event.stopPropagation()}>
        <div className="settings-modal-head">
          <div>
            <strong>导入本地偏好</strong>
            <span>粘贴“复制偏好”得到的 JSON 内容</span>
          </div>
          <button type="button" onClick={onClose} title="关闭">
            <X size={18} />
          </button>
        </div>
        <textarea value={value} onChange={(event) => onChange(event.target.value)} placeholder='{"format":"movie-hub-local-preferences","entries":{...}}' />
        <label className="preference-import-file">
          <Archive size={16} />
          从 JSON 文件填入
          <input type="file" accept="application/json,.json" onChange={(event) => void loadFile(event.target.files?.[0])} />
        </label>
        <div className="preference-import-note">
          <ClipboardPaste size={16} />
          <span>只会写入筛选、分页、tab、倍速等界面偏好；播放断点和系统数据备份不在这里导入。</span>
        </div>
        <div className="settings-modal-actions">
          <button type="button" onClick={onClose}>
            取消
          </button>
          <button type="button" onClick={onImport} disabled={!canImport}>
            <ClipboardPaste size={15} />
            导入偏好
          </button>
        </div>
      </section>
    </div>
  );
}

function toolStatusText(tool: ToolStatus | undefined, loading: boolean) {
  if (loading) return "检测中";
  if (!tool) return "未检测";
  if (tool.stability === "slow") return "可用但响应偏慢";
  if (tool.ok) return "稳定可用";
  return "未就绪";
}

function formatUptime(seconds: number) {
  const total = Math.max(0, Math.floor(seconds));
  const days = Math.floor(total / 86400);
  const hours = Math.floor((total % 86400) / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  if (days) return `${days}天${hours}小时`;
  if (hours) return `${hours}小时${minutes}分`;
  return `${minutes}分钟`;
}

function isSettingsTab(value: unknown): value is SettingsTab {
  return typeof value === "string" && settingsTabs.includes(value as SettingsTab);
}

function isRuntimeLogFilter(value: unknown): value is RuntimeLogFilter {
  return typeof value === "string" && runtimeLogFilterValues.includes(value as RuntimeLogFilter);
}

function isRuntimeLogLines(value: unknown): value is number {
  return typeof value === "number" && runtimeLogLineOptions.includes(value);
}

function runtimeLogMatchesFilter(line: string, filter: Exclude<RuntimeLogFilter, "all">) {
  if (filter === "error") return /error|failed|exception|econn|ebusy|错误|失败|异常/.test(line);
  if (filter === "api") return /\b(get|post|put|delete|options)\s+\/api|\[vite\]|api/.test(line);
  if (filter === "download") return /download|m3u8|ffmpeg|mux|下载|任务/.test(line);
  if (filter === "source") return /source|site|资源站|cms|vod/.test(line);
  return /ffmpeg|ffprobe|n_m3u8dl|n-m3u8dl|tool|工具/.test(line);
}

function parseBackupPayload(payload: unknown, filename: string): BackupPreview {
  if (!payload || typeof payload !== "object") {
    throw new Error("备份文件不是有效对象");
  }
  const root = payload as Record<string, unknown>;
  const state = root.state && typeof root.state === "object" ? (root.state as Record<string, unknown>) : undefined;
  const summary = root.summary && typeof root.summary === "object" ? (root.summary as Record<string, unknown>) : undefined;
  const format = typeof root.format === "string" ? root.format : "";
  const corruptFields = state ? findCorruptBackupFields(state) : [];
  const hasValidShape = format === "movie-hub-state-backup" && Boolean(state);
  const valid = hasValidShape && corruptFields.length === 0;
  const sites = readCount(summary?.sites, state?.sites);
  const enabledSites = readCount(summary?.enabledSites, Array.isArray(state?.sites) ? state.sites.filter((site) => Boolean((site as { enabled?: unknown }).enabled)) : undefined);
  return {
    filename,
    exportedAt: typeof root.exportedAt === "string" ? root.exportedAt : undefined,
    version: typeof root.version === "string" ? root.version : undefined,
    valid,
    message: hasValidShape
      ? corruptFields.length
        ? `备份疑似编码损坏，命中 ${corruptFields.length} 处，已禁止恢复`
        : "备份结构有效，可确认恢复"
      : "不是 Movie Hub 状态备份，无法用于恢复",
    corruptFields,
    summary: {
      sites,
      enabledSites,
      watchlist: readCount(summary?.watchlist, state?.watchlist),
      downloads: readCount(summary?.downloads, state?.downloads),
      hlsJobs: readCount(summary?.hlsJobs, state?.hlsJobs),
      notifications: readCount(summary?.notifications, state?.notifications),
      library: readCount(summary?.library, state?.library)
    }
  };
}

type CorruptBackupField = {
  path: string;
  value: string;
};

const mojibakePattern = /璧勬簮|澶囦唤|鎭㈠|涓嬭浇|鍔犲叆|鏈湴|濯掍綋|鐩綍|鏃犳硶|杩愯|瀵煎叆|褰撳墠|绯荤粺|銆|锛|锟斤拷/u;

function hasCorruptBackupText(value: unknown) {
  if (typeof value !== "string") return false;
  const text = value.trim();
  if (!text) return false;
  if (/[\uFFFD]/u.test(text)) return true;
  if (text.includes("\u951f") || text.includes("\u65a4\u62f7")) return true;
  if (mojibakePattern.test(text)) return true;
  if (/\?{2,}/.test(text)) return true;
  if (/^\?+\d+\?$/.test(text)) return true;
  if (/^\?+$/.test(text)) return true;
  return false;
}

function readRecord(value: unknown) {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}

function readList(value: unknown) {
  return Array.isArray(value) ? value : [];
}

function pushCorruptBackupField(fields: CorruptBackupField[], path: string, value: unknown) {
  if (hasCorruptBackupText(value)) fields.push({ path, value: String(value).slice(0, 80) });
}

function scanBackupCatalogItem(fields: CorruptBackupField[], prefix: string, value: unknown) {
  const item = readRecord(value);
  if (!item) return;
  for (const key of [
    "sourceName",
    "title",
    "originalTitle",
    "typeName",
    "actors",
    "director",
    "remarks",
    "description",
    "year",
    "area",
    "language",
    "score"
  ]) {
    pushCorruptBackupField(fields, `${prefix}.${key}`, item[key]);
  }
  readList(item.episodes).forEach((episode, index) => {
    const record = readRecord(episode);
    pushCorruptBackupField(fields, `${prefix}.episodes[${index}].name`, record?.name);
    pushCorruptBackupField(fields, `${prefix}.episodes[${index}].sourceName`, record?.sourceName);
  });
}

function findCorruptBackupFields(state: Record<string, unknown>) {
  const fields: CorruptBackupField[] = [];
  readList(state.sites).forEach((site, index) => {
    const record = readRecord(site);
    pushCorruptBackupField(fields, `sites[${index}].name`, record?.name);
    pushCorruptBackupField(fields, `sites[${index}].notes`, record?.notes);
  });
  const sourceHealth = readRecord(state.sourceHealth);
  if (sourceHealth) {
    Object.entries(sourceHealth).forEach(([siteId, value]) => {
      const record = readRecord(value);
      pushCorruptBackupField(fields, `sourceHealth.${siteId}.siteName`, record?.siteName);
      pushCorruptBackupField(fields, `sourceHealth.${siteId}.message`, record?.message);
    });
  }
  readList(state.watchlist).forEach((watch, index) => {
    const record = readRecord(watch);
    scanBackupCatalogItem(fields, `watchlist[${index}].item`, record?.item);
    pushCorruptBackupField(fields, `watchlist[${index}].latestEpisodeName`, record?.latestEpisodeName);
    pushCorruptBackupField(fields, `watchlist[${index}].updateMessage`, record?.updateMessage);
  });
  readList(state.downloads).forEach((task, index) => {
    const record = readRecord(task);
    pushCorruptBackupField(fields, `downloads[${index}].title`, record?.title);
    pushCorruptBackupField(fields, `downloads[${index}].episodeName`, record?.episodeName);
    pushCorruptBackupField(fields, `downloads[${index}].message`, record?.message);
    pushCorruptBackupField(fields, `downloads[${index}].outputDir`, record?.outputDir);
    pushCorruptBackupField(fields, `downloads[${index}].outputPath`, record?.outputPath);
  });
  readList(state.hlsJobs).forEach((job, index) => {
    const record = readRecord(job);
    pushCorruptBackupField(fields, `hlsJobs[${index}].title`, record?.title);
    pushCorruptBackupField(fields, `hlsJobs[${index}].episodeName`, record?.episodeName);
    pushCorruptBackupField(fields, `hlsJobs[${index}].fileName`, record?.fileName);
    pushCorruptBackupField(fields, `hlsJobs[${index}].message`, record?.message);
  });
  readList(state.notifications).forEach((notice, index) => {
    const record = readRecord(notice);
    pushCorruptBackupField(fields, `notifications[${index}].title`, record?.title);
    pushCorruptBackupField(fields, `notifications[${index}].message`, record?.message);
  });
  readList(state.scrapeHistory).forEach((entry, index) => {
    const record = readRecord(entry);
    pushCorruptBackupField(fields, `scrapeHistory[${index}].keyword`, record?.keyword);
    readList(record?.errors).forEach((error, errorIndex) => pushCorruptBackupField(fields, `scrapeHistory[${index}].errors[${errorIndex}]`, error));
    readList(record?.items).forEach((item, itemIndex) => scanBackupCatalogItem(fields, `scrapeHistory[${index}].items[${itemIndex}]`, item));
  });
  readList(state.trendingCache).forEach((item, index) => scanBackupCatalogItem(fields, `trendingCache[${index}]`, item));
  return fields;
}

function readCount(summaryValue: unknown, listValue: unknown) {
  if (typeof summaryValue === "number" && Number.isFinite(summaryValue)) return summaryValue;
  return Array.isArray(listValue) ? listValue.length : 0;
}

function clampInt(value: number, min: number, max: number, fallback: number) {
  if (!Number.isFinite(value)) return fallback;
  return Math.max(min, Math.min(max, Math.floor(value)));
}
