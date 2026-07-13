import { useState } from "react";
import { Check, Loader2, MessageCircleQuestion, Send, ShieldAlert, X } from "lucide-react";
import type { AgentApprovalRequest, AgentAskUserRequest, AgentExitPlanRequest } from "@/types/domain";
import { ToolInputPreview } from "@/components/agent/AgentToolCards";
import { ToolGlyph, ToolTitle } from "@/components/agent/AgentToolRenderers";
import {
  answerKey,
  defaultQuestionAnswers,
  nextQuestionAnswer,
} from "@/components/agent/agentTimelineModel";
import { getToolTitle, truncatePreview } from "@/components/agent/tool-cards/toolModel";

export function ApprovalCard({
  request,
  decision,
  onApprove,
  onReject,
}: {
  request: AgentApprovalRequest;
  decision?: "allow" | "deny";
  onApprove: (requestId: string) => Promise<void>;
  onReject: (requestId: string) => Promise<void>;
}) {
  const [pending, setPending] = useState<"allow" | "deny" | null>(null);
  const resolved = Boolean(decision);

  async function resolveApproval(next: "allow" | "deny") {
    if (pending || resolved) return;
    setPending(next);
    try {
      await (next === "allow" ? onApprove(request.requestId) : onReject(request.requestId));
    } finally {
      setPending(null);
    }
  }

  const dangerous = request.riskLevel === "dangerous";

  return (
    <div className={`rounded-2xl p-4 ${dangerous ? "brevyn-status-card-danger" : "brevyn-status-card-warning"}`}>
      <div className="flex items-start gap-3">
        <div className={`mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-xl ${dangerous ? "brevyn-status-icon-danger" : "brevyn-status-icon-warning"}`}>
          <ShieldAlert className="h-4 w-4" />
        </div>
        <div className="min-w-0 flex-1">
          <p className="text-sm font-semibold text-foreground">
            {request.title || request.displayName || getToolTitle(request.toolName, request.input)}
          </p>
          <p className="mt-1 text-xs leading-5 text-muted-foreground">
            {request.description || "Brevyn needs your approval before running this tool."}
          </p>
          {dangerous && (
            <p className="mt-1 text-[11px] font-medium text-[hsl(var(--status-danger))]">
              这个命令看起来有破坏性或影响较大，允许前请再确认一次。
            </p>
          )}
          <div className="mt-3 rounded-xl bg-[hsl(var(--foreground)/0.045)] p-2">
            <div className="text-[11px] font-medium text-muted-foreground">Tool · {request.toolName}</div>
            <ToolInputPreview
              toolName={request.toolName}
              input={request.input}
              truncatePreview={truncatePreview}
              renderToolGlyph={(toolName, className) => <ToolGlyph toolName={toolName} className={className} />}
            />
          </div>
          <div className="mt-3 flex flex-wrap items-center gap-2">
            {resolved ? (
              <span className="inline-flex h-8 items-center rounded-md bg-[hsl(var(--foreground)/0.055)] px-3 text-xs font-medium text-muted-foreground">
                {decision === "allow" ? "Approved" : "Denied"}
              </span>
            ) : (
              <>
                <button
                  type="button"
                  disabled={Boolean(pending)}
                  className="inline-flex h-8 items-center gap-1.5 rounded-md bg-foreground px-3 text-xs font-medium text-background transition hover:opacity-90"
                  onClick={() => void resolveApproval("allow")}
                >
                  {pending === "allow" ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Check className="h-3.5 w-3.5" />}
                  {pending === "allow" ? "Allowing" : "Allow"}
                </button>
                <button
                  type="button"
                  disabled={Boolean(pending)}
                  className="inline-flex h-8 items-center gap-1.5 rounded-md bg-[hsl(var(--foreground)/0.06)] px-3 text-xs font-medium text-foreground transition hover:bg-[hsl(var(--foreground)/0.09)] disabled:cursor-not-allowed disabled:opacity-60"
                  onClick={() => void resolveApproval("deny")}
                >
                  {pending === "deny" ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <X className="h-3.5 w-3.5" />}
                  {pending === "deny" ? "Denying" : "Deny"}
                </button>
              </>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

export function AskUserCard({
  request,
  resolvedAnswers,
  onAnswer,
}: {
  request: AgentAskUserRequest;
  resolvedAnswers?: Record<string, string>;
  onAnswer: (requestId: string, answers: Record<string, string>) => Promise<void>;
}) {
  const [answers, setAnswers] = useState<Record<string, string>>(() => defaultQuestionAnswers(request));
  const [pending, setPending] = useState(false);
  const resolved = Boolean(resolvedAnswers);
  const visibleAnswers = resolvedAnswers || answers;

  async function submit() {
    if (pending || resolved) return;
    setPending(true);
    try {
      await onAnswer(request.requestId, answers);
    } finally {
      setPending(false);
    }
  }

  return (
    <div className="brevyn-status-card-info rounded-2xl p-4">
      <div className="flex items-start gap-3">
        <div className="brevyn-status-icon-info mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-xl">
          <MessageCircleQuestion className="h-4 w-4" />
        </div>
        <div className="min-w-0 flex-1">
          <p className="text-sm font-semibold text-foreground">Brevyn needs a choice</p>
          <p className="mt-1 text-xs leading-5 text-muted-foreground">
            Answer this question so the current run can continue without losing context.
          </p>
          <div className="mt-3 space-y-3">
            {request.questions.map((question, index) => {
              const key = answerKey(question.question, index);
              const selected = visibleAnswers[key] || "";
              return (
                <div key={key} className="rounded-xl border bg-background/82 p-3">
                  <div className="mb-2">
                    {question.header && <p className="text-[11px] font-semibold uppercase tracking-[0.14em] text-[hsl(var(--status-info))]">{question.header}</p>}
                    <p className="text-xs font-semibold text-foreground">{question.question || `Question ${index + 1}`}</p>
                  </div>
                  {question.options.length > 0 ? (
                    <div className="space-y-2">
                      {question.options.map((option) => {
                        const active = question.multiSelect
                          ? selected.split(",").map((item) => item.trim()).includes(option.label)
                          : selected === option.label;
                        return (
                          <button
                            key={option.label}
                            type="button"
                            disabled={resolved}
                            className={`w-full rounded-xl border px-3 py-2 text-left text-xs transition ${
                              active
                                ? "border-foreground bg-foreground text-background"
                                : "border-border bg-card/70 text-foreground hover:bg-accent"
                            } disabled:cursor-default disabled:opacity-80`}
                            onClick={() => {
                              setAnswers((current) => ({
                                ...current,
                                [key]: nextQuestionAnswer(current[key] || "", option.label, Boolean(question.multiSelect)),
                              }));
                            }}
                          >
                            <span className="font-semibold">{option.label}</span>
                            {option.description && <span className={`mt-0.5 block leading-5 ${active ? "text-background/75" : "text-muted-foreground"}`}>{option.description}</span>}
                            {option.preview && <span className={`mt-1 block truncate text-[11px] ${active ? "text-background/70" : "text-muted-foreground/80"}`}>{option.preview}</span>}
                          </button>
                        );
                      })}
                    </div>
                  ) : (
                    <textarea
                      value={selected}
                      disabled={resolved}
                      rows={2}
                      className="w-full resize-none rounded-xl border bg-card/80 px-3 py-2 text-xs leading-5 text-foreground outline-none transition focus:border-foreground disabled:opacity-80"
                      placeholder="Type your answer..."
                      onChange={(event) => setAnswers((current) => ({ ...current, [key]: event.target.value }))}
                    />
                  )}
                </div>
              );
            })}
          </div>
          <div className="mt-3 flex items-center gap-2">
            {resolved ? (
              <span className="inline-flex h-8 items-center gap-1.5 rounded-md bg-[hsl(var(--foreground)/0.055)] px-3 text-xs font-medium text-muted-foreground">
                <Check className="h-3.5 w-3.5" />
                Answered
              </span>
            ) : (
              <button
                type="button"
                disabled={pending}
                className="inline-flex h-8 items-center gap-1.5 rounded-md bg-foreground px-3 text-xs font-medium text-background transition hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-60"
                onClick={() => void submit()}
              >
                {pending ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Send className="h-3.5 w-3.5" />}
                {pending ? "Sending" : "Answer"}
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

export function ExitPlanCard({
  request,
  decision,
  onResolve,
}: {
  request: AgentExitPlanRequest;
  decision?: "approve" | "deny";
  onResolve: (requestId: string, decision: "approve" | "deny", feedback?: string) => Promise<void>;
}) {
  const [pending, setPending] = useState<"approve" | "deny" | null>(null);
  const [feedback, setFeedback] = useState("");
  const resolved = Boolean(decision);

  async function resolvePlan(next: "approve" | "deny") {
    if (pending || resolved) return;
    setPending(next);
    try {
      await onResolve(request.requestId, next, next === "deny" ? feedback.trim() : undefined);
    } finally {
      setPending(null);
    }
  }

  return (
    <div className="brevyn-status-card-info rounded-2xl p-4">
      <div className="flex items-start gap-3">
        <div className="brevyn-status-icon-info mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-xl">
          <ShieldAlert className="h-4 w-4" />
        </div>
        <div className="min-w-0 flex-1">
          <p className="text-sm font-semibold text-foreground">计划已准备好</p>
          <p className="mt-1 text-xs leading-5 text-muted-foreground">
            Brevyn 已完成计划。批准后将切回自动审批继续执行，或发送反馈让它继续修改计划。
          </p>
          {request.allowedPrompts.length > 0 && (
            <div className="mt-3 rounded-xl border bg-background/82 p-3">
              <p className="text-[11px] font-semibold uppercase tracking-[0.14em] text-[hsl(var(--status-info))]">Requested execution scope</p>
              <div className="mt-2 space-y-1.5">
                {request.allowedPrompts.map((prompt, index) => (
                  <div key={`${prompt.tool}-${prompt.prompt}-${index}`} className="flex items-start gap-2 text-xs leading-5 text-foreground">
                    <Check className="mt-0.5 h-3.5 w-3.5 shrink-0 text-[hsl(var(--status-info))]" />
                    <span className="min-w-0 break-words">{prompt.tool}: {prompt.prompt}</span>
                  </div>
                ))}
              </div>
            </div>
          )}
          {!resolved && (
            <textarea
              value={feedback}
              rows={2}
              className="mt-3 w-full resize-none rounded-xl border border-border/70 bg-background/82 px-3 py-2 text-xs leading-5 text-foreground outline-none transition focus:border-[hsl(var(--status-info)/0.45)]"
              placeholder="Optional feedback if you want Brevyn to revise the plan..."
              onChange={(event) => setFeedback(event.target.value)}
            />
          )}
          <div className="mt-3 flex flex-wrap items-center gap-2">
            {resolved ? (
              <span className="inline-flex h-8 items-center gap-1.5 rounded-md bg-[hsl(var(--foreground)/0.055)] px-3 text-xs font-medium text-muted-foreground">
                <Check className="h-3.5 w-3.5" />
                {decision === "approve" ? "Approved" : "Sent back"}
              </span>
            ) : (
              <>
                <button
                  type="button"
                  disabled={Boolean(pending)}
                  className="inline-flex h-8 items-center gap-1.5 rounded-md bg-foreground px-3 text-xs font-medium text-background transition hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-60"
                  onClick={() => void resolvePlan("approve")}
                >
                  {pending === "approve" ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Check className="h-3.5 w-3.5" />}
                  {pending === "approve" ? "正在批准" : "批准并自动审批执行"}
                </button>
                <button
                  type="button"
                  disabled={Boolean(pending)}
                  className="inline-flex h-8 items-center gap-1.5 rounded-md bg-[hsl(var(--foreground)/0.06)] px-3 text-xs font-medium text-foreground transition hover:bg-[hsl(var(--foreground)/0.09)] disabled:cursor-not-allowed disabled:opacity-60"
                  onClick={() => void resolvePlan("deny")}
                >
                  {pending === "deny" ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <X className="h-3.5 w-3.5" />}
                  {pending === "deny" ? "正在发送" : "继续修改计划"}
                </button>
              </>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
