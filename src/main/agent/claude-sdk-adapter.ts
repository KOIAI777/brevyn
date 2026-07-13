import type { CanUseTool, McpServerConfig, Options as ClaudeSdkOptions, PermissionMode, PermissionResult, Query, SDKMessage, SDKUserMessage, SdkBeta, SdkPluginConfig, SpawnOptions, SpawnedProcess } from "@anthropic-ai/claude-agent-sdk";
import type * as ClaudeAgentSdk from "@anthropic-ai/claude-agent-sdk";
import { spawn } from "node:child_process";
import { existsSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import type { AgentProviderKind, ModelProviderConfig } from "../../types/domain";
import { AnthropicAgentAdapter } from "../providers/anthropic-agent-adapter";
import { getBrevynClientAppName } from "../app-version";
import { BREVYN_MCP_FULL_TOOL_NAMES } from "../../shared/brevyn-mcp-catalog";

export type ClaudeSdkRuntime = typeof ClaudeAgentSdk;

export interface ClaudeSdkRunInput {
  prompt: string;
  slashCommand?: boolean;
  sessionKey?: string;
  cwd: string;
  model: string;
  env: Record<string, string>;
  systemPrompt: ClaudeSdkOptions["systemPrompt"];
  settings?: ClaudeSdkOptions["settings"];
  resumeSessionId?: string;
  abortController: AbortController;
  canUseTool?: CanUseTool;
  mcpServers?: Record<string, McpServerConfig>;
  onQuery?: (query: Query) => void;
  onSessionId?: (sessionId: string) => void;
  permissionMode?: PermissionMode;
  planModeInstructions?: string;
  allowDangerouslySkipPermissions?: boolean;
  betas?: SdkBeta[];
  thinking?: ClaudeSdkOptions["thinking"];
  effort?: ClaudeSdkOptions["effort"];
  plugins?: SdkPluginConfig[];
  skills?: "all" | string[];
  toolAliases?: Record<string, string>;
}

interface MessageChannel {
  enqueue: (message: SDKUserMessage) => void;
  generator: AsyncGenerator<SDKUserMessage>;
  close: () => void;
  keepOpenOnNextResult: () => void;
  consumeKeepOpenOnResult: () => boolean;
}

const activeSdkProcesses = new Map<string, { pid: number; kill: (signal?: NodeJS.Signals) => boolean }>();

export class ClaudeSdkAdapter {
  private readonly activeQueries = new Map<string, Query>();
  private readonly activeChannels = new Map<string, MessageChannel>();

  async loadSdk(): Promise<ClaudeSdkRuntime> {
    return await import("@anthropic-ai/claude-agent-sdk") as ClaudeSdkRuntime;
  }

  buildEnv(provider: ModelProviderConfig, apiKey: string): Record<string, string> {
    return new AnthropicAgentAdapter(provider.providerKind as AgentProviderKind).buildSdkEnv(provider, apiKey);
  }

  async *query(input: ClaudeSdkRunInput): AsyncIterable<SDKMessage> {
    const sdk = await this.loadSdk();
    const sessionKey = input.sessionKey;
    const channel = input.slashCommand ? null : createMessageChannel(input.abortController.signal);
    if (channel) {
      channel.enqueue({
        type: "user",
        message: {
          role: "user",
          content: input.prompt,
        },
        parent_tool_use_id: null,
      } as SDKUserMessage);
    }
    const sdkCliPath = resolveClaudeSdkCliPath();
    const options: ClaudeSdkOptions & { toolUseConcurrency?: number } = {
        abortController: input.abortController,
        cwd: input.cwd,
        model: input.model,
        env: {
          ...stringProcessEnv(),
          ...input.env,
          CLAUDE_AGENT_SDK_CLIENT_APP: getBrevynClientAppName(),
          BREVYN_RUNTIME_REQUIRE_FROM: resolveRuntimeRequireFrom(),
          NODE_PATH: runtimeNodePath(input.env?.NODE_PATH),
        },
        resume: input.resumeSessionId,
        systemPrompt: input.systemPrompt,
        pathToClaudeCodeExecutable: sdkCliPath,
        ...(input.settings ? { settings: input.settings } : {}),
        settingSources: ["project"],
        // Keep partial SDK events in the live stream so the renderer can reveal
        // assistant text progressively. The orchestrator emits them without
        // persisting, so JSONL timelines stay compact on replay.
        includePartialMessages: true,
        tools: ["Read", "Glob", "Grep", "TodoRead", "TodoWrite", "TaskCreate", "TaskGet", "TaskUpdate", "TaskList", "AskUserQuestion", "EnterPlanMode", "ExitPlanMode", "Write", "Edit", "MultiEdit", "Bash", "WebFetch", "WebSearch"],
        allowedTools: [
          "Read",
          "Glob",
          "Grep",
          "WebFetch",
          "WebSearch",
          "TodoRead",
          "TodoWrite",
          "TaskCreate",
          "TaskGet",
          "TaskUpdate",
          "TaskList",
          ...BREVYN_MCP_FULL_TOOL_NAMES,
        ],
        disallowedTools: ["NotebookEdit", "Task"],
        permissionMode: input.permissionMode || "default",
        ...(input.allowDangerouslySkipPermissions ? { allowDangerouslySkipPermissions: true } : {}),
        ...(input.planModeInstructions ? { planModeInstructions: input.planModeInstructions } : {}),
        ...(input.betas && input.betas.length > 0 ? { betas: input.betas } : {}),
        ...(input.thinking ? { thinking: input.thinking } : {}),
        ...(input.effort ? { effort: input.effort } : {}),
        ...(input.plugins && input.plugins.length > 0 ? { plugins: input.plugins } : {}),
        ...(input.skills ? { skills: input.skills } : {}),
        ...(input.toolAliases && Object.keys(input.toolAliases).length > 0 ? { toolAliases: input.toolAliases } : {}),
        toolUseConcurrency: 1,
        canUseTool: input.canUseTool || safeToolPolicy,
        ...(input.mcpServers && Object.keys(input.mcpServers).length > 0 ? { mcpServers: input.mcpServers } : {}),
        stderr: (data: string) => {
          if (data.trim()) console.warn("[claude-agent-sdk]", data.trimEnd());
        },
        spawnClaudeCodeProcess: (spawnOptions: SpawnOptions) => spawnClaudeCodeProcess(sessionKey, spawnOptions),
    };
    const query = sdk.query({
      prompt: input.slashCommand ? input.prompt : channel!.generator,
      options,
    });
    input.onQuery?.(query);
    if (sessionKey) {
      this.activeQueries.set(sessionKey, query);
      if (channel) this.activeChannels.set(sessionKey, channel);
    }
    try {
      let sessionIdEmitted = false;
      let terminateAfterTerminalResult = false;
      for await (const message of query) {
        const sessionId = sdkMessageSessionId(message);
        if (!sessionIdEmitted && sessionId) {
          sessionIdEmitted = true;
          input.onSessionId?.(sessionId);
        }
        if (channel && message.type === "result" && !shouldKeepChannelOpen(message) && !channel.consumeKeepOpenOnResult()) {
          channel.close();
          terminateAfterTerminalResult = true;
        }
        yield message;
        if (terminateAfterTerminalResult) break;
      }
    } finally {
      if (sessionKey) {
        this.activeQueries.delete(sessionKey);
        this.activeChannels.delete(sessionKey);
        activeSdkProcesses.delete(sessionKey);
      }
      channel?.close();
    }
  }

  async queueMessage(sessionKey: string, content: string, uuid?: string, interrupt = true): Promise<void> {
    const channel = this.activeChannels.get(sessionKey);
    if (!channel) throw new Error("No active Claude SDK input channel is available for this thread.");
    if (interrupt) {
      channel.keepOpenOnNextResult();
      const query = this.activeQueries.get(sessionKey);
      try {
        await query?.interrupt();
      } catch (error) {
        if (isClosedQueryInterruptError(error)) {
          throw new Error("Claude SDK query is already closed; start a new run instead.");
        }
        console.warn("[ClaudeSdkAdapter] Failed to interrupt active turn before queueing message:", error);
      }
    }
    channel.enqueue({
      type: "user",
      uuid,
      message: {
        role: "user",
        content,
      },
      parent_tool_use_id: null,
      priority: "now",
    } as SDKUserMessage);
  }

  canQueueMessage(sessionKey: string): boolean {
    return this.activeChannels.has(sessionKey);
  }
}

function createMessageChannel(signal: AbortSignal): MessageChannel {
  const queue: SDKUserMessage[] = [];
  let resolver: (() => void) | null = null;
  let done = signal.aborted;
  let keepOpenOnResult = false;

  if (!done) {
    signal.addEventListener("abort", () => {
      done = true;
      resolver?.();
      resolver = null;
    }, { once: true });
  }

  async function* generator(): AsyncGenerator<SDKUserMessage> {
    while (!done) {
      if (queue.length > 0) {
        yield queue.shift()!;
        continue;
      }
      await new Promise<void>((resolve) => {
        resolver = resolve;
      });
    }
    while (queue.length > 0) {
      yield queue.shift()!;
    }
  }

  return {
    enqueue(message) {
      queue.push(message);
      resolver?.();
      resolver = null;
    },
    generator: generator(),
    close() {
      done = true;
      resolver?.();
      resolver = null;
    },
    keepOpenOnNextResult() {
      keepOpenOnResult = true;
    },
    consumeKeepOpenOnResult() {
      const keepOpen = keepOpenOnResult;
      keepOpenOnResult = false;
      return keepOpen;
    },
  };
}

function shouldKeepChannelOpen(message: SDKMessage): boolean {
  const reason = String((message as { terminal_reason?: unknown }).terminal_reason || "");
  const subtype = String((message as { subtype?: unknown }).subtype || "");
  return ["interrupt", "interrupted", "aborted"].includes(subtype)
    || ["aborted_streaming", "aborted_tools", "tool_deferred", "hook_stopped", "stop_hook_prevented"].includes(reason);
}

function isClosedQueryInterruptError(error: unknown): boolean {
  const message = String(error instanceof Error ? error.message : error || "").toLowerCase();
  return message.includes("query closed before response received")
    || message.includes("query is closed")
    || message.includes("query already closed");
}

function sdkMessageSessionId(message: SDKMessage): string {
  const sessionId = (message as { session_id?: unknown }).session_id;
  return typeof sessionId === "string" ? sessionId : "";
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

function stringProcessEnv(): Record<string, string> {
  return Object.fromEntries(
    Object.entries(process.env).flatMap(([key, value]) => typeof value === "string" ? [[key, value]] : []),
  );
}

function resolveRuntimeRequireFrom(): string {
  const candidates = [
    join(process.cwd(), "package.json"),
    join(process.resourcesPath || "", "app.asar.unpacked", "node_modules", "docx", "package.json"),
    join(process.resourcesPath || "", "app", "package.json"),
    join(process.resourcesPath || "", "package.json"),
    join(__dirname, "..", "package.json"),
  ];
  return resolve(candidates.find((candidate) => existsSync(candidate)) || candidates[0]);
}

function runtimeNodePath(existing?: string): string {
  const paths = [
    process.cwd() ? join(process.cwd(), "node_modules") : "",
    join(process.resourcesPath || "", "app.asar.unpacked", "node_modules"),
    join(process.resourcesPath || "", "app", "node_modules"),
    existing || process.env.NODE_PATH || "",
  ].filter(Boolean);
  return Array.from(new Set(paths)).join(process.platform === "win32" ? ";" : ":");
}

let cachedClaudeSdkCliPath = "";

function resolveClaudeSdkCliPath(): string {
  if (cachedClaudeSdkCliPath && isUsableClaudeSdkCliPath(cachedClaudeSdkCliPath)) {
    return cachedClaudeSdkCliPath;
  }

  const candidates = uniqueStrings(claudeSdkCliPathCandidates().map(realFsPathForAsarCandidate));
  const found = candidates.find(isUsableClaudeSdkCliPath);
  if (found) {
    cachedClaudeSdkCliPath = found;
    return found;
  }

  const existingButNotUsable = candidates.find((candidate) => existsSync(candidate));
  const reason = existingButNotUsable
    ? `找到文件但不可执行：${existingButNotUsable}`
    : "没有找到当前平台的 Claude Agent SDK native binary。";
  throw new Error([
    "Brevyn 本地 Agent 运行组件缺失，无法启动本地 Agent。",
    reason,
    "请重新安装最新版 Brevyn，或重新打包包含当前平台的 @anthropic-ai/claude-agent-sdk native 组件。",
    "检查过的路径：",
    ...candidates.map((candidate) => `- ${candidate}`),
  ].join("\n"));
}

function claudeSdkCliPathCandidates(): string[] {
  const scopedPackageDir = "@anthropic-ai";
  const subpackage = `claude-agent-sdk-${process.platform}-${process.arch}`;
  const binaryName = process.platform === "win32" ? "claude.exe" : "claude";
  const candidates: string[] = [];
  const addFromAnthropicDir = (anthropicDir: string) => {
    if (!anthropicDir) return;
    candidates.push(join(anthropicDir, subpackage, binaryName));
    candidates.push(join(anthropicDir, "claude-agent-sdk", "node_modules", scopedPackageDir, subpackage, binaryName));
  };
  const addFromSdkEntry = (sdkEntryPath: string) => {
    if (!sdkEntryPath) return;
    addFromAnthropicDir(dirname(dirname(sdkEntryPath)));
  };

  try {
    addFromSdkEntry(createRequire(__filename).resolve("@anthropic-ai/claude-agent-sdk"));
  } catch (error) {
    console.warn("[ClaudeSdkAdapter] Failed to resolve Claude Agent SDK entry via createRequire:", error);
  }

  const resourcePath = process.resourcesPath || "";
  addFromAnthropicDir(join(__dirname, "..", "node_modules", scopedPackageDir));
  addFromAnthropicDir(join(process.cwd(), "node_modules", scopedPackageDir));
  addFromAnthropicDir(join(resourcePath, "app.asar", "node_modules", scopedPackageDir));
  addFromAnthropicDir(join(resourcePath, "app.asar.unpacked", "node_modules", scopedPackageDir));
  addFromAnthropicDir(join(resourcePath, "app", "node_modules", scopedPackageDir));

  return candidates;
}

function realFsPathForAsarCandidate(candidate: string): string {
  if (candidate.includes(".asar.unpacked")) return candidate;
  return candidate.replace(/\.asar([/\\])/, ".asar.unpacked$1");
}

function isUsableClaudeSdkCliPath(candidate: string): boolean {
  try {
    const stat = statSync(candidate);
    if (!stat.isFile()) return false;
    if (process.platform === "win32") return true;
    return (stat.mode & 0o111) !== 0;
  } catch {
    return false;
  }
}

function uniqueStrings(values: string[]): string[] {
  return Array.from(new Set(values.filter(Boolean)));
}

function spawnClaudeCodeProcess(sessionKey: string | undefined, spawnOptions: SpawnOptions): SpawnedProcess {
  const child = spawn(spawnOptions.command, spawnOptions.args, {
    cwd: spawnOptions.cwd,
    env: spawnOptions.env,
    signal: spawnOptions.signal,
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
  });
  child.stderr.on("data", (chunk: Buffer) => {
    const text = chunk.toString();
    if (text.trim()) console.warn("[claude-agent-sdk]", text.trimEnd());
  });
  if (sessionKey && child.pid) {
    let forceKillTimer: NodeJS.Timeout | undefined;
    activeSdkProcesses.set(sessionKey, {
      pid: child.pid,
      kill: (signal?: NodeJS.Signals) => child.kill(signal),
    });
    spawnOptions.signal.addEventListener("abort", () => {
      forceKillTimer = setTimeout(() => {
        const current = activeSdkProcesses.get(sessionKey);
        if (current && current.pid === child.pid && child.exitCode === null && !child.killed) {
          current.kill(process.platform === "win32" ? "SIGTERM" : "SIGKILL");
        }
      }, 5_000);
      forceKillTimer.unref?.();
    }, { once: true });
    child.once("exit", () => {
      if (forceKillTimer) clearTimeout(forceKillTimer);
      const current = activeSdkProcesses.get(sessionKey);
      if (current?.pid === child.pid) activeSdkProcesses.delete(sessionKey);
    });
  }
  child.once("error", (error: NodeJS.ErrnoException) => {
    if (["ENOENT", "ENOTDIR", "EACCES", "EPERM"].includes(error.code || "")) {
      console.warn(`[ClaudeSdkAdapter] Failed to spawn Claude Agent SDK binary: ${error.code} ${spawnOptions.command}`);
    }
  });
  return child as unknown as SpawnedProcess;
}

const safeToolPolicy: CanUseTool = async (toolName, input, options): Promise<PermissionResult> => {
  if (options.signal.aborted) {
    return {
      behavior: "deny",
      message: "Agent run was stopped.",
      toolUseID: options.toolUseID,
      decisionClassification: "user_reject",
    };
  }
  if (SAFE_TOOLS.has(toolName) || (toolName === "Bash" && isSafeBashCommand(typeof input.command === "string" ? input.command : ""))) {
    return {
      behavior: "allow",
      toolUseID: options.toolUseID,
      decisionClassification: "user_temporary",
    };
  }
  return {
    behavior: "deny",
    message: `${toolName} requires approval. Approval UI will be enabled in the next implementation stage.`,
    toolUseID: options.toolUseID,
    decisionClassification: "user_reject",
  };
};

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

function isSafeBashCommand(command: string): boolean {
  const trimmed = command.trim();
  if (!trimmed) return false;
  if (/[|;&]/.test(trimmed) || />{1,2}/.test(trimmed) || /\b-exec\b/.test(trimmed) || /\b-delete\b/.test(trimmed) || /\$\(/.test(trimmed) || /`/.test(trimmed)) {
    return false;
  }
  return SAFE_BASH_PATTERNS.some((pattern) => pattern.test(trimmed));
}
