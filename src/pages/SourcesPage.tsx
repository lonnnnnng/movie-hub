import {
  Activity,
  Check,
  ChevronLeft,
  ChevronRight,
  Clock3,
  Eye,
  Loader2,
  Pencil,
  Plus,
  RefreshCw,
  Search,
  SearchCheck,
  ServerCog,
  Trash2,
  UploadCloud,
  X,
  XCircle
} from "lucide-react";
import type { FormEvent, ReactNode } from "react";
import { useEffect, useMemo, useState } from "react";
import { formatTime } from "../lib/format";
import { useStoredState } from "../lib/storage";
import type { AppState, SourceHealthCheck, SourceImportResult, SourceSite, Toast } from "../types";

type SiteDraft = {
  id?: string;
  name: string;
  baseUrl: string;
  enabled: boolean;
  searchable: boolean;
  apiStyle: SourceSite["apiStyle"];
  notes: string;
};

type SourceModal =
  | { mode: "create" }
  | { mode: "edit"; site: SourceSite }
  | { mode: "view"; site: SourceSite }
  | { mode: "delete"; site: SourceSite }
  | { mode: "import" };

type SourceStatusFilter = "all" | "online" | "offline" | "disabled" | "searchable" | "unchecked";

type SourceSortMode = "updated-desc" | "name-asc" | "latency-asc" | "status";

type SourcesPageProps = {
  state: AppState;
  onSaveSite: (payload: SiteDraft) => void | Promise<void>;
  onToggleSite: (site: SourceSite) => void | Promise<void>;
  onDeleteSite: (site: SourceSite) => void | Promise<void>;
  onCheckSite: (site: SourceSite) => void | Promise<void>;
  onCheckAll: () => void | Promise<void>;
  onImportSubscription: (payload: {
    url: string;
    enabled: boolean;
    searchable: boolean;
    apiStyle: SourceSite["apiStyle"];
  }) => Promise<SourceImportResult>;
  onNotify: (message: string, tone?: Toast["tone"]) => void;
};

const blankDraft: SiteDraft = {
  name: "",
  baseUrl: "",
  enabled: true,
  searchable: true,
  apiStyle: "auto",
  notes: ""
};

const pageSizeOptions = [10, 20, 50, 100];
const sourceStatusFilters = ["all", "online", "offline", "disabled", "searchable", "unchecked"] satisfies SourceStatusFilter[];
const sourceSortModes = ["updated-desc", "name-asc", "latency-asc", "status"] satisfies SourceSortMode[];

export function SourcesPage({ state, onSaveSite, onToggleSite, onDeleteSite, onCheckSite, onCheckAll, onImportSubscription, onNotify }: SourcesPageProps) {
  const [draft, setDraft] = useState<SiteDraft>(blankDraft);
  const [subscriptionUrl, setSubscriptionUrl] = useState("");
  const [subscriptionDefaults, setSubscriptionDefaults] = useState({
    enabled: true,
    searchable: true,
    apiStyle: "auto" as SourceSite["apiStyle"]
  });
  const [importing, setImporting] = useState(false);
  const [importResult, setImportResult] = useState<SourceImportResult | null>(null);
  const [modal, setModal] = useState<SourceModal | null>(null);
  const [query, setQuery] = useState("");
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useStoredState<number>("movie-hub.sources.pageSize", 20, { validate: isPageSize });
  const [saving, setSaving] = useState(false);
  const [checkingAll, setCheckingAll] = useState(false);
  const [checkingSiteId, setCheckingSiteId] = useState<string | null>(null);
  const [deletingSiteId, setDeletingSiteId] = useState<string | null>(null);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(() => new Set());
  const [bulkAction, setBulkAction] = useState<"enable" | "disable" | "check" | null>(null);
  const [statusFilter, setStatusFilter] = useStoredState<SourceStatusFilter>("movie-hub.sources.statusFilter", "all", { validate: isSourceStatusFilter });
  const [sortMode, setSortMode] = useStoredState<SourceSortMode>("movie-hub.sources.sortMode", "updated-desc", { validate: isSourceSortMode });

  const summary = useMemo(() => {
    const health = Object.values(state.sourceHealth);
    return {
      total: state.sites.length,
      enabled: state.sites.filter((site) => site.enabled).length,
      online: health.filter((result) => result.status === "online").length,
      offline: health.filter((result) => result.status === "offline").length
    };
  }, [state.sites, state.sourceHealth]);

  const normalizedQuery = query.trim().toLowerCase();
  const filterOptions = useMemo(() => {
    const count = (filter: SourceStatusFilter) => state.sites.filter((site) => sourceMatchesStatus(site, state.sourceHealth[site.id], filter)).length;
    return [
      { key: "all" as const, label: "全部", count: state.sites.length },
      { key: "online" as const, label: "在线", count: count("online") },
      { key: "offline" as const, label: "异常", count: count("offline") },
      { key: "disabled" as const, label: "停用", count: count("disabled") },
      { key: "searchable" as const, label: "可搜索", count: count("searchable") },
      { key: "unchecked" as const, label: "未检测", count: count("unchecked") }
    ];
  }, [state.sites, state.sourceHealth]);

  const filteredSites = useMemo(() => {
    const visible = state.sites.filter((site) => {
      if (!sourceMatchesStatus(site, state.sourceHealth[site.id], statusFilter)) return false;
      if (!normalizedQuery) return true;
      const health = state.sourceHealth[site.id];
      return [site.name, site.baseUrl, site.notes, site.apiStyle, health?.message, healthStatusText(site.enabled ? health?.status ?? "unknown" : "disabled")]
        .filter(Boolean)
        .some((value) => String(value ?? "").toLowerCase().includes(normalizedQuery));
    });
    return sortSites(visible, state.sourceHealth, sortMode);
  }, [normalizedQuery, sortMode, state.sites, state.sourceHealth, statusFilter]);

  const pageCount = Math.max(1, Math.ceil(filteredSites.length / pageSize));
  const currentPage = Math.min(page, pageCount);
  const pageStart = (currentPage - 1) * pageSize;
  const pageEnd = Math.min(pageStart + pageSize, filteredSites.length);
  const pageSites = useMemo(() => filteredSites.slice(pageStart, pageEnd), [filteredSites, pageEnd, pageStart]);
  const selectedSites = useMemo(() => state.sites.filter((site) => selectedIds.has(site.id)), [selectedIds, state.sites]);
  const selectedPageCount = pageSites.filter((site) => selectedIds.has(site.id)).length;
  const allPageSelected = Boolean(pageSites.length && selectedPageCount === pageSites.length);
  const partlyPageSelected = selectedPageCount > 0 && selectedPageCount < pageSites.length;

  useEffect(() => {
    setPage(1);
  }, [normalizedQuery, pageSize, sortMode, statusFilter]);

  useEffect(() => {
    if (page > pageCount) {
      setPage(pageCount);
    }
  }, [page, pageCount]);

  useEffect(() => {
    setSelectedIds((current) => {
      const valid = new Set(state.sites.map((site) => site.id));
      const next = new Set([...current].filter((id) => valid.has(id)));
      return next.size === current.size ? current : next;
    });
  }, [state.sites]);

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!draft.name.trim() || !draft.baseUrl.trim()) {
      onNotify("请填写资源站名称和接口地址", "warn");
      return;
    }

    setSaving(true);
    try {
      await onSaveSite({
        ...draft,
        name: draft.name.trim(),
        baseUrl: draft.baseUrl.trim(),
        notes: draft.notes.trim()
      });
      setDraft(blankDraft);
      setModal(null);
    } catch (error) {
      onNotify(error instanceof Error ? error.message : "资源站保存失败", "bad");
    } finally {
      setSaving(false);
    }
  }

  async function checkAll() {
    setCheckingAll(true);
    try {
      await onCheckAll();
    } catch (error) {
      onNotify(error instanceof Error ? error.message : "检测失败", "bad");
    } finally {
      setCheckingAll(false);
    }
  }

  async function checkSites(sites: SourceSite[]) {
    setBulkAction("check");
    try {
      for (const site of sites) {
        setCheckingSiteId(site.id);
        await onCheckSite(site);
      }
      onNotify(`已检测 ${sites.length} 个资源站`);
    } catch (error) {
      onNotify(error instanceof Error ? error.message : "批量检测失败", "bad");
    } finally {
      setCheckingSiteId(null);
      setBulkAction(null);
    }
  }

  async function setSitesEnabled(sites: SourceSite[], enabled: boolean) {
    setBulkAction(enabled ? "enable" : "disable");
    try {
      const targets = sites.filter((site) => site.enabled !== enabled);
      for (const site of targets) {
        await onToggleSite(site);
      }
      onNotify(`${enabled ? "已启用" : "已停用"} ${targets.length} 个资源站`);
    } catch (error) {
      onNotify(error instanceof Error ? error.message : "批量更新失败", "bad");
    } finally {
      setBulkAction(null);
    }
  }

  async function checkSite(site: SourceSite) {
    setCheckingSiteId(site.id);
    try {
      await onCheckSite(site);
    } catch (error) {
      onNotify(error instanceof Error ? error.message : "检测失败", "bad");
    } finally {
      setCheckingSiteId(null);
    }
  }

  function submitFilter(event: FormEvent) {
    event.preventDefault();
    setPage(1);
  }

  function toggleSelected(siteId: string) {
    setSelectedIds((current) => {
      const next = new Set(current);
      if (next.has(siteId)) next.delete(siteId);
      else next.add(siteId);
      return next;
    });
  }

  function toggleCurrentPageSelected() {
    setSelectedIds((current) => {
      const next = new Set(current);
      if (allPageSelected) {
        for (const site of pageSites) next.delete(site.id);
      } else {
        for (const site of pageSites) next.add(site.id);
      }
      return next;
    });
  }

  function requestRemoveSite(site: SourceSite) {
    if (site.builtIn) {
      onNotify("内置资源站不能删除，可以停用", "warn");
      return;
    }
    setModal({ mode: "delete", site });
  }

  async function confirmRemoveSite(site: SourceSite) {
    if (site.builtIn) {
      onNotify("内置资源站不能删除，可以停用", "warn");
      return;
    }
    setDeletingSiteId(site.id);
    try {
      await onDeleteSite(site);
      setSelectedIds((current) => {
        if (!current.has(site.id)) return current;
        const next = new Set(current);
        next.delete(site.id);
        return next;
      });
      setModal(null);
    } catch (error) {
      onNotify(error instanceof Error ? error.message : "资源站删除失败", "bad");
    } finally {
      setDeletingSiteId(null);
    }
  }

  function openCreate() {
    setDraft(blankDraft);
    setModal({ mode: "create" });
  }

  function openImport() {
    setSubscriptionUrl("");
    setImportResult(null);
    setSubscriptionDefaults({ enabled: true, searchable: true, apiStyle: "auto" });
    setModal({ mode: "import" });
  }

  function openEdit(site: SourceSite) {
    setDraft(draftFromSite(site));
    setModal({ mode: "edit", site });
  }

  async function submitImport(event: FormEvent) {
    event.preventDefault();
    if (!subscriptionUrl.trim()) {
      onNotify("请填写订阅地址", "warn");
      return;
    }

    setImporting(true);
    try {
      const result = await onImportSubscription({
        url: subscriptionUrl.trim(),
        ...subscriptionDefaults
      });
      setImportResult(result);
      if (result.totals.imported > 0) {
        setQuery("");
        setPage(1);
      }
    } catch (error) {
      onNotify(error instanceof Error ? error.message : "订阅导入失败", "bad");
    } finally {
      setImporting(false);
    }
  }

  return (
    <section className="page-stack sources-page">
      <div className="source-summary">
        <SourceStat label="总数" value={summary.total} />
        <SourceStat label="启用" value={summary.enabled} />
        <SourceStat label="在线" value={summary.online} tone="good" />
        <SourceStat label="异常" value={summary.offline} tone="bad" />
      </div>

      <section className="panel source-table-panel source-list-panel">
        <div className="panel-title source-list-title">
          <div>
            <p className="eyebrow">Connectivity</p>
            <h3>资源站列表</h3>
          </div>
          <span className="source-auto-line">
            <Clock3 size={14} />
            {formatTime(state.settings.sourceHealthLastAutoCheckAt)}
          </span>
        </div>

        <form className="source-toolbar" onSubmit={submitFilter}>
          <label className="source-search">
            <Search size={17} />
            <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="搜索名称、接口、备注或状态" />
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
          <div className="source-page-actions">
            <button className="tool-button" type="button" onClick={checkAll} disabled={checkingAll || !state.sites.length}>
              {checkingAll ? <Loader2 className="spin" size={18} /> : <RefreshCw size={18} />}
              检测全部
            </button>
            <button className="tool-button" type="button" onClick={openImport}>
              <UploadCloud size={18} />
              导入订阅
            </button>
            <button className="tool-button" type="button" onClick={openCreate}>
              <Plus size={18} />
              新增资源站
            </button>
          </div>
        </form>

        <div className="source-filter-strip" aria-label="资源站筛选和排序">
          <div className="source-filter-tabs">
            {filterOptions.map((option) => (
              <button
                key={option.key}
                className={statusFilter === option.key ? "active" : ""}
                type="button"
                onClick={() => setStatusFilter(option.key)}
              >
                <span>{option.label}</span>
                <b>{option.count}</b>
              </button>
            ))}
          </div>
          <label className="source-sort-select">
            <span>排序</span>
            <select value={sortMode} onChange={(event) => setSortMode(event.target.value as SourceSortMode)}>
              <option value="updated-desc">最近检测</option>
              <option value="latency-asc">延迟优先</option>
              <option value="status">状态分组</option>
              <option value="name-asc">名称 A-Z</option>
            </select>
          </label>
        </div>

        {selectedIds.size ? (
          <div className="source-bulk-bar">
            <span>已选 {selectedIds.size} 个资源站</span>
            <div>
              <button type="button" onClick={() => void setSitesEnabled(selectedSites, true)} disabled={Boolean(bulkAction)}>
                {bulkAction === "enable" ? <Loader2 className="spin" size={15} /> : <Check size={15} />}
                启用
              </button>
              <button type="button" onClick={() => void setSitesEnabled(selectedSites, false)} disabled={Boolean(bulkAction)}>
                {bulkAction === "disable" ? <Loader2 className="spin" size={15} /> : <Activity size={15} />}
                停用
              </button>
              <button type="button" onClick={() => void checkSites(selectedSites)} disabled={Boolean(bulkAction)}>
                {bulkAction === "check" ? <Loader2 className="spin" size={15} /> : <SearchCheck size={15} />}
                检测
              </button>
              <button type="button" onClick={() => setSelectedIds(new Set())} disabled={Boolean(bulkAction)}>
                <X size={15} />
                清空
              </button>
            </div>
          </div>
        ) : null}

        <div className="source-table">
          <div className="source-table-head">
            <label className="source-select-all">
              <input
                type="checkbox"
                checked={allPageSelected}
                ref={(input) => {
                  if (input) input.indeterminate = partlyPageSelected;
                }}
                onChange={toggleCurrentPageSelected}
              />
              <span>站点</span>
            </label>
            <span>连通性</span>
            <span>配置</span>
            <span>更新时间</span>
            <span>操作</span>
          </div>
          {pageSites.length ? (
            pageSites.map((site) => (
              <SourceRow
                key={site.id}
                site={site}
                health={state.sourceHealth[site.id]}
                checking={checkingSiteId === site.id}
                selected={selectedIds.has(site.id)}
                onSelect={() => toggleSelected(site.id)}
                onView={() => setModal({ mode: "view", site })}
                onEdit={() => openEdit(site)}
                onToggle={() => void onToggleSite(site)}
                onDelete={() => requestRemoveSite(site)}
                onCheck={() => void checkSite(site)}
              />
            ))
          ) : (
            <div className="empty-small source-empty">
              {normalizedQuery ? <Search size={24} /> : <ServerCog size={24} />}
              <span>{normalizedQuery ? "没有匹配的资源站" : "暂无资源站"}</span>
            </div>
          )}
        </div>

        {filteredSites.length ? (
          <div className="source-pagination" aria-label="资源站分页">
            <span>
              第 {currentPage} / {pageCount} 页 · 显示 {pageStart + 1}-{pageEnd} / {filteredSites.length}
            </span>
            <label>
              每页
              <select value={pageSize} onChange={(event) => setPageSize(Number(event.target.value))}>
                {pageSizeOptions.map((value) => (
                  <option key={value} value={value}>
                    {value}
                  </option>
                ))}
              </select>
            </label>
            <div className="source-page-buttons">
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

      {modal?.mode === "create" || modal?.mode === "edit" ? (
        <SourceFormModal mode={modal.mode} draft={draft} saving={saving} onDraftChange={setDraft} onSubmit={submit} onClose={() => setModal(null)} />
      ) : null}

      {modal?.mode === "import" ? (
        <SourceImportModal
          url={subscriptionUrl}
          defaults={subscriptionDefaults}
          importing={importing}
          result={importResult}
          onUrlChange={setSubscriptionUrl}
          onDefaultsChange={setSubscriptionDefaults}
          onSubmit={submitImport}
          onClose={() => setModal(null)}
        />
      ) : null}

      {modal?.mode === "view" ? (
        <SourceViewModal
          site={modal.site}
          health={state.sourceHealth[modal.site.id]}
          checking={checkingSiteId === modal.site.id}
          onClose={() => setModal(null)}
          onEdit={() => openEdit(modal.site)}
          onCheck={() => void checkSite(modal.site)}
          onToggle={() => void onToggleSite(modal.site)}
          onDelete={() => requestRemoveSite(modal.site)}
        />
      ) : null}

      {modal?.mode === "delete" ? (
        <SourceDeleteModal
          site={modal.site}
          deleting={deletingSiteId === modal.site.id}
          onClose={() => setModal(null)}
          onConfirm={() => void confirmRemoveSite(modal.site)}
        />
      ) : null}
    </section>
  );
}

function SourceFormModal({
  mode,
  draft,
  saving,
  onDraftChange,
  onSubmit,
  onClose
}: {
  mode: "create" | "edit";
  draft: SiteDraft;
  saving: boolean;
  onDraftChange: (draft: SiteDraft) => void;
  onSubmit: (event: FormEvent) => void;
  onClose: () => void;
}) {
  return (
    <SourceModalShell title={mode === "edit" ? "修改资源站" : "新增资源站"} subtitle={mode === "edit" ? draft.name : "添加一个新的 CMS 接口"} onClose={onClose}>
      <form className="source-editor-form" onSubmit={onSubmit}>
        <label>
          <span>名称</span>
          <input value={draft.name} onChange={(event) => onDraftChange({ ...draft, name: event.target.value })} placeholder="如：优质资源站" />
        </label>
        <label>
          <span>接口地址</span>
          <input value={draft.baseUrl} onChange={(event) => onDraftChange({ ...draft, baseUrl: event.target.value })} placeholder="https://example.com/api.php/provide/vod/" />
        </label>
        <label>
          <span>接口模式</span>
          <select value={draft.apiStyle} onChange={(event) => onDraftChange({ ...draft, apiStyle: event.target.value as SourceSite["apiStyle"] })}>
            <option value="auto">自动识别</option>
            <option value="maccms-json">MacCMS JSON</option>
            <option value="maccms-xml">MacCMS XML</option>
          </select>
        </label>
        <label>
          <span>备注</span>
          <textarea value={draft.notes} onChange={(event) => onDraftChange({ ...draft, notes: event.target.value })} placeholder="备用线路、地区、清晰度等" />
        </label>

        <div className="source-switches">
          <label>
            <input type="checkbox" checked={draft.enabled} onChange={(event) => onDraftChange({ ...draft, enabled: event.target.checked })} />
            <span>启用</span>
          </label>
          <label>
            <input type="checkbox" checked={draft.searchable} onChange={(event) => onDraftChange({ ...draft, searchable: event.target.checked })} />
            <span>参与搜索</span>
          </label>
        </div>

        <div className="source-form-actions">
          <button className="tool-button" type="submit" disabled={saving}>
            {saving ? <Loader2 className="spin" size={16} /> : mode === "edit" ? <Pencil size={16} /> : <Plus size={16} />}
            {mode === "edit" ? "保存修改" : "添加资源站"}
          </button>
          <button type="button" onClick={onClose}>
            <XCircle size={16} />
            取消
          </button>
        </div>
      </form>
    </SourceModalShell>
  );
}

function SourceImportModal({
  url,
  defaults,
  importing,
  result,
  onUrlChange,
  onDefaultsChange,
  onSubmit,
  onClose
}: {
  url: string;
  defaults: {
    enabled: boolean;
    searchable: boolean;
    apiStyle: SourceSite["apiStyle"];
  };
  importing: boolean;
  result: SourceImportResult | null;
  onUrlChange: (url: string) => void;
  onDefaultsChange: (defaults: { enabled: boolean; searchable: boolean; apiStyle: SourceSite["apiStyle"] }) => void;
  onSubmit: (event: FormEvent) => void;
  onClose: () => void;
}) {
  return (
    <SourceModalShell title="导入资源站订阅" subtitle="支持 uz / vod 订阅中的 MacCMS 采集接口" onClose={onClose} wide>
      <form className="source-editor-form source-import-form" onSubmit={onSubmit}>
        <label>
          <span>订阅地址</span>
          <input value={url} onChange={(event) => onUrlChange(event.target.value)} placeholder="https://example.com/subscription.json" />
        </label>
        <label>
          <span>接口模式</span>
          <select value={defaults.apiStyle} onChange={(event) => onDefaultsChange({ ...defaults, apiStyle: event.target.value as SourceSite["apiStyle"] })}>
            <option value="auto">自动识别</option>
            <option value="maccms-json">MacCMS JSON</option>
            <option value="maccms-xml">MacCMS XML</option>
          </select>
        </label>

        <div className="source-switches">
          <label>
            <input type="checkbox" checked={defaults.enabled} onChange={(event) => onDefaultsChange({ ...defaults, enabled: event.target.checked })} />
            <span>导入后启用</span>
          </label>
          <label>
            <input type="checkbox" checked={defaults.searchable} onChange={(event) => onDefaultsChange({ ...defaults, searchable: event.target.checked })} />
            <span>参与搜索</span>
          </label>
        </div>

        {result ? (
          <div className="source-import-result">
            <div className="source-import-stats">
              <InfoTile label="识别" value={`${result.totals.candidates}`} />
              <InfoTile label="新增" value={`${result.totals.imported}`} tone={result.totals.imported ? "good" : undefined} />
              <InfoTile label="跳过" value={`${result.totals.skipped}`} />
              <InfoTile label="失败" value={`${result.totals.failed}`} tone={result.totals.failed ? "bad" : undefined} />
            </div>
            <div className="source-import-preview">
              {result.imported.slice(0, 6).map((site) => (
                <span key={site.id}>{site.name}</span>
              ))}
              {!result.imported.length && result.skipped.length ? <small>没有新增资源站，重复站点已全部跳过。</small> : null}
              {!result.imported.length && !result.skipped.length ? <small>没有新增资源站。</small> : null}
            </div>
            {result.skipped.length ? (
              <div className="source-import-duplicate-notice" role="status">
                <strong>已跳过 {result.skipped.length} 个重复站点</strong>
                <span>
                  {result.skipped
                    .slice(0, 8)
                    .map((site) => site.name)
                    .join("、")}
                  {result.skipped.length > 8 ? `，另有 ${result.skipped.length - 8} 个` : ""}
                </span>
              </div>
            ) : null}
          </div>
        ) : null}

        <div className="source-form-actions">
          <button className="tool-button" type="submit" disabled={importing}>
            {importing ? <Loader2 className="spin" size={16} /> : <UploadCloud size={16} />}
            开始导入
          </button>
          <button type="button" onClick={onClose}>
            <XCircle size={16} />
            关闭
          </button>
        </div>
      </form>
    </SourceModalShell>
  );
}

function SourceViewModal({
  site,
  health,
  checking,
  onClose,
  onEdit,
  onCheck,
  onToggle,
  onDelete
}: {
  site: SourceSite;
  health?: SourceHealthCheck;
  checking: boolean;
  onClose: () => void;
  onEdit: () => void;
  onCheck: () => void;
  onToggle: () => void;
  onDelete: () => void;
}) {
  const status = site.enabled ? health?.status ?? "unknown" : "disabled";

  return (
    <SourceModalShell title={site.name} subtitle={site.baseUrl} onClose={onClose} wide>
      <div className="source-view-grid">
        <InfoTile label="连通性" value={healthStatusText(status)} tone={status === "online" ? "good" : status === "offline" ? "bad" : undefined} />
        <InfoTile label="延迟" value={health?.latencyMs ? `${health.latencyMs}ms` : "无数据"} />
        <InfoTile label="HTTP" value={health?.httpStatus ? String(health.httpStatus) : "无数据"} />
        <InfoTile label="接口模式" value={apiStyleText(site.apiStyle)} />
      </div>
      <div className="source-view-detail">
        <span>接口地址</span>
        <strong>{site.baseUrl}</strong>
      </div>
      <div className="source-view-detail">
        <span>备注</span>
        <strong>{site.notes || "无备注"}</strong>
      </div>
      <div className="source-view-detail">
        <span>检测信息</span>
        <strong>{health?.message ?? "尚未检测"}</strong>
        <small>{formatTime(health?.checkedAt)}</small>
      </div>
      <div className="source-flags">
        <span className={site.enabled ? "on" : ""}>{site.enabled ? "启用" : "停用"}</span>
        <span className={site.searchable ? "on" : ""}>{site.searchable ? "可搜" : "不搜"}</span>
        {site.builtIn && <span>内置</span>}
      </div>
      <div className="source-modal-actions">
        <button type="button" onClick={onCheck} disabled={checking}>
          {checking ? <Loader2 className="spin" size={15} /> : <SearchCheck size={15} />}
          检测
        </button>
        <button type="button" onClick={onToggle}>
          {site.enabled ? <Check size={15} /> : <Activity size={15} />}
          {site.enabled ? "停用" : "启用"}
        </button>
        <button type="button" onClick={onEdit}>
          <Pencil size={15} />
          修改
        </button>
        <button type="button" onClick={onDelete} disabled={site.builtIn}>
          <Trash2 size={15} />
          删除
        </button>
      </div>
    </SourceModalShell>
  );
}

function SourceDeleteModal({
  site,
  deleting,
  onClose,
  onConfirm
}: {
  site: SourceSite;
  deleting: boolean;
  onClose: () => void;
  onConfirm: () => void;
}) {
  return (
    <SourceModalShell title="删除资源站" subtitle="该操作只移除站点配置，不会删除已下载的视频文件" onClose={deleting ? () => undefined : onClose}>
      <div className="source-delete-card">
        <div className="source-delete-icon">
          <Trash2 size={20} />
        </div>
        <div>
          <strong>{site.name}</strong>
          <span>{site.baseUrl}</span>
          {site.notes ? <small>{site.notes}</small> : null}
        </div>
      </div>
      <div className="source-delete-warning">
        删除后首页推荐、资源站搜索和线路评估都不会再使用这个站点；如只是暂时不可用，建议改为停用。
      </div>
      <div className="source-modal-actions">
        <button type="button" onClick={onClose} disabled={deleting}>
          取消
        </button>
        <button className="danger" type="button" onClick={onConfirm} disabled={deleting}>
          {deleting ? <Loader2 className="spin" size={15} /> : <Trash2 size={15} />}
          {deleting ? "删除中" : "确认删除"}
        </button>
      </div>
    </SourceModalShell>
  );
}

function SourceModalShell({ title, subtitle, wide, onClose, children }: { title: string; subtitle?: string; wide?: boolean; onClose: () => void; children: ReactNode }) {
  return (
    <div className="source-modal-backdrop" role="presentation" onMouseDown={onClose}>
      <section className={`source-modal ${wide ? "wide" : ""}`} role="dialog" aria-modal="true" aria-label={title} onMouseDown={(event) => event.stopPropagation()}>
        <div className="source-modal-head">
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

function SourceStat({ label, value, tone }: { label: string; value: number; tone?: "good" | "bad" }) {
  return (
    <article className={`source-stat ${tone ?? ""}`}>
      <span>{label}</span>
      <strong>{value}</strong>
    </article>
  );
}

function SourceRow({
  site,
  health,
  checking,
  selected,
  onSelect,
  onView,
  onEdit,
  onToggle,
  onDelete,
  onCheck
}: {
  site: SourceSite;
  health?: SourceHealthCheck;
  checking: boolean;
  selected: boolean;
  onSelect: () => void;
  onView: () => void;
  onEdit: () => void;
  onToggle: () => void;
  onDelete: () => void;
  onCheck: () => void;
}) {
  const status = site.enabled ? health?.status ?? "unknown" : "disabled";

  return (
    <article className={`source-row ${!site.enabled ? "disabled" : ""} ${selected ? "selected" : ""}`}>
      <div className="source-name-cell">
        <label className="source-row-selector">
          <input type="checkbox" checked={selected} onChange={onSelect} aria-label={`选择 ${site.name}`} />
          <span>
            <strong>{site.name}</strong>
            <small>{site.baseUrl}</small>
          </span>
        </label>
        {site.notes && <small>{site.notes}</small>}
      </div>

      <div className="source-health-cell">
        <span className={`source-health-pill ${status}`}>{healthStatusText(status)}</span>
        <small>
          {health?.latencyMs ? `${health.latencyMs}ms` : "无延迟数据"}
          {health?.httpStatus ? ` · HTTP ${health.httpStatus}` : ""}
        </small>
        <small>{health?.message ?? "尚未检测"}</small>
      </div>

      <div className="source-flags">
        <span className={site.enabled ? "on" : ""}>{site.enabled ? "启用" : "停用"}</span>
        <span className={site.searchable ? "on" : ""}>{site.searchable ? "可搜" : "不搜"}</span>
        <span>{apiStyleText(site.apiStyle)}</span>
        {site.builtIn && <span>内置</span>}
      </div>

      <span className="source-updated-cell">{formatTime(health?.checkedAt ?? site.updatedAt)}</span>

      <div className="source-actions">
        <button type="button" onClick={onView} title="查看">
          <Eye size={15} />
        </button>
        <button type="button" onClick={onCheck} disabled={checking} title="检测">
          {checking ? <Loader2 className="spin" size={15} /> : <SearchCheck size={15} />}
        </button>
        <button type="button" onClick={onToggle} title={site.enabled ? "停用" : "启用"}>
          {site.enabled ? <Check size={15} /> : <Activity size={15} />}
        </button>
        <button type="button" onClick={onEdit} title="修改">
          <Pencil size={15} />
        </button>
        <button type="button" onClick={onDelete} disabled={site.builtIn} title={site.builtIn ? "内置资源站不能删除" : "删除"}>
          <Trash2 size={15} />
        </button>
      </div>
    </article>
  );
}

function InfoTile({ label, value, tone }: { label: string; value: string; tone?: "good" | "bad" }) {
  return (
    <div className={`source-info-tile ${tone ?? ""}`}>
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  );
}

function draftFromSite(site: SourceSite): SiteDraft {
  return {
    id: site.id,
    name: site.name,
    baseUrl: site.baseUrl,
    enabled: site.enabled,
    searchable: site.searchable,
    apiStyle: site.apiStyle,
    notes: site.notes ?? ""
  };
}

function sourceMatchesStatus(site: SourceSite, health: SourceHealthCheck | undefined, filter: SourceStatusFilter) {
  const status = site.enabled ? health?.status ?? "unknown" : "disabled";
  return {
    all: true,
    online: status === "online",
    offline: status === "offline",
    disabled: status === "disabled",
    searchable: site.searchable,
    unchecked: status === "unknown"
  }[filter];
}

function sortSites(sites: SourceSite[], healthMap: Record<string, SourceHealthCheck>, sortMode: SourceSortMode) {
  const statusRank = { offline: 0, unknown: 1, online: 2, disabled: 3 } as const;
  return [...sites].sort((left, right) => {
    const leftHealth = healthMap[left.id];
    const rightHealth = healthMap[right.id];
    if (sortMode === "name-asc") return left.name.localeCompare(right.name, "zh-CN");
    if (sortMode === "latency-asc") return (leftHealth?.latencyMs ?? Number.MAX_SAFE_INTEGER) - (rightHealth?.latencyMs ?? Number.MAX_SAFE_INTEGER);
    if (sortMode === "status") {
      const leftStatus = left.enabled ? leftHealth?.status ?? "unknown" : "disabled";
      const rightStatus = right.enabled ? rightHealth?.status ?? "unknown" : "disabled";
      return statusRank[leftStatus] - statusRank[rightStatus] || left.name.localeCompare(right.name, "zh-CN");
    }
    return (rightHealth?.checkedAt ?? right.updatedAt).localeCompare(leftHealth?.checkedAt ?? left.updatedAt);
  });
}

function isSourceStatusFilter(value: unknown): value is SourceStatusFilter {
  return typeof value === "string" && sourceStatusFilters.includes(value as SourceStatusFilter);
}

function isSourceSortMode(value: unknown): value is SourceSortMode {
  return typeof value === "string" && sourceSortModes.includes(value as SourceSortMode);
}

function isPageSize(value: unknown): value is number {
  return typeof value === "number" && pageSizeOptions.includes(value);
}

function healthStatusText(status: SourceHealthCheck["status"] | "unknown") {
  return {
    online: "在线",
    offline: "异常",
    disabled: "停用",
    unknown: "未检测"
  }[status];
}

function apiStyleText(style: SourceSite["apiStyle"]) {
  return {
    auto: "自动",
    "maccms-json": "JSON",
    "maccms-xml": "XML"
  }[style];
}
