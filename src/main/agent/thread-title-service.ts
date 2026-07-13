import type { ModelProviderConfig, Thread } from "../../types/domain";
import { getAgentProviderAdapter } from "../providers";
import { ProviderService, envApiKeyForProvider } from "../services/provider-service";
import { SQLiteBusinessStore } from "../storage";
import { AgentEventBus } from "./agent-event-bus";

const TITLE_PROMPT_PREFIX = [
  "根据用户的第一条消息，生成一个简短的会话标题（10字以内）。",
  "只输出标题，不要解释，不要标点，不要引号。",
  "",
  "用户消息：",
].join("\n");
const MAX_TITLE_LENGTH = 20;
const SHORT_MESSAGE_THRESHOLD = 4;
const TITLE_FETCH_TIMEOUT_MS = 30_000;

interface ThreadTitleServiceOptions {
  businessStore: SQLiteBusinessStore;
  providers: ProviderService;
  eventBus: AgentEventBus;
}

export interface GenerateThreadTitleInput {
  threadId: string;
  userMessage: string;
  providerId?: string;
  modelId?: string;
  allowAfterFirstMessage?: boolean;
}

export class ThreadTitleService {
  private readonly pendingThreadIds = new Set<string>();

  constructor(private readonly options: ThreadTitleServiceOptions) {}

  async maybeGenerate(input: GenerateThreadTitleInput): Promise<Thread | null> {
    if (this.pendingThreadIds.has(input.threadId)) return null;
    const thread = this.options.businessStore.getThread(input.threadId);
    if (!thread || !canAutoGenerateTitle(thread, input.allowAfterFirstMessage)) return null;

    const userMessage = input.userMessage.trim();
    if (!userMessage) return null;

    this.pendingThreadIds.add(input.threadId);
    try {
      const title = userMessage.length <= SHORT_MESSAGE_THRESHOLD
        ? cleanGeneratedTitle(userMessage)
        : await this.generateWithProvider(input);
      if (!title) return null;
      const updated = this.options.businessStore.renameThreadAutomatically(input.threadId, title, undefined, {
        allowAfterFirstMessage: input.allowAfterFirstMessage,
      });
      if (!updated) return null;
      this.options.eventBus.emit({ kind: "thread_updated", thread: updated });
      return updated;
    } catch (error) {
      console.warn("[thread-title] Automatic title generation failed", error);
      return null;
    } finally {
      this.pendingThreadIds.delete(input.threadId);
    }
  }

  private async generateWithProvider(input: GenerateThreadTitleInput): Promise<string | null> {
    const provider = this.options.providers.agentProviderFor(input.providerId, input.modelId);
    if (!provider) return null;
    const apiKey = this.options.providers.apiKey(provider.id) || envApiKeyForProvider(provider);
    if (!apiKey) return null;

    const adapter = getAgentProviderAdapter(provider);
    const effectiveProvider = providerWithSelectedModel(provider, input.modelId);
    const request = adapter.buildTitleRequest(effectiveProvider, apiKey, `${TITLE_PROMPT_PREFIX}\n${input.userMessage}`);
    const payload = await fetchTitlePayload(request.url, request.init);
    const rawTitle = adapter.parseTitleResponse(payload) || "";
    return cleanGeneratedTitle(rawTitle);
  }
}

export function cleanGeneratedTitle(value: string): string | null {
  const cleaned = value
    .replace(/\s+/g, " ")
    .trim()
    .replace(/^["'“”‘’「」《》【】]+|["'“”‘’「」《》【】。！？、,.!?;；:：]+$/g, "")
    .trim();
  return cleaned.slice(0, MAX_TITLE_LENGTH) || null;
}

async function fetchTitlePayload(url: string, init: RequestInit): Promise<unknown> {
  const controller = new AbortController();
  let timedOut = false;
  const timeout = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, TITLE_FETCH_TIMEOUT_MS);
  try {
    const response = await fetch(url, { ...init, signal: controller.signal });
    if (!response.ok) {
      console.warn("[thread-title] Title request failed", { status: response.status, statusText: response.statusText });
      return null;
    }
    return await response.json();
  } catch (error) {
    if (timedOut && isAbortError(error)) {
      console.info("[thread-title] Title request timed out", { timeoutMs: TITLE_FETCH_TIMEOUT_MS });
      return null;
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

function isAbortError(error: unknown): boolean {
  return error instanceof DOMException && error.name === "AbortError";
}

function providerWithSelectedModel(provider: ModelProviderConfig, modelId?: string): ModelProviderConfig {
  return modelId && provider.models.some((model) => model.id === modelId)
    ? { ...provider, selectedModel: modelId }
    : provider;
}

function canAutoGenerateTitle(thread: Thread, allowAfterFirstMessage = false): boolean {
  if (!allowAfterFirstMessage && (thread.messageCount || 0) > 1) return false;
  if (thread.titleSource === "default") return true;
  if (thread.titleSource) return false;
  return isDefaultThreadTitle(thread.title);
}

function isDefaultThreadTitle(title: string): boolean {
  const normalized = title.trim();
  return normalized === "Home TaskAgent" ||
    normalized === "Home session" ||
    normalized === "学期总览" ||
    normalized === "学期会话" ||
    normalized === "新的学期会话" ||
    normalized === "Task session" ||
    normalized.endsWith(" session") ||
    normalized.endsWith(" thread");
}
