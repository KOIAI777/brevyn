import { randomUUID } from "node:crypto";
import type { CanUseTool, PermissionResult } from "@anthropic-ai/claude-agent-sdk";
import type { AgentApprovalDecision, AgentApprovalRequest, AgentPermissionMode } from "../../types/domain";
import { BREVYN_MCP_FULL_TOOL_NAMES } from "../../shared/brevyn-mcp-catalog";

interface PendingApproval {
  threadId: string;
  requestId: string;
  toolUseID: string;
  toolInput: Record<string, unknown>;
  resolve: (result: PermissionResult) => void;
}

export class PermissionService {
  private readonly pending = new Map<string, PendingApproval>();

  createCanUseTool(input: {
    threadId: string;
    runId: string;
    mode: AgentPermissionMode;
    onRequest: (request: AgentApprovalRequest) => void;
  }): CanUseTool {
    return async (toolName, toolInput, options) => {
      if (options.signal.aborted) {
        return deny("Agent run was stopped.", options.toolUseID);
      }

      if (input.mode === "bypassPermissions") {
        return {
          behavior: "allow",
          updatedInput: toolInput,
          toolUseID: options.toolUseID,
          decisionClassification: "user_temporary",
        };
      }

      if (isAutoAllowedTool(toolName, toolInput)) {
        return {
          behavior: "allow",
          updatedInput: toolInput,
          toolUseID: options.toolUseID,
          decisionClassification: "user_temporary",
        };
      }

      const request: AgentApprovalRequest = {
        requestId: entityId("approval"),
        threadId: input.threadId,
        runId: input.runId,
        toolName,
        toolUseId: options.toolUseID,
        input: toolInput,
        riskLevel: riskLevelForTool(toolName, toolInput),
        title: titleForTool(toolName, toolInput, options.title),
        displayName: options.displayName,
        description: descriptionForTool(toolName, toolInput, options.description || options.decisionReason),
        createdAt: now(),
      };

      input.onRequest(request);

      return await new Promise<PermissionResult>((resolve) => {
        this.pending.set(request.requestId, {
          threadId: input.threadId,
          requestId: request.requestId,
          toolUseID: options.toolUseID,
          toolInput,
          resolve,
        });
        options.signal.addEventListener("abort", () => {
          if (!this.pending.has(request.requestId)) return;
          this.pending.delete(request.requestId);
          resolve(deny("Agent run was stopped.", options.toolUseID));
        }, { once: true });
      });
    };
  }

  resolve(threadId: string, requestId: string, decision: AgentApprovalDecision): boolean {
    const pending = this.pending.get(requestId);
    if (!pending || pending.threadId !== threadId) return false;
    this.pending.delete(requestId);
    pending.resolve(decision === "allow"
      ? {
          behavior: "allow",
          updatedInput: pending.toolInput,
          toolUseID: pending.toolUseID,
          decisionClassification: "user_temporary",
        }
      : deny("User denied this tool call.", pending.toolUseID),
    );
    return true;
  }

  clearThread(threadId: string): void {
    for (const [requestId, pending] of this.pending) {
      if (pending.threadId === threadId) {
        pending.resolve(deny("Agent run ended before approval.", pending.toolUseID));
        this.pending.delete(requestId);
      }
    }
  }
}

const SAFE_TOOLS = new Set([
  "Read",
  "Glob",
  "Grep",
  "WebFetch",
  "WebSearch",
  "TodoRead",
  "TodoWrite",
  "TaskOutput",
  "TaskCreate",
  "TaskGet",
  "TaskUpdate",
  "TaskList",
  "Skill",
  ...BREVYN_MCP_FULL_TOOL_NAMES,
]);

const WRITE_TOOLS = new Set([
  "Write",
  "Edit",
  "MultiEdit",
  "NotebookEdit",
]);

const SAFE_BASH_PATTERNS: readonly RegExp[] = [
  /^pwd$/,
  /^ls\b/,
  /^cat\b/,
  /^head\b/,
  /^tail\b/,
  /^grep\b/,
  /^rg\b/,
  /^which\b/,
  /^whoami$/,
  /^uname\b/,
  /^tree\b/,
  /^wc\b/,
  /^file\b/,
  /^stat\b/,
  /^du\b/,
  /^df\b/,
  /^git\s+(status|log|diff|show|branch|remote|tag)\b/,
  /^node\s+--version$/,
  /^npm\s+(list|ls|view|info|outdated)\b/,
];

const DANGEROUS_BASH_PREFIXES = [
  "rm",
  "rmdir",
  "sudo",
  "su",
  "chmod",
  "chown",
  "mv",
  "dd",
  "kill",
  "killall",
  "pkill",
  "git push",
  "git reset",
  "git rebase",
  "git checkout",
  "git clean",
  "npm publish",
  "curl",
  "wget",
  "ssh",
  "scp",
];

function isAutoAllowedTool(toolName: string, toolInput: Record<string, unknown>): boolean {
  if (SAFE_TOOLS.has(toolName)) return true;
  if (toolName === "Bash") return isSafeBashCommand(stringValue(toolInput.command));
  return false;
}

function isSafeBashCommand(command: string): boolean {
  const trimmed = command.trim();
  if (!trimmed) return false;
  if (hasDangerousBashStructure(trimmed)) return false;
  if (isDangerousBashCommand(trimmed)) return false;
  return SAFE_BASH_PATTERNS.some((pattern) => pattern.test(trimmed));
}

function hasDangerousBashStructure(command: string): boolean {
  return /[|;&]/.test(command)
    || />{1,2}/.test(command)
    || /\b-exec\b/.test(command)
    || /\b-delete\b/.test(command)
    || /\$\(/.test(command)
    || /`/.test(command);
}

function isDangerousBashCommand(command: string): boolean {
  const trimmed = command.trim().toLowerCase();
  return DANGEROUS_BASH_PREFIXES.some((prefix) => trimmed === prefix || trimmed.startsWith(`${prefix} `));
}

function riskLevelForTool(toolName: string, toolInput: Record<string, unknown>): AgentApprovalRequest["riskLevel"] {
  if (toolName === "Bash") {
    const command = stringValue(toolInput.command);
    return hasDangerousBashStructure(command) || isDangerousBashCommand(command) ? "dangerous" : "normal";
  }
  return WRITE_TOOLS.has(toolName) ? "normal" : "normal";
}

function titleForTool(toolName: string, toolInput: Record<string, unknown>, fallback?: string): string {
  if (toolName === "Bash") {
    return riskLevelForTool(toolName, toolInput) === "dangerous"
      ? "确认高风险命令"
      : "确认命令";
  }
  if (toolName === "Write") return "确认文件创建";
  if (toolName === "Edit" || toolName === "MultiEdit") return "确认文件编辑";
  if (toolName === "NotebookEdit") return "确认 Notebook 编辑";
  return fallback || `确认 ${toolName}`;
}

function descriptionForTool(toolName: string, toolInput: Record<string, unknown>, fallback?: string): string {
  if (toolName === "Bash") {
    const command = stringValue(toolInput.command);
    return command ? `Brevyn wants to run: ${truncate(command, 240)}` : "Brevyn wants to run a shell command.";
  }
  if (toolName === "Write") {
    return fileDescription("Brevyn wants to create or overwrite", stringValue(toolInput.file_path), fallback);
  }
  if (toolName === "Edit" || toolName === "MultiEdit") {
    return fileDescription("Brevyn wants to edit", stringValue(toolInput.file_path), fallback);
  }
  if (toolName === "NotebookEdit") {
    return fileDescription("Brevyn wants to edit notebook", stringValue(toolInput.notebook_path), fallback);
  }
  return fallback || `Brevyn wants to use ${toolName}.`;
}

function fileDescription(prefix: string, filePath: string, fallback?: string): string {
  return filePath ? `${prefix}: ${truncate(filePath, 240)}` : fallback || prefix;
}

function stringValue(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function truncate(value: string, maxLength: number): string {
  return value.length <= maxLength ? value : `${value.slice(0, maxLength - 1)}…`;
}

function deny(message: string, toolUseID: string | undefined): PermissionResult {
  return {
    behavior: "deny",
    message,
    toolUseID,
    decisionClassification: "user_reject",
  };
}

function entityId(prefix: string): string {
  return `${prefix}_${randomUUID().replace(/-/g, "").slice(0, 16)}`;
}

function now(): string {
  return new Date().toISOString();
}
