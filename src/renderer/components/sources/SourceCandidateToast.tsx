import { useCallback, useEffect, useMemo, useState } from "react";
import { Check, ChevronDown, ExternalLink, Globe2, Loader2, Sparkles, X } from "lucide-react";
import type { BrevynTask, Course, SourceCandidate } from "@/types/domain";
import { cx } from "@/lib/cn";

const VISIBLE_LIMIT = 3;

export function SourceCandidateToast({
  course,
  activeTask,
  activeThreadId,
}: {
  course?: Course;
  activeTask?: BrevynTask;
  activeThreadId?: string;
}) {
  const [candidates, setCandidates] = useState<SourceCandidate[]>([]);
  const [loading, setLoading] = useState(false);
  const [collapsed, setCollapsed] = useState(false);
  const [expandedIds, setExpandedIds] = useState<Set<string>>(() => new Set());
  const [busyIds, setBusyIds] = useState<Set<string>>(() => new Set());
  const canLoad = Boolean(activeThreadId && course && course.workspaceKind !== "semester_home");
  const visibleCandidates = useMemo(
    () => candidates.filter((candidate) => candidate.status === "pending" || candidate.status === "accepting" || candidate.status === "failed"),
    [candidates],
  );
  const shownCandidates = collapsed ? [] : visibleCandidates.slice(0, VISIBLE_LIMIT);
  const hiddenCount = Math.max(0, visibleCandidates.length - shownCandidates.length);

  const loadCandidates = useCallback(async () => {
    if (!course || course.workspaceKind === "semester_home") {
      setCandidates([]);
      return;
    }
    setLoading(true);
    try {
      const nextCandidates = await window.brevyn.sourceCandidates.list({
        courseId: course.id,
        taskId: activeTask?.id,
        statuses: ["pending", "accepting", "failed"],
      });
      setCandidates(activeTask?.id ? nextCandidates : nextCandidates.filter((candidate) => !candidate.taskId));
    } catch {
      setCandidates([]);
    } finally {
      setLoading(false);
    }
  }, [activeTask?.id, activeThreadId, course]);

  useEffect(() => {
    if (!canLoad) {
      setCandidates([]);
      return;
    }
    void loadCandidates();
  }, [canLoad, loadCandidates]);

  useEffect(() => {
    const unsubscribe = window.brevyn.sourceCandidates.onChanged((event) => {
      if (!course || event.courseId !== course.id) return;
      if (activeTask?.id && event.taskId && event.taskId !== activeTask.id) return;
      if (!activeTask?.id && event.taskId) return;
      void loadCandidates();
    });
    return unsubscribe;
  }, [activeTask?.id, course, loadCandidates]);

  async function acceptCandidate(candidate: SourceCandidate) {
    setBusy(candidate.id, true);
    setCandidates((current) => current.map((item) => item.id === candidate.id ? { ...item, status: "accepting", error: undefined } : item));
    try {
      const result = await window.brevyn.sourceCandidates.accept(candidate.id);
      setCandidates((current) => {
        if (result.candidate.status === "accepted") return current.filter((item) => item.id !== candidate.id);
        return current.map((item) => item.id === candidate.id ? result.candidate : item);
      });
    } catch (error) {
      setCandidates((current) => current.map((item) => item.id === candidate.id ? { ...item, status: "failed", error: errorMessage(error) } : item));
    } finally {
      setBusy(candidate.id, false);
      void loadCandidates();
    }
  }

  async function rejectCandidate(candidate: SourceCandidate) {
    setBusy(candidate.id, true);
    try {
      await window.brevyn.sourceCandidates.reject(candidate.id);
      setCandidates((current) => current.filter((item) => item.id !== candidate.id));
    } catch (error) {
      setCandidates((current) => current.map((item) => item.id === candidate.id ? { ...item, status: "failed", error: errorMessage(error) } : item));
    } finally {
      setBusy(candidate.id, false);
      void loadCandidates();
    }
  }

  function setBusy(candidateId: string, busy: boolean) {
    setBusyIds((current) => {
      const next = new Set(current);
      if (busy) next.add(candidateId);
      else next.delete(candidateId);
      return next;
    });
  }

  function toggleCandidate(candidateId: string) {
    setExpandedIds((current) => {
      const next = new Set(current);
      if (next.has(candidateId)) next.delete(candidateId);
      else next.add(candidateId);
      return next;
    });
  }

  if (!canLoad || visibleCandidates.length === 0) return null;

  return (
    <div className="pointer-events-none absolute right-4 top-4 z-30 w-[min(380px,calc(100%-2rem))]">
      <section className="brevyn-floating-surface pointer-events-auto overflow-hidden rounded-3xl">
        <button
          type="button"
          className="flex w-full items-center justify-between gap-3 px-3.5 py-3 text-left transition hover:bg-foreground/[0.035] active:bg-foreground/[0.055]"
          onClick={() => setCollapsed((value) => !value)}
        >
          <div className="flex min-w-0 items-center gap-3">
            <span className="relative flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-primary/[0.12] text-primary shadow-xs">
              <Sparkles className="h-4 w-4" />
              {loading && <span className="absolute -right-0.5 -top-0.5 h-2 w-2 animate-pulse rounded-full bg-[hsl(var(--status-info))]" />}
            </span>
            <div className="min-w-0">
              <div className="truncate text-sm font-semibold tracking-[-0.02em] text-foreground">
                Brevyn 找到可能有用的来源
              </div>
              <div className="mt-0.5 text-[10px] text-muted-foreground">
                {visibleCandidates.length} 条线索等待你确认
              </div>
            </div>
          </div>
          <ChevronDown className={cx("h-4 w-4 shrink-0 text-muted-foreground transition-transform", collapsed && "-rotate-90")} />
        </button>

        {!collapsed && (
          <div className="max-h-[min(44vh,340px)] overflow-y-auto px-2 pb-2 brevyn-scrollbar">
            {shownCandidates.map((candidate) => (
              <CandidateRow
                key={candidate.id}
                candidate={candidate}
                expanded={expandedIds.has(candidate.id) || candidate.status === "failed"}
                busy={busyIds.has(candidate.id) || candidate.status === "accepting"}
                onToggle={() => toggleCandidate(candidate.id)}
                onAccept={() => void acceptCandidate(candidate)}
                onReject={() => void rejectCandidate(candidate)}
              />
            ))}
            {hiddenCount > 0 && (
              <div className="rounded-2xl bg-foreground/[0.035] px-3 py-2 text-[10px] text-muted-foreground">
                还有 {hiddenCount} 条来源线索，处理完上面的会继续显示。
              </div>
            )}
          </div>
        )}
      </section>
    </div>
  );
}

function CandidateRow({
  candidate,
  expanded,
  busy,
  onToggle,
  onAccept,
  onReject,
}: {
  candidate: SourceCandidate;
  expanded: boolean;
  busy: boolean;
  onToggle: () => void;
  onAccept: () => void;
  onReject: () => void;
}) {
  const host = safeHostname(candidate.url) || candidate.siteName || "网页来源";
  const canOpenUrl = isHttpUrl(candidate.url);
  const failed = candidate.status === "failed";
  return (
    <article className="border-t border-foreground/[0.055] first:border-t-0">
      <button
        type="button"
        className={cx(
          "flex w-full items-start gap-3 rounded-2xl px-2 py-2.5 text-left transition",
          expanded ? "bg-foreground/[0.035]" : "hover:bg-foreground/[0.03]",
        )}
        onClick={onToggle}
      >
        <span className="mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-[hsl(var(--status-info)/0.10)] text-[hsl(var(--status-info))]">
          <Globe2 className="h-3.5 w-3.5" />
        </span>
        <div className="min-w-0 flex-1">
          <div className="line-clamp-1 text-xs font-semibold leading-4 text-foreground" title={candidate.title}>
            {candidate.title}
          </div>
          <div className="mt-1 truncate text-[10px] text-muted-foreground" title={candidate.url}>
            {host} · {candidate.scope === "task" ? "当前作业" : "当前课程"}
          </div>
        </div>
        <ChevronDown className={cx("mt-1 h-3.5 w-3.5 shrink-0 text-muted-foreground transition-transform", !expanded && "-rotate-90")} />
      </button>
      {expanded && (
        <div className="px-2 pb-2">
          <p className="text-[10px] leading-4 text-muted-foreground">
            {candidate.reason}
          </p>
          {candidate.snippet && (
            <p className="mt-1.5 line-clamp-3 rounded-xl bg-foreground/[0.035] px-2 py-1.5 text-[10px] leading-4 text-muted-foreground">
              {candidate.snippet}
            </p>
          )}
          {failed && candidate.error && (
            <div className="mt-2 rounded-xl bg-destructive/10 px-2 py-1.5 text-[10px] leading-4 text-destructive">
              {candidate.error}
            </div>
          )}
          <div className="mt-2.5 flex items-center justify-between gap-2">
            {canOpenUrl ? (
              <button
                type="button"
                className="brevyn-soft-button inline-flex h-7 items-center gap-1 rounded-full px-2.5 text-[10px] font-medium text-muted-foreground transition hover:text-foreground"
                onClick={(event) => {
                  event.stopPropagation();
                  void window.brevyn.app.openExternal(candidate.url);
                }}
              >
                <ExternalLink className="h-3.5 w-3.5" />
                打开网页
              </button>
            ) : (
              <span />
            )}
            <div className="flex items-center justify-end gap-1.5">
              <button
                type="button"
                className="brevyn-soft-button inline-flex h-7 items-center gap-1 rounded-full px-2.5 text-[10px] font-medium text-muted-foreground transition hover:text-foreground disabled:cursor-wait disabled:opacity-50"
                disabled={busy}
                onClick={onReject}
              >
                <X className="h-3.5 w-3.5" />
                暂不使用
              </button>
              <button
                type="button"
                className="brevyn-primary-button inline-flex h-7 items-center gap-1 rounded-full px-3 text-[10px] font-semibold transition disabled:cursor-wait disabled:opacity-50"
                disabled={busy}
                onClick={onAccept}
              >
                {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Check className="h-3.5 w-3.5" />}
                {failed ? "重试加入" : busy ? "正在加入" : "加入资料库"}
              </button>
            </div>
          </div>
        </div>
      )}
    </article>
  );
}

function safeHostname(value: string): string {
  try {
    return new URL(value).hostname.replace(/^www\./, "");
  } catch {
    return "";
  }
}

function isHttpUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}

function errorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error || "");
  return message.replace(/^Error invoking remote method '[^']+':\s*/, "").replace(/^Error:\s*/, "").trim() || "来源处理失败。";
}
