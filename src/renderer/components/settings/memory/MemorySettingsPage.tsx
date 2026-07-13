import { BookOpenText, Brain, Check, CheckCircle2, Copy, FileText, Folder, FolderOpen, GraduationCap, ListTree, Plus, RefreshCw, Save } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { Markdownish } from "@/components/chat/Markdownish";
import { ActionButton, MiniMetric } from "@/components/settings/shared/SettingsControls";
import { DropdownSelect, type DropdownOption } from "@/components/ui/DropdownSelect";
import { cx } from "@/lib/cn";
import type { WorkspaceMemoryFileContent, WorkspaceMemoryFileKind, WorkspaceMemoryFileNode, WorkspaceMemoryScopeOption, WorkspaceMemorySummary } from "../../../../types/domain";

const DEFAULT_MEMORY_TEXT: Record<WorkspaceMemoryFileKind, string> = {
  claude: [
    "# CLAUDE.md",
    "",
    "## 工作区规则",
    "",
    "- 在这里记录长期有效的写作偏好、项目规则和可复用流程。",
    "- 不要记录课程事实、rubric、截止日期、成绩或阅读摘要。",
  ].join("\n"),
  auto: [
    "# MEMORY.md",
    "",
    "## 索引",
    "",
    "- 这里是 Claude Agent SDK 的 auto memory 入口。",
    "- 适合记录稳定偏好、反复出现的工作方式和未来 Agent 容易重复犯的错误。",
  ].join("\n"),
};

export function MemorySettingsPage() {
  const pageRef = useRef<HTMLDivElement>(null);
  const [summary, setSummary] = useState<WorkspaceMemorySummary | null>(null);
  const [scopeId, setScopeId] = useState("semester");
  const [selectedKind, setSelectedKind] = useState<WorkspaceMemoryFileKind>("claude");
  const [selectedAutoPath, setSelectedAutoPath] = useState("MEMORY.md");
  const [viewMode, setViewMode] = useState<"edit" | "preview">("preview");
  const [loadedFile, setLoadedFile] = useState<WorkspaceMemoryFileContent | null>(null);
  const [draft, setDraft] = useState("");
  const [newAutoPath, setNewAutoPath] = useState("");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [statusLine, setStatusLine] = useState("");
  const [emptyReason, setEmptyReason] = useState("");

  const selectedInfo = loadedFile || (selectedKind === "claude" ? summary?.claudeMd : summary?.autoMemoryIndex);
  const isDirty = loadedFile?.kind === selectedKind && loadedFile.relativePath === selectedRelativePath(selectedKind, selectedAutoPath) && draft !== loadedFile.content;
  const scopeOptions = useMemo<DropdownOption[]>(() => (
    summary?.scopes.map((scope) => ({
      value: scope.id,
      label: scope.label,
      detail: scope.detail,
      icon: scope.kind === "semester" ? <GraduationCap className="h-3.5 w-3.5" /> : <ListTree className="h-3.5 w-3.5" />,
    })) || [{ value: "semester", label: "学期共享", detail: "学期总览记忆" }]
  ), [summary?.scopes]);

  const metrics = useMemo(() => {
    if (!summary) return [];
    return [
      { label: "作用域", value: summary.scopeName },
      { label: "CLAUDE.md", value: summary.claudeMd.exists ? formatBytes(summary.claudeMd.size) : "未创建" },
      { label: "Auto Memory", value: `${countMemoryFiles(summary.autoMemoryFiles)} 个文件` },
    ];
  }, [summary]);

  useEffect(() => {
    void refresh(scopeId, selectedKind);
  }, []);

  async function refresh(nextScopeId = scopeId, kind = selectedKind) {
    setLoading(true);
    setStatusLine("");
    try {
      const nextSummary = await window.brevyn.memory.summary(nextScopeId);
      setEmptyReason("");
      setSummary(nextSummary);
      setScopeId(nextSummary.scopeId);
      await loadFile(nextSummary.scopeId, kind, kind === "auto" ? selectedAutoPath : undefined, nextSummary);
    } catch (error) {
      const message = errorMessage(error);
      setSummary(null);
      setLoadedFile(null);
      setDraft("");
      if (isMissingSemesterMessage(message)) {
        setEmptyReason("请先创建或选择一个学期。");
      } else {
        setStatusLine(`加载记忆失败：${message}`);
      }
    } finally {
      setLoading(false);
    }
  }

  async function loadFile(nextScopeId: string, kind: WorkspaceMemoryFileKind, relativePath?: string, knownSummary?: WorkspaceMemorySummary) {
    setStatusLine("");
    try {
      if (!knownSummary && !summary) setLoading(true);
      const file = await window.brevyn.memory.readFile({ scopeId: nextScopeId, kind, relativePath });
      setLoadedFile(file);
      setDraft(file.content || DEFAULT_MEMORY_TEXT[kind]);
      if (kind === "auto") setSelectedAutoPath(file.relativePath || "MEMORY.md");
    } catch (error) {
      setStatusLine(`读取文件失败：${errorMessage(error)}`);
    } finally {
      setLoading(false);
    }
  }

  async function saveFile() {
    setSaving(true);
    setStatusLine("");
    try {
      const file = await window.brevyn.memory.writeFile({ scopeId, kind: selectedKind, relativePath: selectedKind === "auto" ? selectedAutoPath : undefined, content: draft });
      setLoadedFile(file);
      setSummary(await window.brevyn.memory.summary(scopeId));
      if (selectedKind === "auto") setSelectedAutoPath(file.relativePath || "MEMORY.md");
      setStatusLine("记忆已保存");
    } catch (error) {
      setStatusLine(`保存失败：${errorMessage(error)}`);
    } finally {
      setSaving(false);
    }
  }

  async function reveal(path: string | undefined) {
    try {
      if (!path) throw new Error("路径不可用。");
      await window.brevyn.app.revealPath(path);
    } catch (error) {
      setStatusLine(`打开目录失败：${errorMessage(error)}`);
    }
  }

  function selectTab(kind: WorkspaceMemoryFileKind) {
    if (kind === selectedKind) return;
    if (isDirty) {
      setStatusLine("当前内容还没保存，保存后再切换。");
      return;
    }
    setSelectedKind(kind);
    void loadFile(scopeId, kind, kind === "auto" ? selectedAutoPath : undefined);
  }

  function selectAutoFile(relativePath: string) {
    if (selectedKind === "auto" && relativePath === selectedAutoPath) return;
    if (isDirty) {
      setStatusLine("当前内容还没保存，保存后再切换文件。");
      return;
    }
    setSelectedKind("auto");
    setSelectedAutoPath(relativePath);
    void loadFile(scopeId, "auto", relativePath);
  }

  function createAutoFile() {
    const path = normalizeNewAutoPath(newAutoPath);
    if (!path) {
      setStatusLine("请输入记忆文件名。");
      return;
    }
    if (isDirty) {
      setStatusLine("当前内容还没保存，保存后再新建文件。");
      return;
    }
    setSelectedKind("auto");
    setSelectedAutoPath(path);
    setLoadedFile({
      kind: "auto",
      relativePath: path,
      path: summary?.autoMemoryDir ? `${summary.autoMemoryDir}/${path}` : path,
      exists: false,
      size: 0,
      content: "",
    });
    setDraft(defaultAutoMemoryFileText(path));
    setNewAutoPath("");
    setStatusLine("");
  }

  function selectScope(nextScopeId: string) {
    if (nextScopeId === scopeId) return;
    if (isDirty) {
      setStatusLine("当前内容还没保存，保存后再切换作用域。");
      return;
    }
    resetSettingsScrollPosition(pageRef.current);
    void refresh(nextScopeId, selectedKind).finally(() => resetSettingsScrollPosition(pageRef.current));
  }

  if (emptyReason) {
    return (
      <div className="mx-auto flex max-w-5xl flex-col gap-4">
        <section className="settings-solid-card rounded-[var(--radius-panel)] p-4">
          <div className="flex items-center gap-2 text-sm font-semibold text-foreground">
            <Brain className="h-4 w-4 text-muted-foreground" />
            <span>工作区记忆</span>
          </div>
          <div className="mt-1 max-w-2xl text-[12px] leading-5 text-muted-foreground">
            Agent 会读取当前学期共享空间里的长期规则和 SDK 自动记忆。
          </div>
        </section>
        <section className="settings-solid-card flex min-h-[360px] items-center justify-center rounded-[var(--radius-panel)] p-6">
          <div className="max-w-sm text-center">
            <div className="mx-auto flex h-10 w-10 items-center justify-center rounded-[var(--radius-card)] bg-muted text-muted-foreground">
              <GraduationCap className="h-5 w-5" />
            </div>
            <div className="mt-3 text-sm font-semibold text-foreground">还没有可用的学期</div>
            <div className="mt-1 text-[12px] leading-5 text-muted-foreground">{emptyReason}</div>
            <ActionButton
              icon={<RefreshCw className={cx("h-3.5 w-3.5", loading && "animate-spin")} />}
              label="刷新"
              onClick={() => void refresh(scopeId)}
              disabled={loading}
              className="mt-4"
            />
          </div>
        </section>
      </div>
    );
  }

  return (
    <div ref={pageRef} className="flex h-full min-h-0 w-full min-w-0 flex-col gap-3 overflow-hidden [overflow-anchor:none]">
      <section className="settings-solid-card shrink-0 overflow-hidden rounded-[var(--radius-panel)] p-4">
        <div className="grid min-h-[86px] min-w-0 grid-rows-[auto_auto] gap-3">
          <div className="min-w-0">
            <div className="flex items-center gap-2 text-sm font-semibold text-foreground">
              <Brain className="h-4 w-4 text-muted-foreground" />
              <span>工作区记忆</span>
            </div>
            <div className="mt-1 max-w-2xl text-[12px] leading-5 text-muted-foreground">
              Agent 会读取当前学期共享空间里的长期规则和 SDK 自动记忆；课程事实仍以 Brevyn 资料、文件和 RAG 为准。
            </div>
          </div>
          <div className="flex min-w-0 flex-wrap items-center gap-2">
            <div className="flex h-8 shrink-0 items-center gap-2 rounded-[var(--radius-control)] bg-muted px-2">
              <span className="shrink-0 text-[11px] font-medium text-muted-foreground">记忆范围</span>
              <DropdownSelect
                value={scopeId}
                options={scopeOptions}
                onChange={selectScope}
                ariaLabel="选择记忆作用域"
                className="shrink-0"
                menuWidth={210}
                menuMaxVisibleItems={7}
                menuItemHeight={38}
                showSelectedCheck={false}
                buttonClassName="h-7 w-[210px] shrink-0 bg-background px-2"
                renderValue={(option) => (
                  <span className="flex min-w-0 items-center gap-2">
                    {option?.icon}
                    <span className="min-w-0 truncate">{option?.label || "选择记忆作用域"}</span>
                  </span>
                )}
              />
            </div>
            <div className="inline-flex h-8 shrink-0 items-center gap-1.5 rounded-[var(--radius-control)] bg-[hsl(var(--status-success)/0.14)] px-2.5 text-[11px] font-semibold text-[hsl(var(--status-success))] shadow-sm ring-1 ring-[hsl(var(--status-success)/0.2)]">
              <CheckCircle2 className="h-3.5 w-3.5" />
              已启用
            </div>
          </div>
        </div>

        <div className="mt-4 grid min-w-0 auto-rows-[60px] gap-2 md:grid-cols-3">
          {metrics.map((metric) => (
            <MiniMetric key={metric.label} label={metric.label} value={metric.value} />
          ))}
        </div>

        <div className="mt-3 grid min-w-0 auto-rows-[58px] gap-2 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
          <PathRow label="工作区" value={summary?.workspacePath || "加载中"} />
          <PathRow label="Auto Memory" value={summary?.autoMemoryDir || "加载中"} />
        </div>
      </section>

      <section className="settings-solid-card flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden rounded-[var(--radius-panel)] p-4">
        <div className="flex min-h-8 shrink-0 flex-wrap items-center justify-between gap-3">
          <div className="text-sm font-semibold text-foreground">记忆文件</div>
          <div className="flex flex-wrap items-center gap-2">
            <ActionButton icon={<FolderOpen className="h-3.5 w-3.5" />} label="显示工作区" onClick={() => void reveal(summary?.workspacePath)} />
            <ActionButton icon={<FolderOpen className="h-3.5 w-3.5" />} label="显示记忆目录" onClick={() => void reveal(summary?.autoMemoryDir)} />
            <ActionButton icon={<RefreshCw className={cx("h-3.5 w-3.5", loading && "animate-spin")} />} label="刷新" onClick={() => void refresh(scopeId)} disabled={loading || saving} />
            <ActionButton icon={<Save className="h-3.5 w-3.5" />} label={saving ? "保存中" : "保存"} primary onClick={() => void saveFile()} disabled={saving || loading || !isDirty} />
          </div>
        </div>

        <div className="mt-3 grid min-h-0 min-w-0 flex-1 gap-3 lg:grid-cols-[220px_minmax(0,1fr)]">
          <div className="flex min-h-0 flex-col rounded-[var(--radius-card)] border bg-background p-2">
            <div className="mb-2 flex shrink-0 items-center justify-between gap-2 px-1">
              <div className="text-[11px] font-semibold text-foreground">记忆文件</div>
              <div className="text-[10px] text-muted-foreground">{summary ? countMemoryFiles(summary.autoMemoryFiles) + 1 : 0}</div>
            </div>
            <div className="min-h-0 flex-1 space-y-1 overflow-y-auto pr-1 [scrollbar-gutter:stable] brevyn-scrollbar-thin">
              <MemoryFileButton
                label="CLAUDE.md"
                detail="工作区规则"
                active={selectedKind === "claude"}
                onClick={() => selectTab("claude")}
              />
              <div className="pt-1">
                {summary?.autoMemoryFiles.length ? (
                  summary.autoMemoryFiles.map((node) => (
                    <MemoryTreeNode key={node.relativePath} node={node} selectedPath={selectedAutoPath} autoActive={selectedKind === "auto"} onSelect={selectAutoFile} />
                  ))
                ) : (
                  <MemoryFileButton
                    label="MEMORY.md"
                    detail="Auto Memory"
                    active={selectedKind === "auto" && selectedAutoPath === "MEMORY.md"}
                    onClick={() => selectAutoFile("MEMORY.md")}
                  />
                )}
              </div>
            </div>
            <div className="mt-2 flex shrink-0 items-center gap-1 border-t pt-2">
              <input
                className="min-w-0 flex-1 rounded-[var(--radius-control)] bg-muted px-2 py-1.5 text-[11px] text-foreground outline-none placeholder:text-muted-foreground/55"
                value={newAutoPath}
                placeholder="topic.md"
                onChange={(event) => setNewAutoPath(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Enter") createAutoFile();
                }}
              />
              <button
                type="button"
                className="flex h-7 w-7 shrink-0 items-center justify-center rounded-[var(--radius-control)] bg-card text-muted-foreground transition hover:bg-accent hover:text-foreground"
                onClick={createAutoFile}
                title="新建记忆文件"
                aria-label="新建记忆文件"
              >
                <Plus className="h-3.5 w-3.5" />
              </button>
            </div>
          </div>

          <div className="flex min-h-0 min-w-0 flex-col overflow-hidden">
            <div className="flex min-h-7 shrink-0 flex-wrap items-center justify-between gap-2">
              <div className="flex min-w-0 flex-1 flex-wrap items-center gap-2 text-[11px] text-muted-foreground">
                <BookOpenText className="h-3.5 w-3.5" />
                <span className="min-w-0 max-w-[220px] truncate font-mono" title={selectedInfo?.relativePath || "MEMORY.md"}>{selectedInfo?.relativePath || "MEMORY.md"}</span>
                <span className="shrink-0">{selectedInfo?.exists ? `${formatBytes(selectedInfo.size)} · ${formatTime(selectedInfo.updatedAt)}` : "尚未保存"}</span>
                {isDirty && <span className="rounded-[var(--radius-badge)] bg-[hsl(var(--status-warning)/0.14)] px-2 py-0.5 text-[hsl(var(--status-warning))]">未保存</span>}
              </div>
              <div className="inline-flex rounded-[var(--radius-control)] bg-muted p-1">
                {(["preview", "edit"] as const).map((mode) => (
                  <button
                    key={mode}
                    type="button"
                    className={cx(
                      "h-7 rounded-[var(--radius-badge)] px-3 text-[11px] font-semibold transition",
                      viewMode === mode ? "bg-background text-foreground shadow-sm" : "text-muted-foreground hover:text-foreground",
                    )}
                    onClick={() => setViewMode(mode)}
                  >
                    {mode === "edit" ? "编辑" : "预览"}
                  </button>
                ))}
              </div>
            </div>

            {viewMode === "edit" ? (
              <textarea
                className="mt-3 min-h-0 flex-1 w-full resize-none rounded-[var(--radius-card)] border bg-background px-3 py-3 font-mono text-[12px] leading-5 text-foreground outline-none [scrollbar-gutter:stable] placeholder:text-muted-foreground/55 brevyn-scrollbar"
                value={draft}
                placeholder={DEFAULT_MEMORY_TEXT[selectedKind]}
                disabled={loading}
                onChange={(event) => setDraft(event.target.value)}
              />
            ) : (
              <div className="mt-3 min-h-0 min-w-0 flex-1 overflow-x-hidden overflow-y-auto rounded-[var(--radius-card)] border bg-background px-4 py-3 [scrollbar-gutter:stable] brevyn-scrollbar">
                {draft.trim() ? (
                  <Markdownish content={draft} preserveSoftBreaks />
                ) : (
                  <div className="flex h-full items-center justify-center text-xs text-muted-foreground">没有可预览的内容</div>
                )}
              </div>
            )}
          </div>
        </div>
        {statusLine && (
          <div className={cx("mt-2 text-[11px]", statusLine.includes("失败") ? "text-destructive" : "text-muted-foreground")}>{statusLine}</div>
        )}
      </section>
    </div>
  );
}

function PathRow({ label, value }: { label: string; value: string }) {
  const [copied, setCopied] = useState(false);
  const copyable = Boolean(value && value !== "加载中");
  const displayValue = copyable ? compactPath(value) : value;

  async function copyPath() {
    if (!copyable) return;
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1200);
    } catch {
      setCopied(false);
    }
  }

  return (
    <div className="brevyn-control-surface flex min-w-0 items-center gap-2 px-3 py-2">
      <div className="min-w-0 flex-1">
        <div className="text-[10px] text-muted-foreground">{label}</div>
        <div className="mt-0.5 truncate font-mono text-[11px] text-foreground" title={value}>{displayValue}</div>
      </div>
      <button
        type="button"
        className="flex h-7 w-7 shrink-0 items-center justify-center rounded-[var(--radius-control)] text-muted-foreground transition hover:bg-card hover:text-foreground disabled:cursor-not-allowed disabled:opacity-45"
        disabled={!copyable}
        onClick={() => void copyPath()}
        title={copied ? "已复制" : `复制${label}路径`}
        aria-label={copied ? "已复制" : `复制${label}路径`}
      >
        {copied ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />}
      </button>
    </div>
  );
}

function MemoryFileButton({ label, detail, active, onClick, depth = 0 }: { label: string; detail?: string; active: boolean; onClick: () => void; depth?: number }) {
  return (
    <button
      type="button"
      className={cx(
        "flex h-8 w-full items-center gap-2 rounded-[var(--radius-control)] px-2 text-left transition",
        active ? "bg-primary/10 text-foreground" : "text-muted-foreground hover:bg-muted hover:text-foreground",
      )}
      style={{ paddingLeft: 8 + depth * 12 }}
      onClick={onClick}
      title={label}
    >
      <FileText className="h-3.5 w-3.5 shrink-0" />
      <span className="min-w-0 flex-1 truncate text-[11px] font-medium">{label}</span>
      {detail && <span className="shrink-0 text-[9px] text-muted-foreground">{detail}</span>}
    </button>
  );
}

function MemoryTreeNode({ node, selectedPath, autoActive, onSelect, depth = 0 }: { node: WorkspaceMemoryFileNode; selectedPath: string; autoActive: boolean; onSelect: (relativePath: string) => void; depth?: number }) {
  if (node.type === "directory") {
    return (
      <div>
        <div
          className="flex h-7 items-center gap-2 px-2 text-[11px] font-medium text-muted-foreground"
          style={{ paddingLeft: 8 + depth * 12 }}
          title={node.relativePath}
        >
          <Folder className="h-3.5 w-3.5 shrink-0" />
          <span className="min-w-0 truncate">{node.name}</span>
        </div>
        {(node.children || []).map((child) => (
          <MemoryTreeNode key={child.relativePath} node={child} selectedPath={selectedPath} autoActive={autoActive} onSelect={onSelect} depth={depth + 1} />
        ))}
      </div>
    );
  }
  return (
    <MemoryFileButton
      label={node.name}
      detail={node.relativePath === "MEMORY.md" ? "索引" : undefined}
      active={autoActive && selectedPath === node.relativePath}
      onClick={() => onSelect(node.relativePath)}
      depth={depth}
    />
  );
}

function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 B";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function formatTime(value?: string): string {
  if (!value) return "未更新";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "未更新";
  return date.toLocaleString(undefined, { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" });
}

function compactPath(value: string): string {
  const homePrefix = "/Users/koi";
  const normalized = value.startsWith(homePrefix) ? `~${value.slice(homePrefix.length)}` : value;
  const parts = normalized.split("/").filter(Boolean);
  if (parts.length <= 5) return normalized;
  const tail = parts.slice(-3).map(shortenGeneratedSegment);
  return `.../${tail.join("/")}`;
}

function shortenGeneratedSegment(value: string): string {
  return value
    .replace(/^(semester-[0-9a-f]{8})[0-9a-f-]+$/i, "$1...")
    .replace(/^(course-[0-9a-f]{8})[0-9a-f-]+$/i, "$1...")
    .replace(/^(task-[0-9a-f]{8})[0-9a-f-]+(__.+)?$/i, (_match, prefix: string, suffix?: string) => `${prefix}...${suffix || ""}`);
}

function countMemoryFiles(nodes: WorkspaceMemoryFileNode[]): number {
  return nodes.reduce((total, node) => total + (node.type === "file" ? 1 : countMemoryFiles(node.children || [])), 0);
}

function selectedRelativePath(kind: WorkspaceMemoryFileKind, autoPath: string): string {
  return kind === "claude" ? "CLAUDE.md" : autoPath;
}

function normalizeNewAutoPath(value: string): string {
  const normalized = value.trim().replace(/\\/g, "/").replace(/^\/+/, "");
  if (!normalized || normalized.includes("..") || normalized.includes("\0")) return "";
  if (normalized.endsWith("/")) return "";
  return normalized.includes(".") ? normalized : `${normalized}.md`;
}

function defaultAutoMemoryFileText(relativePath: string): string {
  const title = relativePath.split("/").pop()?.replace(/\.[^.]+$/, "") || "memory";
  return [`# ${title}`, "", "- "].join("\n");
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isMissingSemesterMessage(message: string): boolean {
  return message.includes("请先创建或选择一个学期");
}

function resetSettingsScrollPosition(anchor: HTMLElement | null) {
  const scrollRoot = anchor?.closest<HTMLElement>('[data-settings-scroll-root="true"]');
  if (!scrollRoot) return;
  const root = scrollRoot;

  function reset() {
    root.scrollTop = 0;
    root.scrollLeft = 0;
  }

  reset();
  window.requestAnimationFrame(() => {
    reset();
    window.requestAnimationFrame(reset);
  });
}
