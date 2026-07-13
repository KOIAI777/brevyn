import { randomUUID } from "node:crypto";
import type { PermissionResult } from "@anthropic-ai/claude-agent-sdk";
import type { AgentAskUserRequest, AgentAskUserResponseInput } from "../../types/domain";

interface PendingAskUser {
  threadId: string;
  requestId: string;
  toolUseID: string | undefined;
  toolInput: Record<string, unknown>;
  resolve: (result: PermissionResult) => void;
}

export class AskUserService {
  private readonly pending = new Map<string, PendingAskUser>();

  ask(input: {
    threadId: string;
    runId: string;
    toolInput: Record<string, unknown>;
    toolUseID?: string;
    signal: AbortSignal;
    onRequest: (request: AgentAskUserRequest) => void;
  }): Promise<PermissionResult> {
    const request: AgentAskUserRequest = {
      requestId: entityId("ask"),
      threadId: input.threadId,
      runId: input.runId,
      questions: parseQuestions(input.toolInput),
      toolInput: input.toolInput,
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

  answer(input: AgentAskUserResponseInput): boolean {
    const pending = this.pending.get(input.requestId);
    if (!pending || pending.threadId !== input.threadId) return false;
    this.pending.delete(input.requestId);
    pending.resolve({
      behavior: "allow",
      updatedInput: {
        ...pending.toolInput,
        answers: input.answers,
      },
      toolUseID: pending.toolUseID,
      decisionClassification: "user_temporary",
    });
    return true;
  }

  clearThread(threadId: string): void {
    for (const [requestId, pending] of this.pending) {
      if (pending.threadId === threadId) {
        pending.resolve(deny("Agent run ended before the question was answered.", pending.toolUseID));
        this.pending.delete(requestId);
      }
    }
  }
}

function parseQuestions(input: Record<string, unknown>): AgentAskUserRequest["questions"] {
  const rawQuestions = input.questions;
  if (!Array.isArray(rawQuestions)) return [];
  return rawQuestions.map((item, index) => {
    const raw = recordObject(item);
    const options = Array.isArray(raw.options)
      ? raw.options.map((option) => {
          const rawOption = recordObject(option);
          return {
            label: stringValue(rawOption.label, "Option"),
            description: optionalString(rawOption.description),
            preview: optionalString(rawOption.preview)?.slice(0, 10_000),
          };
        })
      : [];
    return {
      question: stringValue(raw.question, `Question ${index + 1}`),
      header: optionalString(raw.header),
      options,
      multiSelect: raw.multiSelect === true,
    };
  });
}

function recordObject(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function stringValue(value: unknown, fallback: string): string {
  return typeof value === "string" && value.trim() ? value.trim() : fallback;
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
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
