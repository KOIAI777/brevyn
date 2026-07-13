import { randomUUID } from "node:crypto";
import { extname } from "node:path";
import type { CanUseTool, Query, SDKMessage, SdkBeta } from "@anthropic-ai/claude-agent-sdk";
import type {
  AgentApprovalDecision,
  AgentAttachment,
  AgentApprovalInput,
  AgentAskUserResponseInput,
  AgentExitPlanResponseInput,
  AgentPermissionMode,
  AgentQueueMessageInput,
  AgentRunInput,
  AgentRunResult,
  AgentProviderKind,
  BrevynAgentEvent,
  BrevynAgentRuntimeEvent,
  BrevynAgentTimelineRecord,
  BrevynUsageMetadata,
  BrevynTask,
  Course,
  ModelProviderConfig,
  SemesterWorkspace,
  Thread,
  RagSearchResult,
  SkillItem,
  SourceCandidateProposeInput,
  SourceCandidateProposeResult,
} from "../../types/domain";
import { SkillFileStore } from "../skills/skill-file-store";
import { SQLiteBusinessStore } from "../storage";
import { ProviderService, envApiKeyForProvider } from "../services/provider-service";
import { libreOfficeRuntimeEnvironment } from "../services/libreoffice-runtime";
import { ensureAgentProjectScaffold, SEMESTER_HOME_COURSE_ID, workspacePathForThread } from "../services/workspace-paths";
import { AgentEventBus } from "./agent-event-bus";
import { AgentSessionStore } from "./agent-session-store";
import { AskUserService } from "./ask-user-service";
import { createBrevynMcpServer } from "./brevyn-mcp-server";
import { ClaudeSdkAdapter } from "./claude-sdk-adapter";
import { ExitPlanService } from "./exit-plan-service";
import { AgentGatewayService } from "./agent-gateway-service";
import { PermissionService } from "./permission-service";
import { PromptBuilder } from "./prompt-builder";
import { recommendedSdkThinkingForModel } from "./sdk-thinking-capability";
import { ThreadTitleService } from "./thread-title-service";
import { BREVYN_MCP_TOOL_ALIASES } from "../../shared/brevyn-mcp-catalog";
import {
  brevynUsageFromAnthropicUsage,
  brevynUsageFromModelUsage,
  mergeModelUsageContextWindow,
  mergeBrevynUsage,
  recordOf,
} from "../../shared/agent-usage";
import { formatAgentUserError, isAgentBillingError, isNonRetryableAgentError } from "../../shared/agent-error-format";
import { isOneMillionContextModel } from "../../shared/model-context-window";

interface AgentOrchestratorOptions {
  rootDataDir: string;
  businessStore: SQLiteBusinessStore;
  providers: ProviderService;
  skillFiles: SkillFileStore;
  sessions: AgentSessionStore;
  eventBus: AgentEventBus;
  promptBuilder: PromptBuilder;
  permissions: PermissionService;
  askUsers: AskUserService;
  exitPlans: ExitPlanService;
  sdk: ClaudeSdkAdapter;
  gateway?: AgentGatewayService;
  ragSearch?: (input: { query: string; courseId?: string; taskId?: string; sectionKind?: "course_shared" | "lecture" | "task"; limit?: number }) => Promise<RagSearchResult[]>;
  proposeExternalSource?: (input: SourceCandidateProposeInput) => SourceCandidateProposeResult;
}

interface ActiveRun {
  runId: string;
  threadId: string;
  abortController: AbortController;
  query?: Query;
  context: ResolvedThreadContext;
  stoppedByUser: boolean;
  permissionMode: AgentPermissionMode;
  providerId?: string;
  modelId?: string;
  gatewayToken?: string;
  ignoreNextResult?: boolean;
  suppressUntilInterruptResult?: boolean;
  terminalResultWritten: boolean;
  terminalLifecycleWritten: boolean;
  terminalLifecycleEvent?: BrevynAgentRuntimeEvent;
  assistantErrorWritten: boolean;
  compactCommand: boolean;
  compactBoundaryWritten: boolean;
  compactFailedWritten: boolean;
  contextUsageSnapshotFromStream: boolean;
}

interface ResolvedThreadContext {
  thread: Thread;
  semester: SemesterWorkspace;
  course: Course | null;
  task: BrevynTask | null;
  cwd: string;
}

export class AgentOrchestrator {
  private readonly activeRuns = new Map<string, ActiveRun>();
  private readonly titleService: ThreadTitleService;

  constructor(private readonly options: AgentOrchestratorOptions) {
    this.titleService = new ThreadTitleService({
      businessStore: options.businessStore,
      providers: options.providers,
      eventBus: options.eventBus,
    });
  }

  messages(threadId: string): BrevynAgentTimelineRecord[] {
    const context = this.resolveThreadContext(threadId);
    if (!this.activeRuns.has(context.thread.id)) {
      this.options.sessions.reconcileInterruptedRuns(context.thread);
    }
    return this.options.sessions.read(context.thread);
  }

  async run(input: AgentRunInput): Promise<AgentRunResult> {
    let context = this.resolveThreadContext(input.threadId);
    const existingRun = this.activeRuns.get(context.thread.id);
    if (existingRun) throw new Error("An agent run is already active for this thread.");
    context = this.updateWorkflowForUserPrompt(context, input.prompt, input.mentionedSkills);

    const runId = entityId("run");
    const abortController = new AbortController();
    const resumeSessionId = context.thread.sdkSessionId;
    const attachments = input.attachments || [];
    const displayPrompt = input.displayPrompt?.trim() || input.prompt;
    const selectedProvider = this.options.providers.agentProviderFor(input.providerId, input.modelId);
    const compactCommand = isCompactPrompt(input.prompt);
    const shouldAutoTitle = !compactCommand && !input.skipAutoTitle && shouldGenerateTitleForRun(context.thread);
    const agentPrompt = promptWithWorkflow(
      promptWithMentionedSkills(input.prompt, input.mentionedSkills, this.options.skillFiles.listSkills()),
      context.thread.workflow,
      input.prompt,
    );
    const promptForAgent = compactCommand
      ? "/compact"
      : promptWithAttachments(agentPrompt, attachments);
    this.activeRuns.set(context.thread.id, {
      runId,
      threadId: context.thread.id,
      abortController,
      context,
      stoppedByUser: false,
      permissionMode: input.permissionMode || "auto",
      providerId: input.providerId,
      modelId: input.modelId,
      terminalResultWritten: false,
      terminalLifecycleWritten: false,
      terminalLifecycleEvent: undefined,
      assistantErrorWritten: false,
      compactCommand,
      compactBoundaryWritten: false,
      compactFailedWritten: false,
      contextUsageSnapshotFromStream: false,
    });

    try {
      if (compactCommand) {
        this.appendAndEmitSdkMessage(context.thread, compactingSdkMessage());
      } else {
        this.appendAndEmitSdkMessage(context.thread, userSdkMessage(displayPrompt, attachments, input.uuid));
      }
      this.appendAndEmitRuntimeEvent(context.thread, {
        type: "run_started",
        runId,
        threadId: context.thread.id,
        permissionMode: input.permissionMode || "auto",
        providerId: selectedProvider?.id || input.providerId,
        modelId: selectedProvider?.selectedModel || input.modelId,
        providerProtocol: selectedProvider?.protocol === "openai_responses" ? "openai_responses" : selectedProvider?.protocol === "anthropic_messages" ? "anthropic_messages" : undefined,
        createdAt: now(),
      });
      if (input.permissionMode === "plan") {
        this.appendAndEmitRuntimeEvent(context.thread, {
          type: "plan_mode_entered",
          runId,
          threadId: context.thread.id,
          createdAt: now(),
        });
      }
    } catch (error) {
      this.activeRuns.delete(context.thread.id);
      throw error;
    }

    const titleUserMessage = shouldAutoTitle ? displayPrompt : undefined;
    void this.executeRun(context, runId, promptForAgent, resumeSessionId, compactCommand, titleUserMessage);
    return { runId };
  }

  private async executeRun(context: ResolvedThreadContext, runId: string, prompt: string, initialResumeSessionId?: string, slashCommand = false, titleUserMessage?: string): Promise<void> {
    try {
      const active = this.activeRuns.get(context.thread.id);
      if (!active) return;
      let resumeSessionId = initialResumeSessionId;
      const provider = this.options.providers.agentProviderFor(active.providerId, active.modelId);
      if (!provider) {
        throw new Error("Configure at least one enabled agent provider before running the agent.");
      }
      const apiKey = this.options.providers.apiKey(provider.id) || envApiKeyForProvider(provider);
      if (!apiKey) {
        throw new Error(`Agent provider "${provider.name}" is missing an API key.`);
      }

      const projectScaffold = ensureAgentProjectScaffold(context.cwd, context.thread.id);
      const availableSkills = this.options.skillFiles.listSkills();
      const systemPromptAppend = [
        this.options.promptBuilder.buildSystemPrompt({
          semester: context.semester,
          course: context.course,
          task: context.task,
          thread: context.thread,
          cwd: context.cwd,
          sessionContextDir: projectScaffold.sessionContextDir,
        }),
        buildAvailableSkillsPrompt(availableSkills),
        permissionInstructions(active),
      ].join("\n\n");
      const systemPrompt = {
        type: "preset" as const,
        preset: "claude_code" as const,
        append: systemPromptAppend,
      };
      const env = await this.buildSdkEnvForProvider(provider, apiKey, active);
      const sdkRuntime = await this.options.sdk.loadSdk();
      const mcpServers = {
        brevyn: createBrevynMcpServer({
          sdk: sdkRuntime,
          rootDataDir: this.options.rootDataDir,
          businessStore: this.options.businessStore,
          ragSearch: this.options.ragSearch,
          proposeExternalSource: this.options.proposeExternalSource,
          onTaskUpdated: (task) => this.options.eventBus.emit({ kind: "task_updated", task }),
          context,
        }),
      };
      let completed = false;
      let retryReason = "";
      let titleGenerationStarted = false;
      for (let attempt = 1; attempt <= AGENT_RUN_MAX_RETRIES + 1; attempt += 1) {
        if (attempt > 1) {
          const delayMs = retryDelayMs(attempt - 1);
          this.emitRuntimeEventOnly({
            type: "run_retrying",
            runId,
            threadId: context.thread.id,
            retryAttempt: attempt - 1,
            maxRetries: AGENT_RUN_MAX_RETRIES,
            reason: formatAgentUserError(retryReason || "Agent request failed."),
            delayMs,
            createdAt: now(),
          });
          await delay(delayMs, active.abortController.signal);
          if (active.abortController.signal.aborted) break;
          this.emitRetryCleared(active);
        }

        const attemptAbort = createAttemptAbortController(active.abortController.signal, AGENT_RUN_ATTEMPT_TIMEOUT_MS);
        let retryCurrentAttempt = "";
        try {
          const thinkingRecommendation = recommendedSdkThinkingForModel(provider.providerKind as AgentProviderKind, provider.selectedModel);
          const stream = this.options.sdk.query({
            prompt,
            slashCommand,
            sessionKey: context.thread.id,
            cwd: context.cwd,
            model: provider.selectedModel,
            env,
            systemPrompt,
            settings: {
              autoMemoryEnabled: true,
              autoMemoryDirectory: projectScaffold.autoMemoryDir,
              plansDirectory: projectScaffold.sessionPlanRelativeDir,
            },
            resumeSessionId,
            abortController: attemptAbort.controller,
            mcpServers,
            permissionMode: active.permissionMode,
            allowDangerouslySkipPermissions: active.permissionMode === "bypassPermissions",
            planModeInstructions: active.permissionMode === "plan" ? PLAN_MODE_INSTRUCTIONS : undefined,
            betas: sdkBetasForModel(provider.selectedModel),
            ...thinkingRecommendation,
            plugins: [{ type: "local", path: this.options.skillFiles.nativePluginRootPath() }],
            skills: "all",
            toolAliases: brevynMcpToolAliases(),
            canUseTool: this.createCanUseTool(context, runId),
            onQuery: (query) => {
              active.query = query;
            },
            onSessionId: (sessionId) => {
              const sessionChanged = resumeSessionId !== sessionId;
              resumeSessionId = sessionId;
              if (sessionChanged) this.saveSdkSessionId(context.thread.id, sessionId);
              if (!titleUserMessage || titleGenerationStarted) return;
              titleGenerationStarted = true;
              this.scheduleTitleGeneration({
                threadId: context.thread.id,
                userMessage: titleUserMessage,
                providerId: provider.id,
                modelId: provider.selectedModel,
              });
            },
          });
          for await (const message of stream) {
            const current = this.activeRuns.get(context.thread.id);
            if (message.type === "result" && current?.ignoreNextResult) {
              current.ignoreNextResult = false;
              current.suppressUntilInterruptResult = false;
              continue;
            }
            if (current?.suppressUntilInterruptResult && message.type !== "result") {
              continue;
            }
            if (message.type === "result" && isContinuableSdkResult(message)) continue;

            const assistantError = message.type === "assistant" ? sdkAssistantErrorMessage(message) : undefined;
            const fatalBillingError = firstBillingError(assistantError, message.type === "result" ? sdkResultErrorMessage(message) : undefined);
            if (fatalBillingError && current) {
              if (current.compactCommand) {
                this.writeCompactFailed(current, fatalBillingError);
              } else {
                this.writeAssistantError(current, fatalBillingError);
              }
              this.writeTerminalResult(current, "error_during_execution", fatalBillingError);
              this.writeTerminalLifecycle(current, "failed", fatalBillingError);
              current.query?.close();
              current.abortController.abort(new Error(fatalBillingError));
              break;
            }
            if (assistantError && attempt <= AGENT_RUN_MAX_RETRIES && isRetryableAgentRunError(assistantError)) {
              retryCurrentAttempt = assistantError;
              active.query?.close();
              break;
            }
            const resultError = message.type === "result" && lifecycleForResult(message) === "failed"
              ? sdkResultErrorMessage(message)
              : undefined;
            if (resultError && attempt <= AGENT_RUN_MAX_RETRIES && isRetryableAgentRunError(resultError)) {
              retryCurrentAttempt = resultError;
              active.query?.close();
              break;
            }

            if (shouldPersistSdkMessage(message)) {
              if (current && isCompactBoundaryMessage(message)) current.compactBoundaryWritten = true;
              if (message.type === "result" && current && lifecycleForResult(message) === "failed") {
                if (resultError) this.writeAssistantError(current, resultError);
              }
              const persistedMessage = this.appendAndEmitSdkMessage(context.thread, withCreatedAt(message));
              if (message.type === "assistant" && current) {
                if (this.emitContextUsageSnapshot(current, persistedMessage)) {
                  current.contextUsageSnapshotFromStream = true;
                }
              }
              if (message.type === "assistant" && assistantError) {
                if (current) {
                  current.assistantErrorWritten = true;
                  this.writeTerminalResult(current, "error_during_execution", assistantError);
                  this.writeTerminalLifecycle(current, "failed", assistantError);
                  current.query?.close();
                  break;
                }
              }
              if (message.type === "result") {
                if (current) {
                  const lifecycle = lifecycleForResult(message);
                  const compactError = current.compactCommand ? compactResultErrorMessage(message) : undefined;
                  const effectiveLifecycle = compactError ? "failed" : lifecycle;
                  if (compactError) {
                    this.writeCompactFailed(current, compactError);
                  }
                  if (current.compactCommand && effectiveLifecycle === "completed" && !current.compactBoundaryWritten) {
                    this.appendAndEmitSdkMessage(context.thread, compactBoundarySdkMessage());
                    current.compactBoundaryWritten = true;
                  }
                  current.terminalResultWritten = true;
                  if (!current.contextUsageSnapshotFromStream) {
                    this.emitContextUsageSnapshot(current, persistedMessage);
                  }
                  this.writeTerminalLifecycle(current, effectiveLifecycle, compactError || String((message as { result?: unknown }).result || ""));
                }
              }
            } else if (shouldEmitLiveSdkMessage(message)) {
              this.options.eventBus.emit({ kind: "sdk_message", threadId: context.thread.id, message });
            }
          }
          if (retryCurrentAttempt) {
            retryReason = retryCurrentAttempt;
            continue;
          }
          if (active.abortController.signal.aborted) {
            if (!active.terminalLifecycleWritten) {
              this.writeTerminalResult(active, active.stoppedByUser ? "stopped_by_user" : "error_during_execution", "Agent run stopped.");
              this.writeTerminalLifecycle(active, active.stoppedByUser ? "stopped" : "failed", "Agent run stopped.");
            }
          }
          if (!active.terminalLifecycleWritten) {
            const message = active.assistantErrorWritten ? "Agent provider request failed." : "Agent run ended without a result.";
            if (!active.assistantErrorWritten) this.writeAssistantError(active, message);
            this.writeTerminalResult(active, "error_during_execution", message);
            this.writeTerminalLifecycle(active, "failed", message);
          }
          completed = true;
          break;
        } catch (error) {
          const message = attemptAbort.timedOut()
            ? `Agent request timed out after ${Math.round(AGENT_RUN_ATTEMPT_TIMEOUT_MS / 1000)}s.`
            : errorMessage(error);
          if (!active.abortController.signal.aborted && attempt <= AGENT_RUN_MAX_RETRIES && isRetryableAgentRunError(message)) {
            retryReason = message;
            active.query?.close();
            continue;
          }
          if (!active.abortController.signal.aborted && retryReason && isRetryableAgentRunError(message)) {
            retryReason = message;
            active.query?.close();
            break;
          }
          throw new Error(message);
        } finally {
          attemptAbort.dispose();
          if (active.query) active.query = undefined;
        }
      }
      if (!completed && !active.terminalLifecycleWritten) {
        const message = active.abortController.signal.aborted
          ? "Agent run stopped."
          : retryReason
            ? `重试 ${AGENT_RUN_MAX_RETRIES} 次后仍然失败：${formatAgentUserError(retryReason)}`
            : "Agent run failed.";
        if (!active.stoppedByUser) this.writeAssistantError(active, message);
        this.emitRetryCleared(active);
        this.writeTerminalResult(active, active.stoppedByUser ? "stopped_by_user" : "error_during_execution", message);
        this.writeTerminalLifecycle(active, active.stoppedByUser ? "stopped" : "failed", message);
      }
    } catch (error) {
      const active = this.activeRuns.get(context.thread.id);
      const stoppedByUser = Boolean(active?.stoppedByUser);
      const message = active?.abortController.signal.aborted ? "Agent run stopped." : errorMessage(error);
      if (isInvalidSdkSessionError(message)) this.saveSdkSessionId(context.thread.id, undefined);
      if (!stoppedByUser && active) this.writeAssistantError(active, message);
      else if (!stoppedByUser) this.appendAndEmitSdkMessage(context.thread, assistantErrorSdkMessage(formatAgentUserError(message), errorCodeForMessage(message)));
      if (active) {
        this.writeTerminalResult(active, stoppedByUser ? "stopped_by_user" : "error_during_execution", message);
        this.writeTerminalLifecycle(active, stoppedByUser ? "stopped" : "failed", message);
      } else {
        this.appendAndEmitSdkMessage(context.thread, resultSdkMessage("error_during_execution", formatAgentUserError(message)));
      }
    } finally {
      const active = this.activeRuns.get(context.thread.id);
      if (active?.runId !== runId) return;
      this.finishActiveRun(active);
    }
  }

  private scheduleTitleGeneration(input: { threadId: string; userMessage: string; providerId?: string; modelId?: string }): void {
    setTimeout(() => {
      void this.titleService.maybeGenerate({
        ...input,
        allowAfterFirstMessage: true,
      });
    }, 0);
  }

  private saveSdkSessionId(threadId: string, sdkSessionId?: string): void {
    try {
      this.options.businessStore.updateThreadSdkSessionId(threadId, sdkSessionId);
    } catch (error) {
      console.warn("[AgentOrchestrator] Failed to update SDK session metadata:", error);
    }
  }

  private async buildSdkEnvForProvider(provider: ModelProviderConfig, apiKey: string, active: ActiveRun): Promise<Record<string, string>> {
    const officeRuntimeEnv = libreOfficeRuntimeEnvironment(this.options.rootDataDir);
    if (provider.protocol !== "openai_responses") {
      return {
        ...this.options.sdk.buildEnv(provider, apiKey),
        ...officeRuntimeEnv,
      };
    }
    if (!this.options.gateway) {
      throw new Error("OpenAI Responses agent provider requires the local Anthropic gateway.");
    }
    const baseUrl = await this.options.gateway.start();
    const registration = this.options.gateway.registerSession({
      provider,
      apiKey,
      signal: active.abortController.signal,
    });
    active.gatewayToken = registration.token;
    return {
      ANTHROPIC_API_KEY: registration.token,
      ANTHROPIC_BASE_URL: baseUrl,
      ...officeRuntimeEnv,
    };
  }

  private createCanUseTool(context: ResolvedThreadContext, runId: string): CanUseTool {
    const permissionCanUseTool = this.options.permissions.createCanUseTool({
      threadId: context.thread.id,
      runId,
      mode: this.activeRuns.get(context.thread.id)?.permissionMode || "auto",
      onRequest: (request) => {
        this.appendAndEmitRuntimeEvent(context.thread, {
          type: "approval_requested",
          request,
          createdAt: request.createdAt,
        });
      },
    });
    return async (toolName, toolInput, options) => {
      if (toolName === "EnterPlanMode") {
        this.appendAndEmitRuntimeEvent(context.thread, {
          type: "plan_mode_entered",
          runId,
          threadId: context.thread.id,
          createdAt: now(),
        });
        return {
          behavior: "allow",
          updatedInput: toolInput,
          toolUseID: options.toolUseID,
          decisionClassification: "user_temporary",
        };
      }
      if (toolName === "ExitPlanMode") {
        return await this.options.exitPlans.request({
          threadId: context.thread.id,
          runId,
          toolInput,
          toolUseID: options.toolUseID,
          signal: options.signal,
          onRequest: (request) => {
            this.appendAndEmitRuntimeEvent(context.thread, {
              type: "exit_plan_requested",
              request,
              createdAt: request.createdAt,
            });
          },
        });
      }
      if (toolName === "AskUserQuestion") {
        return await this.options.askUsers.ask({
          threadId: context.thread.id,
          runId,
          toolInput,
          toolUseID: options.toolUseID,
          signal: options.signal,
          onRequest: (request) => {
            this.appendAndEmitRuntimeEvent(context.thread, {
              type: "ask_user_requested",
              request,
              createdAt: request.createdAt,
            });
          },
        });
      }
      return await permissionCanUseTool(toolName, toolInput, options);
    };
  }

  stop(threadId: string): boolean {
    const active = this.activeRuns.get(threadId);
    if (!active) return false;
    active.stoppedByUser = true;
    active.abortController.abort();
    active.query?.close();
    this.writeTerminalResult(active, "stopped_by_user", "Agent run stopped.");
    this.writeTerminalLifecycle(active, "stopped", "Agent run stopped.");
    this.clearActiveRunInteractions(active);
    return true;
  }

  async queueMessage(input: AgentQueueMessageInput): Promise<string> {
    let context = this.resolveThreadContext(input.threadId);
    const active = this.activeRuns.get(context.thread.id);
    if (!active) throw new Error("No active agent run is available for this thread.");
    context = this.updateWorkflowForUserPrompt(context, input.prompt, input.mentionedSkills);
    if (!this.options.sdk.canQueueMessage(context.thread.id)) {
      throw new Error("No active Claude SDK input channel is available for this thread.");
    }
    const uuid = input.uuid || entityId("msg");
    const attachments = input.attachments || [];
    if (input.interrupt !== false) {
      active.ignoreNextResult = true;
      active.suppressUntilInterruptResult = true;
    }
    try {
      await this.options.sdk.queueMessage(
        context.thread.id,
        promptWithAttachments(promptWithWorkflow(
          promptWithMentionedSkills(input.prompt, input.mentionedSkills, this.options.skillFiles.listSkills()),
          context.thread.workflow,
          input.prompt,
        ), attachments),
        uuid,
        input.interrupt ?? true,
      );
      this.appendAndEmitSdkMessage(context.thread, userSdkMessage(input.prompt, attachments, uuid));
    } catch (error) {
      if (input.interrupt !== false) {
        active.ignoreNextResult = false;
        active.suppressUntilInterruptResult = false;
      }
      throw error;
    }
    return uuid;
  }

  stopAll(): void {
    for (const threadId of Array.from(this.activeRuns.keys())) {
      this.stop(threadId);
    }
  }

  approve(input: AgentApprovalInput): boolean {
    return this.resolveApproval(input, "allow");
  }

  reject(input: AgentApprovalInput): boolean {
    return this.resolveApproval(input, "deny");
  }

  answerQuestion(input: AgentAskUserResponseInput): boolean {
    const context = this.resolveThreadContext(input.threadId);
    const active = this.activeRuns.get(context.thread.id);
    const runId = active?.runId || entityId("run");
    const resolved = this.options.askUsers.answer(input);
    if (resolved) {
      this.appendAndEmitRuntimeEvent(context.thread, {
        type: "ask_user_resolved",
        runId,
        threadId: context.thread.id,
        requestId: input.requestId,
        answers: input.answers,
        createdAt: now(),
      });
    }
    return resolved;
  }

  resolveExitPlan(input: AgentExitPlanResponseInput): boolean {
    const context = this.resolveThreadContext(input.threadId);
    const active = this.activeRuns.get(context.thread.id);
    const runId = active?.runId || entityId("run");
    const resolved = this.options.exitPlans.resolve(input);
    if (resolved) {
      if (active && input.decision === "approve") {
        active.permissionMode = "auto";
        void active.query?.setPermissionMode("auto").catch((error) => {
          console.warn("[AgentOrchestrator] Failed to switch SDK permission mode after plan approval:", error);
        });
      }
      this.appendAndEmitRuntimeEvent(context.thread, {
        type: "exit_plan_resolved",
        runId,
        threadId: context.thread.id,
        requestId: input.requestId,
        decision: input.decision,
        feedback: input.feedback,
        createdAt: now(),
      });
    }
    return resolved;
  }

  onEvent(listener: (event: BrevynAgentEvent) => void): () => void {
    return this.options.eventBus.on(listener);
  }

  private resolveApproval(input: AgentApprovalInput, decision: AgentApprovalDecision): boolean {
    const context = this.resolveThreadContext(input.threadId);
    const active = this.activeRuns.get(context.thread.id);
    const runId = active?.runId || entityId("run");
    const resolved = this.options.permissions.resolve(context.thread.id, input.requestId, decision);
    if (resolved) {
      this.appendAndEmitRuntimeEvent(context.thread, {
        type: "approval_resolved",
        runId,
        threadId: context.thread.id,
        requestId: input.requestId,
        decision,
        createdAt: now(),
      });
    }
    return resolved;
  }

  private appendAndEmitSdkMessage(thread: Thread, message: SDKMessage): SDKMessage {
    const normalized = this.withActiveRunUsageMetadata(thread.id, message);
    this.options.sessions.append(thread, normalized);
    this.options.businessStore.recordThreadMessage(thread.id);
    this.options.eventBus.emit({ kind: "sdk_message", threadId: thread.id, message: normalized });
    return normalized;
  }

  private appendAndEmitRuntimeEvent(thread: Thread, event: BrevynAgentRuntimeEvent): void {
    this.options.sessions.append(thread, { kind: "runtime", event });
    this.options.eventBus.emit({ kind: "brevyn_event", event });
  }

  private emitRuntimeEventOnly(event: BrevynAgentRuntimeEvent): void {
    this.options.eventBus.emit({ kind: "brevyn_event", event });
  }

  private emitRetryCleared(active: ActiveRun): void {
    this.emitRuntimeEventOnly({
      type: "run_retry_cleared",
      runId: active.runId,
      threadId: active.threadId,
      createdAt: now(),
    });
  }

  private emitContextUsageSnapshot(active: ActiveRun, message: SDKMessage): boolean {
    const usage = recordOf((message as unknown as Record<string, unknown>)._brevynUsage);
    const usedTokens = positiveInteger(usage.contextInputTokens) || positiveInteger(usage.inputTokens);
    if (!usedTokens) return false;
    const contextWindow = positiveInteger(usage.contextWindow);
    const createdAt = now();
    this.appendAndEmitRuntimeEvent(active.context.thread, {
      type: "context_usage_updated",
      snapshot: {
        threadId: active.threadId,
        runId: active.runId,
        modelId: stringValue(usage.modelId) || active.modelId,
        usedTokens,
        maxTokens: contextWindow || undefined,
        rawMaxTokens: contextWindow || undefined,
        percentage: contextWindow ? (usedTokens / contextWindow) * 100 : undefined,
        createdAt,
      },
      createdAt,
    });
    return true;
  }

  private writeTerminalResult(active: ActiveRun, subtype: string, message: string): void {
    if (active.terminalResultWritten) return;
    active.terminalResultWritten = true;
    this.appendAndEmitSdkMessage(active.context.thread, resultSdkMessage(subtype, formatAgentUserError(message)));
  }

  private writeAssistantError(active: ActiveRun, message: string): void {
    if (active.assistantErrorWritten) return;
    active.assistantErrorWritten = true;
    const userMessage = formatAgentUserError(message);
    this.appendAndEmitSdkMessage(active.context.thread, assistantErrorSdkMessage(userMessage, errorCodeForMessage(message)));
  }

  private writeCompactFailed(active: ActiveRun, message: string): void {
    if (active.compactFailedWritten) return;
    active.compactFailedWritten = true;
    this.appendAndEmitSdkMessage(active.context.thread, compactFailedSdkMessage(message));
  }

  private finishActiveRun(active: ActiveRun): void {
    if (this.activeRuns.get(active.threadId)?.runId !== active.runId) return;
    const terminalLifecycleEvent = active.terminalLifecycleEvent;
    this.releaseActiveRun(active);
    if (terminalLifecycleEvent) {
      this.appendAndEmitRuntimeEvent(active.context.thread, terminalLifecycleEvent);
    }
  }

  private releaseActiveRun(active: ActiveRun): void {
    if (active.gatewayToken) {
      this.options.gateway?.unregisterSession(active.gatewayToken);
      active.gatewayToken = undefined;
    }
    this.clearActiveRunInteractions(active);
    this.activeRuns.delete(active.threadId);
  }

  private clearActiveRunInteractions(active: ActiveRun): void {
    this.options.permissions.clearThread(active.threadId);
    this.options.askUsers.clearThread(active.threadId);
    this.options.exitPlans.clearThread(active.threadId);
  }

  private writeTerminalLifecycle(active: ActiveRun, status: "completed" | "stopped" | "failed", message?: string): void {
    if (active.terminalLifecycleWritten) return;
    active.terminalLifecycleWritten = true;
    const createdAt = now();
    this.emitRetryCleared(active);
    if (status === "completed") {
      active.terminalLifecycleEvent = {
        type: "run_completed",
        runId: active.runId,
        threadId: active.threadId,
        createdAt,
      };
      return;
    }
    if (status === "stopped") {
      active.terminalLifecycleEvent = {
        type: "run_stopped",
        runId: active.runId,
        threadId: active.threadId,
        reason: message,
        createdAt,
      };
      return;
    }
    active.terminalLifecycleEvent = {
      type: "run_failed",
      runId: active.runId,
      threadId: active.threadId,
      error: formatAgentUserError(message || "Agent run failed."),
      createdAt,
    };
  }

  private updateWorkflowForUserPrompt(context: ResolvedThreadContext, prompt: string, mentionedSkills?: string[]): ResolvedThreadContext {
    const wantsPptSkill = mentionedSkills?.includes("ppt-master");
    const existing = context.thread.workflow;
    const nextWorkflow = isPptWorkflowExitPrompt(prompt)
      ? undefined
      : existing?.type === "ppt" && isPptWorkflowGenerationPrompt(prompt)
        ? { ...existing, phase: "generating" as const, updatedAt: Date.now() }
      : wantsPptSkill && existing?.type !== "ppt"
        ? {
            type: "ppt" as const,
            skillSlug: "ppt-master",
            phase: "planning" as const,
            startedAt: Date.now(),
            updatedAt: Date.now(),
          }
        : existing;
    if (nextWorkflow === existing) return context;
    const updated = this.options.businessStore.updateThreadWorkflow(context.thread.id, nextWorkflow);
    if (!updated) return context;
    this.options.eventBus.emit({ kind: "thread_updated", thread: updated });
    return { ...context, thread: updated };
  }

  private withActiveRunUsageMetadata(threadId: string, message: SDKMessage): SDKMessage {
    const active = this.activeRuns.get(threadId);
    const provider = active ? this.options.providers.agentProviderFor(active.providerId, active.modelId) : undefined;
    if (!provider) return message;

    const base = message as unknown as Record<string, unknown>;
    const providerProtocol = provider.protocol === "openai_responses" ? "openai_responses" : "anthropic_messages";
    const activeModelId = active?.modelId || provider.selectedModel;
    const modelId = stringValue(base._channelModelId)
      || activeModelId
      || stringValue(recordOf(base.message).model)
      || provider.selectedModel;
    const existingBrevynUsage = recordOf(base._brevynUsage);
    let brevynUsage = Object.keys(existingBrevynUsage).length > 0 ? mergeBrevynUsage(existingBrevynUsage as unknown as BrevynUsageMetadata, {
      providerProtocol,
      providerId: provider.id,
      modelId,
      provider,
    }) : undefined;

    if (!brevynUsage && message.type === "assistant") {
      brevynUsage = brevynUsageFromAnthropicUsage(recordOf(base.message).usage, {
        providerProtocol,
        providerId: provider.id,
        modelId,
        provider,
      });
    }

    if (message.type === "result") {
      const source = {
        providerProtocol,
        providerId: provider.id,
        modelId,
        provider,
      } as const;
      const resultUsage = brevynUsageFromAnthropicUsage(base.usage, source);
      brevynUsage = mergeModelUsageContextWindow(resultUsage || brevynUsage, base.modelUsage, source)
        || brevynUsageFromModelUsage(base.modelUsage, source);
    }

    const next: Record<string, unknown> = {
      ...base,
      _channelProviderId: stringValue(base._channelProviderId) || provider.id,
      _channelModelId: stringValue(base._channelModelId) || modelId,
    };
    if (brevynUsage) next._brevynUsage = brevynUsage;
    return next as unknown as SDKMessage;
  }

  private resolveThreadContext(threadId: string): ResolvedThreadContext {
    const thread = this.options.businessStore.getThread(threadId);
    if (!thread) throw new Error(`Thread not found: ${threadId}`);
    if (thread.archivedAt) throw new Error("Restore the thread before running the agent.");
    if (!thread.semesterId) throw new Error(`Thread ${thread.id} has no semester scope.`);

    const semester = this.options.businessStore.getSemester(thread.semesterId);
    if (!semester) throw new Error(`Semester not found: ${thread.semesterId}`);
    if (semester.archivedAt) throw new Error("Restore this semester before running the agent.");

    const course = thread.courseId === SEMESTER_HOME_COURSE_ID ? null : this.options.businessStore.getCourse(thread.courseId);
    if (thread.courseId !== SEMESTER_HOME_COURSE_ID) {
      if (!course) throw new Error(`Course not found: ${thread.courseId}`);
      if (course.semesterId !== thread.semesterId) throw new Error("Thread course does not belong to this semester.");
      if (course.archivedAt) throw new Error("Restore this course before running the agent.");
    }

    const task = thread.taskId ? this.options.businessStore.getTask(thread.taskId) : null;
    if (thread.courseId !== SEMESTER_HOME_COURSE_ID) {
      if (!thread.taskId) throw new Error("Create sessions from a task, not the course container.");
      if (!task) throw new Error(`Task not found: ${thread.taskId}`);
      if (task.courseId !== thread.courseId) throw new Error("Task does not belong to this course.");
      if (!task.semesterId || task.semesterId !== thread.semesterId) throw new Error("Task does not belong to this semester.");
    }

    const cwd = workspacePathForThread(this.options.rootDataDir, thread, (taskId) => this.options.businessStore.getTask(taskId) || undefined);
    return { thread, semester, course, task, cwd };
  }
}

const PLAN_MODE_INSTRUCTIONS = [
  "You are in Brevyn Plan Mode.",
  "First inspect enough context to understand the user's request. Prefer Read, Glob, Grep, TodoRead, TodoWrite, and Brevyn MCP tools.",
  "Do not edit files, run destructive commands, or make lasting changes while planning.",
  "Produce a concise implementation plan with risks and verification steps.",
  "When the user explicitly approves execution, call ExitPlanMode with allowedPrompts that describe the action categories you need, then continue only after approval.",
].join("\n");

const AGENT_RUN_MAX_RETRIES = 5;
const AGENT_RUN_ATTEMPT_TIMEOUT_MS = 5 * 60 * 1000;
const AGENT_RETRY_MAX_DELAY_MS = 10_000;

function permissionInstructions(active: ActiveRun): string {
  if (active.permissionMode === "plan") {
    return [
      "Permission mode for this run: Plan Mode.",
      "Do not edit files, run destructive commands, or make lasting changes while planning.",
    ].join("\n");
  }
  if (active.permissionMode === "bypassPermissions") {
    return [
      "Permission mode for this run: Full Auto.",
      "The user has allowed Brevyn to edit files and run commands without per-tool confirmation for this run.",
      "Still act carefully: inspect before editing, avoid destructive commands unless explicitly requested, and summarize changes after execution.",
    ].join("\n");
  }
  return [
    "Permission mode for this run: Auto Approval.",
    "Use the Claude Agent SDK auto permission classifier. If an operation is denied, explain the reason clearly and suggest a safer next step.",
  ].join("\n");
}

function entityId(prefix: string): string {
  return `${prefix}_${randomUUID().replace(/-/g, "").slice(0, 16)}`;
}

function sdkBetasForModel(modelId: string): SdkBeta[] {
  return supports1MContext(modelId) ? ["context-1m-2025-08-07"] : [];
}

function isCompactPrompt(prompt: string): boolean {
  return prompt.trim() === "/compact";
}

function supports1MContext(modelId: string): boolean {
  return isOneMillionContextModel(modelId);
}

function brevynMcpToolAliases(): Record<string, string> {
  return BREVYN_MCP_TOOL_ALIASES;
}

function now(): string {
  return new Date().toISOString();
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error || "Unknown agent error");
}

function stringValue(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function retryDelayMs(attempt: number): number {
  const base = Math.min(1000 * (2 ** Math.max(0, attempt - 1)), AGENT_RETRY_MAX_DELAY_MS);
  const jitter = base * (Math.random() * 0.4 - 0.2);
  return Math.max(0, Math.round(base + jitter));
}

function delay(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (ms <= 0 || signal.aborted) {
      resolve();
      return;
    }
    const timeout = setTimeout(resolve, ms);
    signal.addEventListener("abort", () => {
      clearTimeout(timeout);
      resolve();
    }, { once: true });
  });
}

function createAttemptAbortController(parentSignal: AbortSignal, timeoutMs: number): {
  controller: AbortController;
  dispose: () => void;
  timedOut: () => boolean;
} {
  const controller = new AbortController();
  let timeoutReached = false;
  const abortFromParent = () => controller.abort(parentSignal.reason);
  if (parentSignal.aborted) abortFromParent();
  else parentSignal.addEventListener("abort", abortFromParent, { once: true });
  const timeout = setTimeout(() => {
    timeoutReached = true;
    controller.abort(new Error(`Agent request timed out after ${Math.round(timeoutMs / 1000)}s.`));
  }, timeoutMs);
  return {
    controller,
    dispose: () => {
      clearTimeout(timeout);
      parentSignal.removeEventListener("abort", abortFromParent);
    },
    timedOut: () => timeoutReached,
  };
}

function isRetryableAgentRunError(message: string): boolean {
  const normalized = message.toLowerCase();
  if (!normalized.trim()) return false;
  if (isNonRetryableAgentError(message)) return false;
  if (PROMPT_TOO_LONG_PATTERNS.some((pattern) => normalized.includes(pattern))) return false;
  return [
    "timeout",
    "timed out",
    "aborterror",
    "429",
    "rate limit",
    "rate_limited",
    "too many requests",
    "500",
    "502",
    "503",
    "504",
    "overloaded",
    "service unavailable",
    "provider_error",
    "service_error",
    "network",
    "fetch failed",
    "connection",
    "econnreset",
    "etimedout",
    "socket hang up",
    "terminated",
    "context_management",
    "no conversation found",
  ].some((pattern) => normalized.includes(pattern));
}

function firstBillingError(...messages: Array<string | undefined>): string | undefined {
  return messages.find((message) => message && isAgentBillingError(message));
}

function userSdkMessage(content: string, attachments: AgentAttachment[] = [], uuid = entityId("msg")): SDKMessage {
  return {
    type: "user",
    message: {
      role: "user",
      content,
    },
    ...(attachments.length > 0 ? { _attachments: attachments } : {}),
    parent_tool_use_id: null,
    uuid,
    session_id: "",
    _createdAt: Date.now(),
  } as unknown as SDKMessage;
}

function compactingSdkMessage(): SDKMessage {
  return {
    type: "system",
    subtype: "compacting",
    uuid: entityId("compact"),
    session_id: "",
    _createdAt: Date.now(),
  } as unknown as SDKMessage;
}

function compactBoundarySdkMessage(): SDKMessage {
  return {
    type: "system",
    subtype: "compact_boundary",
    uuid: entityId("compact"),
    session_id: "",
    _createdAt: Date.now(),
  } as unknown as SDKMessage;
}

function compactFailedSdkMessage(message: string): SDKMessage {
  return {
    type: "system",
    subtype: "compact_failed",
    message: formatAgentUserError(message),
    uuid: entityId("compact"),
    session_id: "",
    _createdAt: Date.now(),
  } as unknown as SDKMessage;
}

function promptWithAttachments(prompt: string, attachments: AgentAttachment[]): string {
  if (attachments.length === 0) return prompt;
  const refs = attachments
    .map((attachment) => `- ${attachment.name}: ${attachment.path}${attachmentReadHint(attachment)}`)
    .join("\n");
  return `<attached_files>\n${refs}\n\nReading guidance: for plain text/code files use Read/Grep. For PDF, DOCX, PPTX, spreadsheets, and other binary documents, use the matching native Skill or structured extraction workflow; do not repeatedly retry Read if it returns only metadata or unsupported content.\n</attached_files>\n\n${prompt}`;
}

function attachmentReadHint(attachment: AgentAttachment): string {
  const extension = extname(attachment.name || attachment.path).toLowerCase();
  if (extension === ".pdf") return " (PDF: use pdf Skill, pdftotext, pdfplumber, or pypdf for extraction)";
  if (extension === ".docx" || extension === ".doc") return " (Word document: use docx Skill and Brevyn parsed artifact or semantic units when available; otherwise use mammoth, pandoc, or unzip/XML for extraction)";
  if (extension === ".pptx" || extension === ".ppt") return " (presentation: use pptx Skill or unzip/XML for extraction)";
  if (extension === ".xlsx" || extension === ".xls" || extension === ".csv" || extension === ".tsv") return " (spreadsheet: use spreadsheet/xlsx Skill and Brevyn parsed artifact or semantic units when available)";
  return "";
}

function buildAvailableSkillsPrompt(skills: SkillItem[]): string {
  const enabledSkills = skills
    .filter((skill) => skill.enabled)
    .sort((left, right) => (left.slug || left.name).localeCompare(right.slug || right.name));
  if (enabledSkills.length === 0) {
    return [
      "## Available Native Skills",
      "- No native Skills are currently enabled.",
    ].join("\n");
  }
  return [
    "## Available Native Skills",
    "- Brevyn has these enabled Claude native Skills available through the local plugin `brevyn-global-skills`.",
    "- If the user asks what Skills are available, answer from this exact enabled list and include all of them unless the user asks for a shorter summary.",
    "- When a task matches a Skill, use the native Skill workflow. A Skill can be invoked as `brevyn-global-skills:<slug>`.",
    "- Routing rule: if the user asks to create slides/PPT/deck from a paper, PDF, article, manuscript, literature, reading notes, journal-club material, academic report, or general source material, prefer `brevyn-global-skills:ppt-master`. Use `brevyn-global-skills:pptx` only for lightweight existing PPTX inspection/editing tasks that do not need the full deck-generation workflow.",
    ...enabledSkills.map((skill) => `- ${skill.slug || skill.id.replace(/^file:/, "")}: ${skill.name}${skill.description ? ` — ${truncateSkillDescription(skill.description)}` : ""}`),
  ].join("\n");
}

function truncateSkillDescription(value: string): string {
  const text = value.replace(/\s+/g, " ").trim();
  return text.length <= 140 ? text : `${text.slice(0, 137).trimEnd()}...`;
}

function promptWithMentionedSkills(prompt: string, mentionedSkills: string[] | undefined, skills: Array<{ slug?: string; name: string; enabled: boolean }>): string {
  const slugs = [...new Set((mentionedSkills || []).map((slug) => slug.trim()).filter(Boolean))];
  if (slugs.length === 0) return prompt;
  const enabledBySlug = new Map(skills.filter((skill) => skill.enabled && skill.slug).map((skill) => [skill.slug!, skill]));
  const lines = slugs.flatMap((slug) => {
    const skill = enabledBySlug.get(slug);
    if (!skill) return [];
    return [`- brevyn-global-skills:${slug}: ${skill.name}`];
  });
  if (lines.length === 0) return prompt;
  return [
    "<mentioned_skills>",
    "The user explicitly selected these native Claude Skills for this run. Treat the selection as task context; when the request matches a selected Skill, follow that Skill workflow without announcing skill loading.",
    ...lines,
    "</mentioned_skills>",
    "",
    prompt,
  ].join("\n");
}

function promptWithWorkflow(prompt: string, workflow: Thread["workflow"] | undefined, userPrompt: string): string {
  if (workflow?.type !== "ppt") return prompt;
  if (isPptWorkflowExitPrompt(userPrompt)) {
    return [
      "<active_workflow>",
      "The thread was in PPT workflow mode, but the user is asking to stop or switch away from PPT. Acknowledge briefly and continue as a normal conversation. Do not generate a PPT or force the PPT Skill for this turn.",
      "</active_workflow>",
      "",
      prompt,
    ].join("\n");
  }
  const skillSlug = workflow.skillSlug || "ppt-master";
  return [
    "<active_workflow>",
    `This thread is in Brevyn PPT workflow mode using \`brevyn-global-skills:${skillSlug}\`. Treat this as an active product workflow, not as optional context.`,
    `Current workflow phase: ${workflow.phase}.`,
    "",
    "Hard requirements:",
    `- Continue with the native Skill workflow \`brevyn-global-skills:${skillSlug}\` before planning or generating the deck.`,
    "- Before any PPT planning or generation step, run the selected Skill's runtime preflight command. For `ppt-master`, run `python3 ${SKILL_DIR}/scripts/preflight.py --json`. If preflight fails, stop immediately, explain the missing runtime/dependencies in the user's language, and show the repair command from the preflight output.",
    "- For report, paper, coursework, DOCX, PDF, XLSX, PPTX, image, or chart inputs, first inventory the materials and identify reusable figures, tables, data results, captions, and the presentation storyline.",
    "- Use the Skill's intake flow: `scripts/source_to_md.py` for source conversion, `scripts/project_manager.py` for project setup/import, and `scripts/analyze_images.py` for reusable image facts when images are present.",
    "- In planning/awaiting_confirmation, provide a PPT plan, material checklist, suggested style direction, page count, language choices, and which assets should be reused/redrawn/skipped, then wait for user confirmation.",
    "- Once the user has confirmed style/page count/language/content direction, follow the Skill pipeline: create the project artifacts, write `design_spec.md` and `spec_lock.md`, generate SVG pages under `svg_output/`, run `scripts/svg_quality_checker.py`, then export with `scripts/finalize_svg.py` and `scripts/svg_to_pptx.py`.",
    "- Do not bypass the selected Skill by writing an independent one-off python-pptx script from scratch.",
    "- When generation finishes, report the PPTX path and any preview/export notes. If anything cannot be represented by the Skill pipeline, explain the smallest exception and keep the rest on the Skill workflow.",
    "</active_workflow>",
    "",
    prompt,
  ].join("\n");
}

function isPptWorkflowExitPrompt(prompt: string): boolean {
  const normalized = prompt.trim().toLowerCase();
  if (!normalized) return false;
  return [
    "取消ppt",
    "取消 ppt",
    "先别做ppt",
    "先别做 ppt",
    "不用做ppt",
    "不用做 ppt",
    "不做ppt",
    "不做 ppt",
    "退出ppt",
    "退出 ppt",
    "换个话题",
    "先换个话题",
    "stop ppt",
    "cancel ppt",
    "exit ppt",
  ].some((pattern) => normalized.includes(pattern));
}

function isPptWorkflowGenerationPrompt(prompt: string): boolean {
  const normalized = prompt.trim().toLowerCase();
  if (!normalized) return false;
  if (isPptWorkflowExitPrompt(normalized)) return false;
  if (/[?？]/.test(normalized) || /(怎么|为什么|是否|可不可以|能不能|吗|么)\s*$/.test(normalized)) return false;
  return [
    "确认",
    "可以",
    "开始",
    "生成",
    "就这样",
    "按这个",
    "没问题",
    "中文",
    "英文",
    "学术答辩",
    "学术报告",
    "精简",
    "10页",
    "10 页",
    "ten slides",
    "go ahead",
    "looks good",
    "generate",
    "start",
  ].some((pattern) => normalized.includes(pattern)) || /\b\d+\s*(页|slides?)\b/i.test(normalized);
}

function assistantErrorSdkMessage(message: string, errorCode?: string): SDKMessage {
  return {
    type: "assistant",
    message: {
      content: [{ type: "text", text: message }],
    },
    parent_tool_use_id: null,
    error: { message, errorType: errorCode || "agent_error" },
    ...(errorCode ? { _errorCode: errorCode } : {}),
    uuid: entityId("msg"),
    session_id: "",
    _createdAt: Date.now(),
  } as unknown as SDKMessage;
}

function errorCodeForMessage(message: string): string | undefined {
  const normalized = message.toLowerCase();
  return PROMPT_TOO_LONG_PATTERNS.some((pattern) => normalized.includes(pattern)) ? "prompt_too_long" : undefined;
}

const PROMPT_TOO_LONG_PATTERNS = [
  "prompt is too long",
  "prompt_too_long",
  "input is too long",
  "context_length_exceeded",
  "maximum context length",
  "token limit",
  "exceeds the model",
] as const;

function resultSdkMessage(subtype: string, message?: string): SDKMessage {
  return {
    type: "result",
    subtype,
    is_error: subtype !== "success",
    api_error_status: null,
    duration_ms: 0,
    duration_api_ms: 0,
    num_turns: 0,
    result: message || "",
    stop_reason: subtype === "success" ? "end_turn" : "error",
    session_id: "",
    total_cost_usd: 0,
    usage: {
      input_tokens: 0,
      output_tokens: 0,
      cache_read_input_tokens: 0,
      cache_creation_input_tokens: 0,
    },
    errors: message ? [message] : undefined,
    _createdAt: Date.now(),
  } as unknown as SDKMessage;
}

function sdkResultErrorMessage(message: SDKMessage): string | undefined {
  const result = message as unknown as { errors?: unknown; result?: unknown; is_error?: unknown; subtype?: unknown };
  const subtype = typeof result.subtype === "string" ? result.subtype : "";
  if (subtype === "success" || subtype === "stopped_by_user" || subtype === "interrupted") return undefined;
  if (Array.isArray(result.errors)) {
    const first = result.errors.find((item) => typeof item === "string" && item.trim());
    if (typeof first === "string") return first.trim();
  }
  if (typeof result.result === "string" && result.result.trim()) return result.result.trim();
  return result.is_error === true || subtype ? "Agent provider request failed." : undefined;
}

function compactResultErrorMessage(message: SDKMessage): string | undefined {
  const result = message as unknown as { result?: unknown; errors?: unknown };
  const candidates = [
    typeof result.result === "string" ? result.result : "",
    ...(Array.isArray(result.errors) ? result.errors.filter((item): item is string => typeof item === "string") : []),
  ];
  const match = candidates.find((item) => isCompactErrorText(item));
  return match?.trim();
}

function sdkAssistantErrorMessage(message: SDKMessage): string | undefined {
  const error = (message as unknown as { error?: unknown }).error;
  if (!error || typeof error !== "object" || Array.isArray(error)) return undefined;
  const value = (error as { message?: unknown }).message;
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function isCompactErrorText(value: string): boolean {
  const normalized = value.toLowerCase();
  return normalized.includes("error during compaction")
    || normalized.includes("summarization produced empty response")
    || normalized.includes("compaction failed")
    || normalized.includes("failed to compact");
}

function lifecycleForResult(message: SDKMessage): "completed" | "stopped" | "failed" {
  const subtype = String((message as { subtype?: unknown }).subtype || "");
  if (subtype === "success") return "completed";
  if (subtype === "stopped_by_user") return "stopped";
  return "failed";
}

function isContinuableSdkResult(message: SDKMessage): boolean {
  const reason = String((message as { terminal_reason?: unknown }).terminal_reason || "");
  const subtype = String((message as { subtype?: unknown }).subtype || "");
  return ["interrupt", "interrupted", "aborted"].includes(subtype)
    || ["aborted_streaming", "aborted_tools", "tool_deferred", "hook_stopped", "stop_hook_prevented"].includes(reason);
}

function isInvalidSdkSessionError(message: string): boolean {
  const normalized = message.toLowerCase();
  return normalized.includes("session not found") ||
    normalized.includes("no conversation found") ||
    normalized.includes("conversation not found");
}

function withCreatedAt(message: SDKMessage): SDKMessage {
  const record = message as unknown as Record<string, unknown>;
  if (typeof record._createdAt === "number") return message;
  return { ...record, _createdAt: Date.now() } as unknown as SDKMessage;
}

function positiveInteger(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.round(value) : 0;
}

function shouldPersistSdkMessage(message: SDKMessage): boolean {
  if (message.type === "stream_event") return false;
  if (message.type === "assistant" || message.type === "result") return true;
  if (message.type === "user") return userMessageHasToolResult(message);
  if (message.type !== "system") return false;
  const subtype = String((message as { subtype?: unknown }).subtype || "");
  return subtype === "compact_boundary" || subtype === "compact_failed" || subtype === "permission_denied";
}

function isCompactBoundaryMessage(message: SDKMessage): boolean {
  return message.type === "system" && message.subtype === "compact_boundary";
}

function shouldEmitLiveSdkMessage(message: SDKMessage): boolean {
  if (message.type !== "user") return true;
  return userMessageHasToolResult(message);
}

function shouldGenerateTitleForRun(thread: Thread): boolean {
  if ((thread.messageCount || 0) > 0) return false;
  if (thread.titleSource === "default") return true;
  if (thread.titleSource) return false;
  const normalized = thread.title.trim();
  return normalized === "Home TaskAgent" ||
    normalized === "Home session" ||
    normalized === "学期总览" ||
    normalized === "学期会话" ||
    normalized === "新的学期会话" ||
    normalized === "Task session" ||
    normalized.endsWith(" session") ||
    normalized.endsWith(" thread");
}

function userMessageHasToolResult(message: SDKMessage): boolean {
  const rawMessage = (message as unknown as { message?: { content?: unknown } }).message;
  const content = rawMessage?.content;
  return Array.isArray(content) && content.some((block) =>
    Boolean(block && typeof block === "object" && (block as { type?: unknown }).type === "tool_result"),
  );
}
