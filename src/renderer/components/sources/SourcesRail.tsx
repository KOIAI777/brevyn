import { useCallback, useEffect, useMemo, useState, type FormEvent, type PointerEvent } from "react";
import { BookMarked, Check, CheckCircle2, CircleDashed, FileText, Globe2, Layers3, LibraryBig, Link2, Loader2, LockKeyhole, Paperclip, Plus, RefreshCw, Search, Trash2, X } from "lucide-react";
import type { BrevynTask, Course, ExternalSource, ExternalSourceScope, SemesterWorkspace, WorkspaceFileNode } from "@/types/domain";
import { cx } from "@/lib/cn";
import { fileDisplayName } from "@/components/files/FileContextMenu";
import { FileTypeBadge, FileTypeIcon } from "@/components/files/FileTypeIcon";
import { RailResizeHandle } from "@/components/shell/RailResizeHandle";

type SourcePanelStatus = "indexed" | "partial" | "processing" | "failed" | "idle";

type MaterialGroup = {
  id: "semester" | "task" | "course" | "lecture";
  title: string;
  description: string;
  count: number;
  indexedCount: number;
  status: SourcePanelStatus;
  files: WorkspaceFileNode[];
};

type ExternalSourceViewItem = {
  source: ExternalSource;
  file?: WorkspaceFileNode;
};

const MATERIAL_PREVIEW_LIMIT_PER_GROUP = 5;
const EXTERNAL_SOURCE_PREVIEW_LIMIT = 5;

export function SourcesRail({
  collapsed = false,
  embedded = false,
  semester,
  course,
  activeTask,
  files,
  onPreviewFile,
  resizing,
  onResizeStart,
}: {
  collapsed?: boolean;
  embedded?: boolean;
  semester?: SemesterWorkspace | null;
  course?: Course;
  activeTask?: BrevynTask;
  files: WorkspaceFileNode[];
  onPreviewFile?: (file: WorkspaceFileNode) => void;
  resizing?: boolean;
  onResizeStart?: (event: PointerEvent) => void;
}) {
  const effectiveCollapsed = embedded ? false : collapsed;
  const [renderContent, setRenderContent] = useState(!effectiveCollapsed);
  const [externalSources, setExternalSources] = useState<ExternalSource[]>([]);
  const [externalLoading, setExternalLoading] = useState(false);
  const [externalError, setExternalError] = useState("");
  const [addDialogOpen, setAddDialogOpen] = useState(false);
  const [addBusy, setAddBusy] = useState<"url" | "file" | "delete" | "">("");
  const [retryingSourceIds, setRetryingSourceIds] = useState<Set<string>>(() => new Set());
  const [expandedGroupIds, setExpandedGroupIds] = useState<Set<MaterialGroup["id"]>>(() => new Set());
  const [externalExpanded, setExternalExpanded] = useState(false);
  const model = useMemo(() => buildSourcesModel(files, course, activeTask), [activeTask, course, files]);
  const externalModel = useMemo(() => buildExternalSourcesModel(externalSources, files), [externalSources, files]);
  const visibleExternalSources = externalExpanded ? externalModel.sources : externalModel.sources.slice(0, EXTERNAL_SOURCE_PREVIEW_LIMIT);
  const scopeLabel = activeTask ? "当前作业" : course?.workspaceKind === "semester_home" ? "当前学期" : course ? "当前课程" : "工作区";
  const scopeName = activeTask?.title?.trim() || course?.name?.trim() || semester?.term?.trim() || "Brevyn";
  const internalCount = model.groups.reduce((count, group) => count + group.count, 0);
  const totalSourceCount = internalCount + externalModel.sources.length;
  const scopeHint = activeTask
    ? "作业材料优先，补充课程资料和外部来源"
    : course?.workspaceKind === "semester_home"
      ? "学期资料优先，补充本学期课程资料"
      : course
        ? "课程共享优先，补充课件和外部来源"
        : "请选择学期、课程或作业";

  useEffect(() => {
    if (!effectiveCollapsed) {
      setRenderContent(true);
      return;
    }
    const timeout = window.setTimeout(() => setRenderContent(false), 260);
    return () => window.clearTimeout(timeout);
  }, [effectiveCollapsed]);

  const canUseExternalSources = Boolean(course && course.workspaceKind !== "semester_home");
  const defaultExternalScope: ExternalSourceScope = activeTask ? "task" : "course";
  const loadExternalSources = useCallback(async () => {
    if (!course || course.workspaceKind === "semester_home") {
      setExternalSources([]);
      return;
    }
    setExternalLoading(true);
    setExternalError("");
    try {
      const sources = await window.brevyn.externalSources.list({ courseId: course.id, taskId: activeTask?.id });
      setExternalSources(sources);
    } catch (error) {
      setExternalError(error instanceof Error ? error.message : "外部来源加载失败。");
    } finally {
      setExternalLoading(false);
    }
  }, [activeTask?.id, course]);

  useEffect(() => {
    if (!renderContent) return;
    void loadExternalSources();
  }, [loadExternalSources, renderContent]);

  useEffect(() => {
    if (!renderContent) return;
    const unsubscribe = window.brevyn.files.onChanged(() => {
      void loadExternalSources();
    });
    return unsubscribe;
  }, [loadExternalSources, renderContent]);

  useEffect(() => {
    setExpandedGroupIds(new Set());
    setExternalExpanded(false);
  }, [activeTask?.id, course?.id]);

  function toggleMaterialGroup(groupId: MaterialGroup["id"]) {
    setExpandedGroupIds((current) => {
      const next = new Set(current);
      if (next.has(groupId)) next.delete(groupId);
      else next.add(groupId);
      return next;
    });
  }

  async function addUrl(input: { url: string; title?: string; scope: ExternalSourceScope }) {
    if (!course || course.workspaceKind === "semester_home") return;
    setAddBusy("url");
    setExternalError("");
    try {
      const result = await window.brevyn.externalSources.addUrl({
        courseId: course.id,
        taskId: activeTask?.id,
        scope: input.scope,
        url: input.url,
        title: input.title,
      });
      setExternalSources((current) => mergeSources(result.sources, current));
      const failedSource = result.sources.find((source) => source.status === "failed");
      if (failedSource || result.indexingError) {
        throw new Error(failedSource?.error || result.indexingError || "网页解析失败。");
      }
      setAddDialogOpen(false);
    } catch (error) {
      setExternalError(error instanceof Error ? error.message : "添加网页来源失败。");
      throw error;
    } finally {
      setAddBusy("");
    }
  }

  async function addFiles(scope: ExternalSourceScope = defaultExternalScope) {
    if (!course || course.workspaceKind === "semester_home") return;
    setAddBusy("file");
    setExternalError("");
    try {
      const result = await window.brevyn.externalSources.addFiles({ courseId: course.id, taskId: activeTask?.id, scope });
      if (result.sources.length > 0) setExternalSources((current) => mergeSources(result.sources, current));
    } catch (error) {
      setExternalError(error instanceof Error ? error.message : "添加文件来源失败。");
    } finally {
      setAddBusy("");
    }
  }

  async function deleteExternalSource(sourceId: string) {
    setAddBusy("delete");
    setExternalError("");
    try {
      await window.brevyn.externalSources.delete(sourceId);
      setExternalSources((current) => current.filter((source) => source.id !== sourceId));
    } catch (error) {
      setExternalError(error instanceof Error ? error.message : "移除外部来源失败。");
    } finally {
      setAddBusy("");
    }
  }

  async function retryExternalSource(sourceId: string) {
    setRetryingSourceIds((current) => new Set(current).add(sourceId));
    setExternalError("");
    try {
      const result = await window.brevyn.externalSources.retry(sourceId);
      if (result.sources.length > 0) setExternalSources((current) => mergeSources(result.sources, current));
      if (result.indexingError) setExternalError(result.indexingError);
      await loadExternalSources();
    } catch (error) {
      setExternalError(error instanceof Error ? error.message : "重试外部来源失败。");
    } finally {
      setRetryingSourceIds((current) => {
        const next = new Set(current);
        next.delete(sourceId);
        return next;
      });
    }
  }

  return (
    <aside
      aria-hidden={effectiveCollapsed}
      className={embedded
        ? "relative flex h-full min-h-0 flex-1 flex-col overflow-hidden bg-transparent"
        : `group/rail relative flex min-w-0 shrink-0 origin-right transform-gpu flex-col overflow-hidden rounded-lg border bg-card/85 shadow-sm ring-1 ring-border/60 will-change-[transform,opacity] transition-[opacity,transform,box-shadow,border-color] duration-300 ease-[cubic-bezier(0.22,1,0.36,1)] ${effectiveCollapsed ? "pointer-events-none w-full translate-x-6 border-transparent opacity-0 shadow-none ring-0" : "ml-2 w-[calc(100%-0.5rem)] translate-x-0 opacity-100"} ${resizing ? "select-none border-border/80 ring-foreground/10 transition-none" : ""}`}
    >
      {!embedded && onResizeStart && <RailResizeHandle collapsed={effectiveCollapsed} resizing={resizing} label="调整来源面板宽度" onResizeStart={onResizeStart} />}

      <div className={`flex min-h-0 flex-1 flex-col transition-opacity duration-150 ${effectiveCollapsed ? "opacity-0" : "opacity-100"}`}>
        {renderContent ? (
          <>
            <header className="border-b bg-[linear-gradient(135deg,hsl(var(--background)/0.72),hsl(var(--accent)/0.22))] px-4 py-3">
              <div className="flex items-center justify-between gap-3">
                <div className="min-w-0">
                  <div className="flex items-center gap-2 text-sm font-semibold text-foreground">
                    <BookMarked className="h-4 w-4" />
                    参考资料
                  </div>
                  <div className="mt-0.5 truncate text-[11px] text-muted-foreground" title={scopeName}>
                    {scopeName ? `${scopeLabel} · ${scopeName}` : scopeLabel}
                  </div>
                </div>
                <span className="shrink-0 rounded-full bg-foreground px-2.5 py-1 text-[10px] font-semibold text-background" title="当前范围资料总数">
                  {totalSourceCount}
                </span>
              </div>
              <div className="mt-2 flex min-w-0 items-center gap-2 rounded-md bg-background/50 px-2 py-1.5 text-[10px] text-muted-foreground ring-1 ring-border/35">
                <LockKeyhole className="h-3 w-3 shrink-0" />
                <span className="truncate">{scopeHint}</span>
              </div>
            </header>

            <div className="min-h-0 flex-1 overflow-y-auto p-3 brevyn-scrollbar">
              <section>
                <div className="mb-2 flex items-center justify-between gap-2 px-1">
                  <div className="flex items-center gap-2 text-xs font-semibold text-foreground">
                    <Check className="h-3.5 w-3.5" />
                    当前参考资料
                  </div>
                  <span className="text-[10px] text-muted-foreground">{internalCount} 个文件</span>
                </div>
                <div className="space-y-1.5">
                  {model.groups.length > 0 ? model.groups.map((group) => (
                    <MaterialSourceRow
                      key={group.id}
                      group={group}
                      expanded={expandedGroupIds.has(group.id)}
                      onToggleExpanded={() => toggleMaterialGroup(group.id)}
                      onPreviewFile={onPreviewFile}
                    />
                  )) : (
                    <EmptySourceRow label="当前范围还没有可用材料。" />
                  )}
                </div>
              </section>
              {canUseExternalSources && (
                <section className="mt-4">
                  <div className="mb-2 flex items-center justify-between gap-2 px-1">
                    <div className="flex items-center gap-2 text-xs font-semibold text-foreground">
                      <Globe2 className="h-3.5 w-3.5" />
                      外部来源
                    </div>
                    <div className="flex items-center gap-1">
                      {externalLoading && <Loader2 className="h-3.5 w-3.5 animate-spin text-muted-foreground" />}
                      <button
                        type="button"
                        className="inline-flex h-6 items-center gap-1 rounded-md bg-background px-2 text-[10px] font-medium text-muted-foreground shadow-sm ring-1 ring-border/70 transition hover:bg-accent hover:text-foreground disabled:opacity-50"
                        disabled={Boolean(addBusy)}
                        onClick={() => setAddDialogOpen(true)}
                      >
                        <Link2 className="h-3 w-3" />
                        网页
                      </button>
                      <button
                        type="button"
                        className="inline-flex h-6 items-center gap-1 rounded-md bg-background px-2 text-[10px] font-medium text-muted-foreground shadow-sm ring-1 ring-border/70 transition hover:bg-accent hover:text-foreground disabled:opacity-50"
                        disabled={Boolean(addBusy)}
                        onClick={() => void addFiles()}
                      >
                        <Plus className="h-3 w-3" />
                        文件
                      </button>
                    </div>
                  </div>
                  <div className={cx("space-y-1.5", externalExpanded && externalModel.sources.length > EXTERNAL_SOURCE_PREVIEW_LIMIT && "max-h-64 overflow-y-auto pr-1 brevyn-scrollbar")}>
                    {externalModel.sources.length > 0 ? visibleExternalSources.map((item) => (
                      <ExternalSourceRow
                        key={item.source.id}
                        item={item}
                        onPreviewFile={onPreviewFile}
                        onDelete={() => void deleteExternalSource(item.source.id)}
                        onRetry={() => void retryExternalSource(item.source.id)}
                        busy={addBusy === "delete"}
                        retrying={retryingSourceIds.has(item.source.id)}
                      />
                    )) : (
                      <EmptySourceRow label="还没有外部来源。可以添加网页链接，或选择 PDF、Word、PPT 等本地资料。" />
                    )}
                  </div>
                  {externalModel.sources.length > EXTERNAL_SOURCE_PREVIEW_LIMIT && (
                    <button
                      type="button"
                      className="mt-2 w-full rounded-md bg-background/58 px-2 py-1.5 text-[10px] font-medium text-muted-foreground ring-1 ring-border/45 transition hover:bg-accent hover:text-foreground"
                      onClick={() => setExternalExpanded((value) => !value)}
                    >
                      {externalExpanded ? "收起外部来源" : `展开 ${externalModel.sources.length - EXTERNAL_SOURCE_PREVIEW_LIMIT} 个外部来源`}
                    </button>
                  )}
                  {externalError && <div className="mt-2 rounded-md bg-destructive/10 px-2 py-1.5 text-[10px] text-destructive">{externalError}</div>}
                </section>
              )}
            </div>
            {addDialogOpen && canUseExternalSources && (
              <AddExternalSourceDialog
                defaultScope={defaultExternalScope}
                hasTask={Boolean(activeTask)}
                busy={addBusy === "url"}
                onClose={() => setAddDialogOpen(false)}
                onSubmit={addUrl}
              />
            )}
          </>
        ) : null}
      </div>
    </aside>
  );
}

function ExternalSourceRow({
  item,
  onPreviewFile,
  onDelete,
  onRetry,
  busy,
  retrying,
}: {
  item: ExternalSourceViewItem;
  onPreviewFile?: (file: WorkspaceFileNode) => void;
  onDelete: () => void;
  onRetry: () => void;
  busy?: boolean;
  retrying?: boolean;
}) {
  const { source, file } = item;
  const Icon = source.kind === "web" ? Link2 : Paperclip;
  const label = source.kind === "web" ? "网页" : file ? fileKindLabel(file.kind) : "文件";
  const indexStatus = externalIndexStatus(source.status, file);
  const detail = sourceStatusDetail(source, file);
  const showRetry = source.status === "failed" || file?.indexingStatus === "failed" || file?.indexingStatus === "cancelled" || indexStatus === "idle";
  const canPreview = Boolean(file && onPreviewFile);
  const preview = () => {
    if (file) onPreviewFile?.(file);
  };
  return (
    <div
      role={canPreview ? "button" : undefined}
      tabIndex={canPreview ? 0 : undefined}
      className={cx(
        "rounded-[var(--radius-card)] bg-background/58 px-3 py-2.5 shadow-[inset_0_0_0_1px_hsl(var(--border)/0.34)] ring-1 ring-foreground/[0.03] transition",
        canPreview && "cursor-pointer hover:bg-accent/45 hover:shadow-[inset_0_0_0_1px_hsl(var(--border)/0.58)]",
      )}
      onClick={preview}
      onKeyDown={(event) => {
        if (!canPreview) return;
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          preview();
        }
      }}
      title={canPreview ? "点击预览" : undefined}
    >
      <div className="flex items-start justify-between gap-3">
        <div className="flex min-w-0 items-start gap-2">
          <span className={cx("mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-[var(--radius-control)]", sourceIconTone(source.kind === "web" ? "web" : "external-file"))}>
            <Icon className="h-3.5 w-3.5" />
          </span>
          <div className="min-w-0">
            <div className="truncate text-xs font-semibold text-foreground" title={source.title}>{source.title}</div>
            <div className="mt-0.5 truncate text-[10px] text-muted-foreground">
              {label} · {source.scope === "task" ? "当前作业" : "当前课程"}
            </div>
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-1.5">
          <SourceStatusBadge status={indexStatus} />
          {showRetry && (
            <button
              type="button"
              className="flex h-6 w-6 shrink-0 items-center justify-center rounded-md text-muted-foreground transition hover:bg-accent hover:text-foreground disabled:cursor-wait disabled:opacity-50"
              disabled={retrying}
              onClick={(event) => {
                event.stopPropagation();
                onRetry();
              }}
              title={source.status === "failed" ? "重新读取并索引" : "重新索引"}
            >
              {retrying ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <RefreshCw className="h-3.5 w-3.5" />}
            </button>
          )}
          <button
            type="button"
            className="flex h-6 w-6 shrink-0 items-center justify-center rounded-md text-muted-foreground transition hover:bg-destructive/10 hover:text-destructive disabled:opacity-50"
            disabled={busy}
            onClick={(event) => {
              event.stopPropagation();
              onDelete();
            }}
            title="移除外部来源"
          >
            <Trash2 className="h-3.5 w-3.5" />
          </button>
        </div>
      </div>
      {(source.summary || source.url) && (
        <div className="mt-2 line-clamp-2 text-[10px] leading-4 text-muted-foreground">
          {source.summary || source.url}
        </div>
      )}
      {detail && (
        <div className={cx(
          "mt-2 rounded-md px-2 py-1.5 text-[10px] leading-4",
          indexStatus === "failed" ? "bg-destructive/10 text-destructive" : "bg-foreground/[0.035] text-muted-foreground",
        )}>
          {detail}
        </div>
      )}
    </div>
  );
}

function AddExternalSourceDialog({
  defaultScope,
  hasTask,
  busy,
  onClose,
  onSubmit,
}: {
  defaultScope: ExternalSourceScope;
  hasTask: boolean;
  busy: boolean;
  onClose: () => void;
  onSubmit: (input: { url: string; title?: string; scope: ExternalSourceScope }) => Promise<void>;
}) {
  const [url, setUrl] = useState("");
  const [title, setTitle] = useState("");
  const [scope, setScope] = useState<ExternalSourceScope>(defaultScope);
  const [error, setError] = useState("");
  async function submit(event: FormEvent) {
    event.preventDefault();
    setError("");
    try {
      await onSubmit({ url, title, scope });
    } catch (submitError) {
      setError(submitError instanceof Error ? submitError.message : "添加失败。");
    }
  }
  return (
    <div className="absolute inset-0 z-20 flex items-start justify-center bg-background/62 px-4 pt-20 backdrop-blur-sm">
      <form className="w-full rounded-[var(--radius-panel)] border bg-card p-4 shadow-xl ring-1 ring-border/70" onSubmit={submit}>
        <div className="flex items-start justify-between gap-3">
          <div>
            <div className="text-sm font-semibold text-foreground">添加网页来源</div>
            <p className="mt-1 text-[11px] leading-5 text-muted-foreground">网页会保存为本地资料，并进入当前范围的参考资料。</p>
          </div>
          <button type="button" className="flex h-7 w-7 items-center justify-center rounded-md text-muted-foreground transition hover:bg-accent hover:text-foreground" onClick={onClose}>
            <X className="h-3.5 w-3.5" />
          </button>
        </div>
        <label className="mt-4 block text-[11px] font-medium text-muted-foreground">
          网页链接
          <input
            value={url}
            onChange={(event) => setUrl(event.target.value)}
            placeholder="https://..."
            className="mt-1 h-9 w-full rounded-[var(--radius-control)] border bg-background px-3 text-xs text-foreground outline-none transition focus:ring-2 focus:ring-ring/25"
          />
        </label>
        <label className="mt-3 block text-[11px] font-medium text-muted-foreground">
          标题（可选）
          <input
            value={title}
            onChange={(event) => setTitle(event.target.value)}
            placeholder="自动读取网页标题"
            className="mt-1 h-9 w-full rounded-[var(--radius-control)] border bg-background px-3 text-xs text-foreground outline-none transition focus:ring-2 focus:ring-ring/25"
          />
        </label>
        <div className="mt-3">
          <div className="text-[11px] font-medium text-muted-foreground">保存范围</div>
          <div className="mt-1 grid grid-cols-2 gap-1 rounded-[var(--radius-control)] bg-muted/55 p-1">
            {hasTask && <ScopeButton active={scope === "task"} label="当前作业" onClick={() => setScope("task")} />}
            <ScopeButton active={scope === "course"} label="当前课程" onClick={() => setScope("course")} />
          </div>
        </div>
        {error && <div className="mt-3 rounded-md bg-destructive/10 px-2 py-1.5 text-[10px] text-destructive">{error}</div>}
        <div className="mt-4 flex justify-end gap-2">
          <button type="button" className="h-8 rounded-[var(--radius-control)] px-3 text-xs text-muted-foreground transition hover:bg-accent hover:text-foreground" onClick={onClose}>取消</button>
          <button type="submit" disabled={busy || !url.trim()} className="inline-flex h-8 items-center gap-2 rounded-[var(--radius-control)] bg-foreground px-3 text-xs font-medium text-background disabled:opacity-50">
            {busy && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
            添加并解析
          </button>
        </div>
      </form>
    </div>
  );
}

function ScopeButton({ active, label, onClick }: { active: boolean; label: string; onClick: () => void }) {
  return (
    <button type="button" className={cx("h-7 rounded-md text-[11px] font-medium transition", active ? "bg-background text-foreground shadow-sm" : "text-muted-foreground hover:text-foreground")} onClick={onClick}>
      {label}
    </button>
  );
}

function MaterialSourceRow({
  group,
  expanded,
  onToggleExpanded,
  onPreviewFile,
}: {
  group: MaterialGroup;
  expanded: boolean;
  onToggleExpanded: () => void;
  onPreviewFile?: (file: WorkspaceFileNode) => void;
}) {
  const Icon = group.id === "lecture" ? Layers3 : group.id === "task" ? FileText : LibraryBig;
  const { fileGroups: visibleFileGroups, hiddenCount, expandable } = useMemo(
    () => groupFilesForSourceRow(group, expanded),
    [group, expanded],
  );
  const detail = materialGroupDetail(group);
  return (
    <div className="rounded-[var(--radius-card)] bg-background/58 px-3 py-2.5 shadow-[inset_0_0_0_1px_hsl(var(--border)/0.34)] ring-1 ring-foreground/[0.03]">
      <div className="flex items-center justify-between gap-3">
        <div className="flex min-w-0 items-center gap-2">
          <span className={cx("flex h-8 w-8 shrink-0 items-center justify-center rounded-[var(--radius-control)]", sourceIconTone(group.id))}>
            <Icon className="h-3.5 w-3.5" />
          </span>
          <div className="min-w-0">
            <div className="truncate text-xs font-semibold text-foreground">{group.title}</div>
            <div className="mt-0.5 truncate text-[10px] text-muted-foreground">{group.description} · {group.count} 个文件</div>
          </div>
        </div>
        <SourceStatusBadge status={group.status} />
      </div>
      <div className="mt-2 flex items-center justify-between gap-2 text-[10px] text-muted-foreground">
        <span className="truncate">已索引 {group.indexedCount} 个</span>
        <span className="shrink-0">{group.indexedCount}/{group.count || 0}</span>
      </div>
      {detail && (
        <div className={cx(
          "mt-2 rounded-md px-2 py-1.5 text-[10px] leading-4",
          group.status === "failed" ? "bg-destructive/10 text-destructive" : "bg-foreground/[0.035] text-muted-foreground",
        )}>
          {detail}
        </div>
      )}
      {group.files.length > 0 ? (
        <div className={cx("mt-2 space-y-1", expanded && group.files.length > MATERIAL_PREVIEW_LIMIT_PER_GROUP && "max-h-48 overflow-y-auto pr-1 brevyn-scrollbar")}>
          {visibleFileGroups.map((fileGroup) => (
            <div key={fileGroup.id} className="space-y-1">
              {fileGroup.label && (
                <div className="flex items-center gap-2 px-1 pt-1 text-[10px] font-semibold text-muted-foreground">
                  <span className="h-px min-w-3 flex-1 bg-border/65" />
                  <span className="shrink-0">{fileGroup.label} · {fileGroup.totalCount} 个</span>
                  <span className="h-px min-w-3 flex-1 bg-border/65" />
                </div>
              )}
              {fileGroup.files.map((file) => (
                <SourceFileButton key={file.id} file={file} onPreviewFile={onPreviewFile} />
              ))}
            </div>
          ))}
          {expandable && (
            <button
              type="button"
              className="w-full rounded-md px-2 py-1 text-left text-[10px] font-medium text-muted-foreground transition hover:bg-accent hover:text-foreground"
              onClick={onToggleExpanded}
            >
              {expanded ? "收起资料" : `展开 ${hiddenCount} 个资料`}
            </button>
          )}
        </div>
      ) : (
        <div className="mt-2 rounded-md border border-dashed border-border/50 bg-card/28 px-2 py-2 text-[10px] text-muted-foreground">
          这个分区还没有资料。
        </div>
      )}
    </div>
  );
}

function SourceFileButton({ file, onPreviewFile }: { file: WorkspaceFileNode; onPreviewFile?: (file: WorkspaceFileNode) => void }) {
  return (
    <button
      type="button"
      className={cx(
        "flex w-full min-w-0 items-center gap-2 rounded-md bg-card/54 px-2 py-1.5 text-left text-[11px] transition",
        onPreviewFile && "hover:bg-accent hover:text-foreground",
      )}
      onClick={() => onPreviewFile?.(file)}
      title="点击预览"
    >
      <FileTypeIcon name={fileDisplayName(file)} size={15} className="shrink-0" />
      <span className="min-w-0 flex-1 truncate text-foreground/88" title={fileDisplayName(file)}>
        {fileDisplayName(file)}
      </span>
      <FileTypeBadge name={fileDisplayName(file)} kind={file.kind} />
      <span className="shrink-0 text-[10px] text-muted-foreground">{fileMetaLabel(file)}</span>
    </button>
  );
}

function groupFilesForSourceRow(
  group: MaterialGroup,
  expanded: boolean,
): { fileGroups: Array<{ id: string; label?: string; files: WorkspaceFileNode[]; totalCount: number }>; hiddenCount: number; expandable: boolean } {
  if (group.id !== "lecture") {
    const files = expanded ? group.files : group.files.slice(0, MATERIAL_PREVIEW_LIMIT_PER_GROUP);
    return {
      fileGroups: [{ id: group.id, files, totalCount: group.files.length }],
      hiddenCount: Math.max(0, group.files.length - files.length),
      expandable: group.files.length > MATERIAL_PREVIEW_LIMIT_PER_GROUP,
    };
  }
  const byWeek = new Map<string, { id: string; order: number; label: string; files: WorkspaceFileNode[] }>();
  for (const file of group.files) {
    const weekNumber = typeof file.weekNumber === "number" && Number.isFinite(file.weekNumber) ? file.weekNumber : 0;
    const id = weekNumber > 0 ? `week-${weekNumber}` : "unassigned";
    const label = weekNumber > 0 ? `Week ${weekNumber}` : "未分周";
    const order = weekNumber > 0 ? weekNumber : Number.MAX_SAFE_INTEGER;
    const current = byWeek.get(id) || { id, order, label, files: [] };
    current.files.push(file);
    byWeek.set(id, current);
  }
  let hiddenCount = 0;
  const fileGroups = Array.from(byWeek.values())
    .sort((a, b) => a.order - b.order)
    .map(({ id, label, files }) => {
      const visibleFiles = expanded ? files : files.slice(0, MATERIAL_PREVIEW_LIMIT_PER_GROUP);
      hiddenCount += Math.max(0, files.length - visibleFiles.length);
      return { id, label, files: visibleFiles, totalCount: files.length };
    })
    .filter((fileGroup) => fileGroup.files.length > 0);
  return { fileGroups, hiddenCount, expandable: Array.from(byWeek.values()).some((fileGroup) => fileGroup.files.length > MATERIAL_PREVIEW_LIMIT_PER_GROUP) };
}

function EmptySourceRow({ label }: { label: string }) {
  return (
    <div className="rounded-[var(--radius-card)] border border-dashed border-border/60 bg-background/34 px-3 py-3 text-[11px] leading-5 text-muted-foreground">
      {label}
    </div>
  );
}

function SourceStatusBadge({ status }: { status: MaterialGroup["status"] }) {
  const label = status === "indexed" ? "可检索" : status === "partial" ? "部分可检索" : status === "processing" ? "处理中" : status === "failed" ? "失败" : "待索引";
  const icon = status === "indexed"
    ? <CheckCircle2 className="h-3 w-3" />
    : status === "processing"
      ? <Loader2 className="h-3 w-3 animate-spin" />
      : status === "partial"
        ? <CircleDashed className="h-3 w-3" />
        : status === "failed"
          ? <X className="h-3 w-3" />
          : <Search className="h-3 w-3" />;
  return (
    <span
      className={cx(
        "inline-flex shrink-0 items-center gap-1 rounded-full px-2 py-1 text-[10px] font-medium",
        status === "indexed" && "bg-[hsl(var(--status-success)/0.14)] text-[hsl(var(--status-success))]",
        status === "partial" && "bg-[hsl(var(--status-warning)/0.14)] text-[hsl(var(--status-warning))]",
        status === "processing" && "bg-[hsl(var(--status-info)/0.12)] text-[hsl(var(--status-info))]",
        status === "failed" && "bg-destructive/10 text-destructive",
        status === "idle" && "bg-muted text-muted-foreground",
      )}
    >
      {icon}
      {label}
    </span>
  );
}

function sourceIconTone(tone: MaterialGroup["id"] | "scope" | "web" | "external-file"): string {
  if (tone === "scope" || tone === "semester") {
    return "bg-[hsl(var(--primary)/0.13)] text-[hsl(var(--primary))] shadow-[inset_0_0_0_1px_hsl(var(--primary)/0.24)]";
  }
  if (tone === "task" || tone === "external-file") {
    return "bg-[hsl(var(--status-warning)/0.13)] text-[hsl(var(--status-warning))] shadow-[inset_0_0_0_1px_hsl(var(--status-warning)/0.24)]";
  }
  if (tone === "course" || tone === "web") {
    return "bg-[hsl(var(--status-info)/0.13)] text-[hsl(var(--status-info))] shadow-[inset_0_0_0_1px_hsl(var(--status-info)/0.24)]";
  }
  return "bg-[hsl(var(--status-success)/0.13)] text-[hsl(var(--status-success))] shadow-[inset_0_0_0_1px_hsl(var(--status-success)/0.24)]";
}

function buildSourcesModel(files: WorkspaceFileNode[], course?: Course, activeTask?: BrevynTask): { groups: MaterialGroup[] } {
  const leafFiles = flattenFiles(files).filter(isUsableSourceFile).filter((file) => !isExternalSourceFile(file));
  if (course?.workspaceKind === "semester_home") {
    return {
      groups: [
        materialGroup("semester", "学期资料", "学期共享资料", leafFiles.filter((file) => file.courseId === course.id && file.sectionKind === "course_shared")),
        materialGroup("course", "课程资料", "本学期课程文件", leafFiles.filter((file) => file.courseId !== course.id)),
      ],
    };
  }

  const groups: MaterialGroup[] = [];
  if (activeTask) {
    groups.push(materialGroup("task", "作业材料", "任务说明、评分标准、指定阅读", leafFiles.filter((file) => file.taskId === activeTask.id && file.taskFileBucket === "materials")));
  }
  groups.push(
    materialGroup("course", "课程共享", "课程长期资料", leafFiles.filter((file) => file.sectionKind === "course_shared" && !file.taskId)),
    materialGroup("lecture", "课件", "课堂讲义与 PPT", leafFiles.filter((file) => file.sectionKind === "lecture")),
  );
  return { groups };
}

function materialGroup(id: MaterialGroup["id"], title: string, description: string, files: WorkspaceFileNode[]): MaterialGroup {
  const indexedCount = files.filter(isIndexedFile).length;
  const failed = files.some((file) => file.indexingStatus === "failed" || file.indexingStatus === "cancelled");
  const processing = files.some((file) => file.indexingStatus === "queued" || file.indexingStatus === "indexing");
  const partial = files.some((file) => file.indexingStatus === "partial" || file.indexingStatus === "warning" || file.indexingStatus === "skipped") || (indexedCount > 0 && indexedCount < files.length);
  return {
    id,
    title,
    description,
    count: files.length,
    indexedCount,
    status: failed ? "failed" : processing ? "processing" : files.length > 0 && indexedCount === files.length ? "indexed" : partial ? "partial" : "idle",
    files: [...files].sort((a, b) => new Date(b.updatedAt || 0).getTime() - new Date(a.updatedAt || 0).getTime()),
  };
}

function buildExternalSourcesModel(sources: ExternalSource[], files: WorkspaceFileNode[]): { sources: ExternalSourceViewItem[] } {
  const allFiles = flattenFiles(files);
  const byId = new Map(allFiles.map((file) => [file.id, file]));
  return {
    sources: sources.map((source) => ({
      source,
      file: source.workspaceFileId ? byId.get(source.workspaceFileId) : undefined,
    })),
  };
}

function isUsableSourceFile(file: WorkspaceFileNode): boolean {
  if (file.kind === "folder") return false;
  if (file.ragEligible === false) return false;
  return file.sourceKind !== "agent_generated" && file.sourceKind !== "system";
}

function isExternalSourceFile(file: WorkspaceFileNode): boolean {
  return file.path.includes("/External Sources/") || file.sourcePath?.includes("/External Sources/") === true;
}

function isIndexedFile(file: WorkspaceFileNode): boolean {
  return Boolean(file.indexedAt || file.indexingStatus === "indexed" || file.indexingStatus === "partial" || file.indexingStatus === "warning");
}

function fileMetaLabel(file: WorkspaceFileNode): string {
  if (file.indexingStatus === "queued" || file.indexingStatus === "indexing") return "处理中";
  if (file.indexingStatus === "failed" || file.indexingStatus === "cancelled") return "失败";
  if (isIndexedFile(file)) return "已索引";
  return file.sizeLabel || fileKindLabel(file.kind);
}

function fileKindLabel(kind: WorkspaceFileNode["kind"]): string {
  if (kind === "pdf") return "PDF";
  if (kind === "docx") return "Word";
  if (kind === "pptx") return "PPT";
  if (kind === "spreadsheet") return "表格";
  if (kind === "image") return "图片";
  if (kind === "markdown") return "Markdown";
  if (kind === "code") return "代码";
  if (kind === "text") return "文本";
  return "文件";
}

function externalIndexStatus(status: ExternalSource["status"], file?: WorkspaceFileNode): MaterialGroup["status"] {
  if (status === "failed" || file?.indexingStatus === "failed" || file?.indexingStatus === "cancelled") return "failed";
  if (file?.indexingStatus === "queued" || file?.indexingStatus === "indexing" || status === "processing") return "processing";
  if (file?.indexingStatus === "partial" || file?.indexingStatus === "warning" || file?.indexingStatus === "skipped") return "partial";
  if (file && isIndexedFile(file)) return "indexed";
  return "idle";
}

function sourceStatusDetail(source: ExternalSource, file?: WorkspaceFileNode): string {
  if (source.error) return source.error;
  if (file?.indexingError) return file.indexingError;
  if (file?.indexingWarning) return file.indexingWarning;
  if (file?.indexingStatus === "queued") return progressLabel("等待进入知识库", file.indexingProgress);
  if (file?.indexingStatus === "indexing") return progressLabel("正在解析并索引", file.indexingProgress);
  if (file?.indexingStatus === "partial") return file.indexingParserDetail ? `部分内容已可检索，${file.indexingParserDetail}` : "部分内容已可检索，仍有少量内容未成功解析。";
  if (file?.indexingStatus === "warning") return "已可检索，但解析时有提醒。";
  if (file?.indexingStatus === "skipped") return "没有提取到可检索正文，可以换文件格式或重新添加。";
  if (source.status === "processing") return "正在读取来源内容。";
  if (source.status === "ready" && !file) return "来源已保存，但还没有可检索文件记录。";
  if (file && !isIndexedFile(file)) return "已保存，等待加入知识库后才能被 agent 检索。";
  return "";
}

function materialGroupDetail(group: MaterialGroup): string {
  const failed = group.files.find((file) => file.indexingStatus === "failed" || file.indexingStatus === "cancelled");
  if (failed) return failed.indexingError || `${fileDisplayName(failed)} 索引失败，可以在文件浏览器里重新索引。`;
  const warning = group.files.find((file) => file.indexingWarning || file.indexingStatus === "partial" || file.indexingStatus === "warning" || file.indexingStatus === "skipped");
  if (warning) return warning.indexingWarning || `${fileDisplayName(warning)} 只有部分内容可检索。`;
  const processing = group.files.find((file) => file.indexingStatus === "queued" || file.indexingStatus === "indexing");
  if (processing) return progressLabel(`${fileDisplayName(processing)} 正在进入知识库`, processing.indexingProgress);
  if (group.status === "idle" && group.count > 0) return "这些资料还没有进入知识库，agent 暂时不能用 RAG 检索它们。";
  return "";
}

function progressLabel(label: string, progress?: number): string {
  if (typeof progress === "number" && Number.isFinite(progress)) return `${label} · ${Math.round(progress)}%`;
  return label;
}

function mergeSources(incoming: ExternalSource[], current: ExternalSource[]): ExternalSource[] {
  const byId = new Map<string, ExternalSource>();
  for (const source of incoming) byId.set(source.id, source);
  for (const source of current) if (!byId.has(source.id)) byId.set(source.id, source);
  return Array.from(byId.values()).sort((a, b) => Date.parse(b.updatedAt || "") - Date.parse(a.updatedAt || ""));
}

function flattenFiles(nodes: WorkspaceFileNode[]): WorkspaceFileNode[] {
  const result: WorkspaceFileNode[] = [];
  const visit = (node: WorkspaceFileNode) => {
    result.push(node);
    for (const child of node.children || []) visit(child);
  };
  for (const node of nodes) visit(node);
  return result;
}
