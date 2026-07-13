import { randomUUID } from "node:crypto";
import type { PermissionResult } from "@anthropic-ai/claude-agent-sdk";
import type { AgentExitPlanRequest, AgentExitPlanResponseInput } from "../../types/domain";

interface PendingExitPlan {
  threadId: string;
  requestId: string;
  toolUseID: string | undefined;
  toolInput: Record<string, unknown>;
  resolve: (result: PermissionResult) => void;
}

export class ExitPlanService {
  private readonly pending = new Map<string, PendingExitPlan>();

  request(input: {
    threadId: string;
    runId: string;
    toolInput: Record<string, unknown>;
    toolUseID?: string;
    signal: AbortSignal;
    onRequest: (request: AgentExitPlanRequest) => void;
  }): Promise<PermissionResult> {
    const request: AgentExitPlanRequest = {
      requestId: entityId("exit_plan"),
      threadId: input.threadId,
      runId: input.runId,
      toolInput: input.toolInput,
      allowedPrompts: parseAllowedPrompts(input.toolInput),
      createdAt: new Date().toISOString(),
    };

    input.onRequest(request);

    return new Promise<PermissionResult>((resolve) => {
      this.pending.set(request.requestId, {
        threadId: input.threadId,
        requestId: request.requestId,
        toolUseID: input.toolUseID,
        toolInput: input.toolInput,
        resolve,
      });
      input.signal.addEventListener("abort", () => {
        if (!this.pending.has(request.requestId)) return;
        this.pending.delete(request.requestId);
        resolve(deny("Agent run was stopped.", input.toolUseID));
      }, { once: true });
    });
  }

  resolve(input: AgentExitPlanResponseInput): boolean {
    const pending = this.pending.get(input.requestId);
    if (!pending || pending.threadId !== input.threadId) return false;
    this.pending.delete(input.requestId);

    if (input.decision === "approve") {
      pending.resolve({
        behavior: "allow",
        updatedInput: pending.toolInput,
        toolUseID: pending.toolUseID,
        decisionClassification: "user_temporary",
      });
      return true;
    }

    pending.resolve(deny(input.feedback || "User asked Brevyn to revise the plan before continuing.", pending.toolUseID));
    return true;
  }

  clearThread(threadId: string): void {
    for (const [requestId, pending] of this.pending) {
      if (pending.threadId === threadId) {
        pending.resolve(deny("Agent run ended before the plan was approved.", pending.toolUseID));
        this.pending.delete(requestId);
      }
    }
  }
}

function parseAllowedPrompts(input: Record<string, unknown>): AgentExitPlanRequest["allowedPrompts"] {
  const raw = input.allowedPrompts;
  if (!Array.isArray(raw)) return [];
  return raw.flatMap((item) => {
    const data = recordObject(item);
    const prompt = stringValue(data.prompt, "");
    if (!prompt) return [];
    return [{
      tool: "Bash" as const,
      prompt,
    }];
  });
}

function recordObject(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function stringValue(value: unknown, fallback: string): string {
  return typeof value === "string" && value.trim() ? value.trim() : fallback;
}

function entityId(prefix: string): string {
  return `${prefix}_${randomUUID().replace(/-/g, "").slice(0, 16)}`;
}

function deny(message: string, toolUseID: string | undefined): PermissionResult {
  return {
    behavior: "deny",
    message,
    toolUseID,
    decisionClassification: "user_reject",
  };
}
