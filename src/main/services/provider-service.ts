import {
  AGENT_PROVIDER_PRESETS,
  DEFAULT_AUTO_COMPACT_THRESHOLD_PERCENT,
  EMBEDDING_PROVIDER_PRESETS,
  MAX_AUTO_COMPACT_THRESHOLD_PERCENT,
  MIN_AUTO_COMPACT_THRESHOLD_PERCENT,
  OCR_PROVIDER_PRESETS,
  PROVIDER_PRESETS,
  VISION_PROVIDER_PRESETS,
  type AgentProviderKind,
  type EmbeddingProviderKind,
  type ModelProviderConfig,
  type OcrProviderKind,
  type ProviderAdapterKind,
  type ProviderAuthMode,
  type ProviderDraftInput,
  type ProviderKind,
  type ProviderModel,
  type ProviderPurpose,
  type ProviderPreset,
  type ProviderSaveResult,
  type ProviderTestResult,
  type VisionProviderKind,
} from "../../types/domain";
import { withInferredContextWindow } from "../../shared/model-context-window";
import { embeddingProviderFingerprint } from "../../shared/embedding-provider-fingerprint";
import { getAgentProviderAdapter, getEmbeddingProviderAdapter, normalizeBaseUrl } from "../providers";
import { ProviderConfigStore } from "./provider-config-store";
import { ProviderSecretStore } from "./provider-secret-store";
import { ProviderTransactionStore } from "./provider-transaction-store";

const PROVIDER_FETCH_TIMEOUT_MS = 8_000;

type LegacyProviderConfig = Partial<ModelProviderConfig> & {
  purpose?: string;
  providerKind?: string;
  adapterKind?: string;
  protocol?: string;
  authMode?: string;
};

export class ProviderService {
  constructor(
    private readonly configs: ProviderConfigStore,
    private readonly secrets?: ProviderSecretStore,
    private readonly transactions?: ProviderTransactionStore,
  ) {
    this.transactions?.reconcile(this.configs, this.secrets);
    this.reconcileSecretRecords();
  }

  list(): ModelProviderConfig[] {
    return normalizeProviders(this.configs.listProviders()).map(cloneProvider);
  }

  save(input: ProviderDraftInput): ProviderSaveResult {
    const draft = normalizeProviderDraftInput(input);
    const providers = normalizeProviders(this.configs.listProviders());
    const embeddingFingerprintBefore = activeEmbeddingProviderFingerprint(providers);
    const timestamp = new Date().toISOString();
    const existing = draft.id ? providers.find((provider) => provider.id === draft.id) : undefined;
    const providerId = draft.id || `provider-${Date.now().toString(36)}`;
    const purpose = normalizeProviderPurpose(draft);
    const providerKind = normalizeProviderKind(draft.providerKind, purpose, draft.protocol, draft.baseUrl);
    const preset = providerPreset(providerKind);
    const protocol = preset.protocol;
    const draftModels = draft.models || [];
    const modelSeed = draftModels.length > 0 ? draftModels : [];
    const selectedModel = selectedEnabledModelId(draft.selectedModel, modelSeed);
    const apiKey = draft.apiKey;
    let apiKeySecretRef = existing?.apiKeySecretRef;
    let apiKeyMasked = existing?.apiKeyMasked || "";
    const secretSnapshot = this.secrets?.snapshot();
    let nextSecretSnapshot = secretSnapshot;
    let secretChanged = false;
    try {
      if (draft.clearApiKey) {
        nextSecretSnapshot = this.secrets?.snapshotWithoutApiKey(providerId);
        secretChanged = Boolean(this.secrets);
        apiKeySecretRef = undefined;
        apiKeyMasked = "";
      } else if (apiKey) {
        const nextSecret = this.secrets?.snapshotWithApiKey(providerId, apiKey);
        nextSecretSnapshot = nextSecret?.snapshot;
        apiKeySecretRef = nextSecret?.secretRef;
        secretChanged = Boolean(this.secrets);
        apiKeyMasked = maskApiKey(apiKey);
      }
      const next: ModelProviderConfig = {
        id: providerId,
        purpose,
        providerKind,
        adapterKind: preset.adapterKind,
        name: uniqueProviderName(draft.name || nextProviderName(providers, purpose, providerId), providers, purpose, providerId),
        protocol,
        baseUrl: normalizeBaseUrl(draft.baseUrl || preset.baseUrl),
        apiKeyMasked,
        apiKeySecretRef,
        authMode: normalizeProviderAuthMode(draft.authMode, purpose, providerKind),
        models: normalizeProviderModels(modelSeed, selectedModel),
        selectedModel,
        enabled: draft.enabled ?? existing?.enabled ?? false,
        autoCompactThresholdPercent: normalizeAutoCompactThresholdPercent(draft.autoCompactThresholdPercent, purpose),
        createdAt: existing?.createdAt || timestamp,
        updatedAt: timestamp,
      };
      const nextProviders = upsertProvider(providers, next).map((provider) =>
        next.enabled && next.purpose === "embedding" && provider.purpose === "embedding" && provider.id !== next.id
          ? { ...provider, enabled: false, updatedAt: timestamp }
          : provider,
      );
      this.commitProviderMutation({
        type: "save",
        providerId,
        beforeProfiles: providers,
        afterProfiles: nextProviders,
        beforeSecrets: secretSnapshot,
        afterSecrets: nextSecretSnapshot,
        secretChanged,
      });
      const embeddingFingerprintAfter = activeEmbeddingProviderFingerprint(nextProviders);
      return {
        provider: cloneProvider(next),
        embeddingIndexMayBeStale: Boolean(
          embeddingFingerprintBefore &&
          embeddingFingerprintAfter &&
          embeddingFingerprintBefore !== embeddingFingerprintAfter,
        ),
      };
    } catch (error) {
      if (secretChanged && secretSnapshot && this.secrets) {
        try {
          this.secrets.restore(secretSnapshot);
        } catch (rollbackError) {
          console.warn("[providers] Failed to roll back provider secret mutation", rollbackError);
        }
      }
      throw error;
    }
  }

  delete(providerId: string): boolean {
    const id = stringValue(providerId).trim();
    if (!id) return false;
    const providers = normalizeProviders(this.configs.listProviders());
    const existedInMemory = providers.some((provider) => provider.id === id);
    if (!existedInMemory) return false;
    const secretSnapshot = this.secrets?.snapshot();
    const nextSecretSnapshot = this.secrets?.snapshotWithoutApiKey(id);
    try {
      this.commitProviderMutation({
        type: "delete",
        providerId: id,
        beforeProfiles: providers,
        afterProfiles: providers.filter((provider) => provider.id !== id),
        beforeSecrets: secretSnapshot,
        afterSecrets: nextSecretSnapshot,
        secretChanged: Boolean(this.secrets),
      });
      return true;
    } catch (error) {
      if (secretSnapshot && this.secrets) {
        try {
          this.secrets.restore(secretSnapshot);
        } catch (rollbackError) {
          console.warn("[providers] Failed to roll back provider secret deletion", rollbackError);
        }
      }
      throw error;
    }
  }

  async models(providerId: string): Promise<ProviderModel[]> {
    const id = stringValue(providerId).trim();
    if (!id) return [];
    const provider = this.list().find((item) => item.id === id);
    if (!provider) return [];
    const apiKey = this.apiKey(provider.id) || envApiKeyForProvider(provider);
    if (!provider.baseUrl) throw new Error("Base URL is required before fetching models.");
    if (!apiKey) throw new Error("API key is required before fetching models.");
    try {
      const fetched = await fetchProviderModels(provider, apiKey);
      const compatibleModels = filterModelsForPurpose(provider.purpose, fetched);
      const models = provider.purpose === "agent" || provider.purpose === "vision" || provider.purpose === "ocr"
        ? fetchedAgentModelsAsAvailable(compatibleModels)
        : normalizeProviderModels(compatibleModels, provider.selectedModel);
      this.configs.saveProvider({ ...provider, models, updatedAt: new Date().toISOString() });
      return models;
    } catch (error) {
      console.warn(`[providers] Failed to fetch models for ${provider.id}`, error);
      throw new Error(error instanceof Error ? error.message : String(error || `Failed to fetch ${provider.purpose} models.`));
    }
  }

  async modelsFromDraft(input: ProviderDraftInput): Promise<ProviderModel[]> {
    const provider = this.providerFromDraft(input);
    const apiKey = input.apiKey?.trim() || (provider.id ? this.apiKey(provider.id) : undefined) || envApiKeyForProvider(provider);
    if (!provider.baseUrl) throw new Error("Base URL is required before fetching models.");
    if (!apiKey) throw new Error("API key is required before fetching models.");
    try {
      const fetched = await fetchProviderModels(provider, apiKey);
      const compatibleModels = filterModelsForPurpose(provider.purpose, fetched);
      return provider.purpose === "agent" || provider.purpose === "vision" || provider.purpose === "ocr"
        ? mergeFetchedModelsAsAvailable(input.models || [], compatibleModels, input.selectedModel)
        : normalizeProviderModels(compatibleModels, input.selectedModel);
    } catch (error) {
      console.warn(`[providers] Failed to fetch models for draft ${provider.providerKind}`, error);
      throw new Error(error instanceof Error ? error.message : String(error || `Failed to fetch ${provider.purpose} models.`));
    }
  }

  async test(providerId: string): Promise<ProviderTestResult> {
    const startedAt = Date.now();
    const id = stringValue(providerId).trim();
    if (!id) {
      return { ok: false, latencyMs: Date.now() - startedAt, message: "Provider id is required." };
    }
    const provider = this.list().find((item) => item.id === id);
    if (!provider) {
      return { ok: false, latencyMs: 0, message: "Provider not found." };
    }
    if (!provider.baseUrl) {
      return { ok: false, latencyMs: Date.now() - startedAt, message: "Base URL is required." };
    }
    const apiKey = this.apiKey(provider.id) || envApiKeyForProvider(provider);
    if (!apiKey) {
      return {
        ok: false,
        latencyMs: Date.now() - startedAt,
        message: "No API key is stored for this provider. Paste a key and save, or set the matching environment variable.",
      };
    }
    try {
      const embeddingDimension = provider.purpose === "embedding"
        ? await testEmbeddingProvider(provider, apiKey)
        : undefined;
      if (provider.purpose === "agent") await testAgentProvider(provider, apiKey);
      if (provider.purpose === "vision") await testVisionProvider(provider, apiKey);
      if (provider.purpose === "ocr") await testVisionProvider(provider, apiKey);
      return {
        ok: true,
        latencyMs: Date.now() - startedAt,
        message: embeddingDimension
          ? `${provider.name} embedding endpoint connected via ${provider.baseUrl} (dim=${embeddingDimension}).`
          : `${provider.name} connected via ${provider.baseUrl}.`,
      };
    } catch (error) {
      return {
        ok: false,
        latencyMs: Date.now() - startedAt,
        message: error instanceof Error ? error.message : "Connection test failed.",
      };
    }
  }

  async testDraft(input: ProviderDraftInput): Promise<ProviderTestResult> {
    const startedAt = Date.now();
    const provider = this.providerFromDraft(input);
    if (!provider.baseUrl) {
      return { ok: false, latencyMs: Date.now() - startedAt, message: "Base URL is required." };
    }
    const apiKey = input.apiKey?.trim() || (provider.id ? this.apiKey(provider.id) : undefined) || envApiKeyForProvider(provider);
    if (!apiKey) {
      return {
        ok: false,
        latencyMs: Date.now() - startedAt,
        message: "API key is required before testing this provider.",
      };
    }
    try {
      const embeddingDimension = provider.purpose === "embedding"
        ? await testEmbeddingProvider(provider, apiKey)
        : undefined;
      if (provider.purpose === "agent") await testAgentProvider(provider, apiKey);
      if (provider.purpose === "vision") await testVisionProvider(provider, apiKey);
      if (provider.purpose === "ocr") await testVisionProvider(provider, apiKey);
      return {
        ok: true,
        latencyMs: Date.now() - startedAt,
        message: embeddingDimension
          ? `${provider.name} embedding endpoint connected via ${provider.baseUrl} (dim=${embeddingDimension}).`
          : `${provider.name} connected via ${provider.baseUrl}.`,
      };
    } catch (error) {
      return {
        ok: false,
        latencyMs: Date.now() - startedAt,
        message: error instanceof Error ? error.message : "Connection test failed.",
      };
    }
  }

  private providerFromDraft(input: ProviderDraftInput): ModelProviderConfig {
    const draft = normalizeProviderDraftInput(input);
    const existing = draft.id ? this.list().find((provider) => provider.id === draft.id) : undefined;
    const providerKind = normalizeProviderKind(draft.providerKind, draft.purpose, draft.protocol, draft.baseUrl);
    const preset = providerPreset(providerKind);
    const models = normalizeProviderModels(draft.models || [], draft.selectedModel);
    return {
      id: draft.id || "",
      purpose: draft.purpose,
      providerKind,
      adapterKind: preset.adapterKind,
      name: draft.name || existing?.name || nextProviderName(this.list(), draft.purpose, draft.id),
      protocol: preset.protocol,
      baseUrl: normalizeBaseUrl(draft.baseUrl || preset.baseUrl),
      apiKeyMasked: existing?.apiKeyMasked || "",
      apiKeySecretRef: existing?.apiKeySecretRef,
      authMode: normalizeProviderAuthMode(draft.authMode, draft.purpose, providerKind),
      models,
      selectedModel: selectedEnabledModelId(draft.selectedModel, models),
      enabled: draft.enabled ?? existing?.enabled ?? false,
      createdAt: existing?.createdAt || new Date().toISOString(),
      updatedAt: existing?.updatedAt || new Date().toISOString(),
    };
  }

  apiKey(providerId: string): string | undefined {
    const id = stringValue(providerId).trim();
    return id ? this.secrets?.readApiKey(id) : undefined;
  }

  hasApiKey(providerId: string): boolean {
    const id = stringValue(providerId).trim();
    return Boolean(id && this.secrets?.hasApiKey(id));
  }

  secretStorageAvailable(): boolean {
    return Boolean(this.secrets?.isEncryptionAvailable());
  }

  /** Unique enabled provider that is allowed to serve agent requests. */
  agentProvider(): ModelProviderConfig | undefined {
    return this.agentProviderFor();
  }

  agentProviderFor(providerId?: string, modelId?: string): ModelProviderConfig | undefined {
    const providers = this.list().filter((provider) =>
      provider.purpose === "agent" &&
      (
        (provider.protocol === "anthropic_messages" && provider.adapterKind === "anthropic") ||
        (provider.protocol === "openai_responses" && provider.adapterKind === "openai_responses")
      ) &&
      provider.enabled &&
      provider.models.some((model) => model.enabled !== false) &&
      Boolean(provider.baseUrl) &&
      Boolean(this.apiKey(provider.id) || envApiKeyForProvider(provider)),
    );
    const provider = providerId
      ? providers.find((item) => item.id === providerId)
      : providers[0];
    if (!provider) return undefined;
    const enabledModels = provider.models.filter((model) => model.enabled !== false);
    const selectedModel = modelId && enabledModels.some((model) => model.id === modelId)
      ? modelId
      : selectedEnabledModelId(provider.selectedModel, enabledModels);
    if (!selectedModel) return undefined;
    return { ...provider, selectedModel };
  }

  /** Unique enabled provider that is allowed to serve embedding requests. */
  embeddingProvider(): ModelProviderConfig | undefined {
    return singleActiveProvider(this.list().filter((provider) =>
      provider.purpose === "embedding" &&
      provider.protocol === "openai_compatible" &&
      provider.adapterKind === "openai_embedding" &&
      provider.enabled &&
      Boolean(provider.selectedModel) &&
      Boolean(provider.baseUrl),
    ));
  }

  /** Enabled provider used for OCR-like recognition tasks. */
  visionProvider(): ModelProviderConfig | undefined {
    return this.visionProviderFor();
  }

  /** Provider/model pair for OCR-like recognition tasks. */
  visionProviderFor(providerId?: string, modelId?: string): ModelProviderConfig | undefined {
    const providers = this.list().filter((item) =>
      item.purpose === "vision" &&
      item.enabled &&
      item.models.some((model) => model.enabled !== false) &&
      Boolean(item.baseUrl) &&
      Boolean(this.apiKey(item.id) || envApiKeyForProvider(item)),
    );
    const provider = providerId ? providers.find((item) => item.id === providerId) : singleActiveProvider(providers);
    if (!provider) return undefined;
    const enabledModels = provider.models.filter((model) => model.enabled !== false);
    const selectedModel = modelId && enabledModels.some((model) => model.id === modelId)
      ? modelId
      : selectedEnabledModelId(provider.selectedModel, enabledModels);
    if (!selectedModel) return undefined;
    return { ...provider, selectedModel };
  }

  /** Enabled provider used for document OCR during RAG indexing. */
  ocrProvider(): ModelProviderConfig | undefined {
    return this.ocrProviderFor();
  }

  /** Provider/model pair for document OCR during RAG indexing. */
  ocrProviderFor(providerId?: string, modelId?: string): ModelProviderConfig | undefined {
    const providers = this.list().filter((item) =>
      item.purpose === "ocr" &&
      item.enabled &&
      item.models.some((model) => model.enabled !== false) &&
      Boolean(item.baseUrl) &&
      Boolean(this.apiKey(item.id) || envApiKeyForProvider(item)),
    );
    const provider = providerId ? providers.find((item) => item.id === providerId) : singleActiveProvider(providers);
    if (!provider) return undefined;
    const enabledModels = provider.models.filter((model) => model.enabled !== false);
    const selectedModel = modelId && enabledModels.some((model) => model.id === modelId)
      ? modelId
      : selectedEnabledModelId(provider.selectedModel, enabledModels);
    if (!selectedModel) return undefined;
    return { ...provider, selectedModel };
  }

  envApiKeyFor(provider: ModelProviderConfig): string | undefined {
    return envApiKeyForProvider(provider);
  }

  private commitProviderMutation({
    type,
    providerId,
    beforeProfiles,
    afterProfiles,
    beforeSecrets,
    afterSecrets,
    secretChanged,
  }: {
    type: "save" | "delete";
    providerId: string;
    beforeProfiles: ModelProviderConfig[];
    afterProfiles: ModelProviderConfig[];
    beforeSecrets?: ReturnType<ProviderSecretStore["snapshot"]>;
    afterSecrets?: ReturnType<ProviderSecretStore["snapshot"]>;
    secretChanged: boolean;
  }): void {
    const transaction = secretChanged && this.transactions
      ? this.transactions.begin({
          type,
          providerId,
          beforeProfiles,
          afterProfiles,
          beforeSecrets,
          afterSecrets,
        })
      : undefined;
    try {
      this.configs.replaceProviders(afterProfiles);
      if (secretChanged && afterSecrets && this.secrets) this.secrets.restore(afterSecrets);
      this.transactions?.clear(transaction?.id);
    } catch (error) {
      try {
        this.configs.replaceProviders(beforeProfiles);
        if (secretChanged && beforeSecrets && this.secrets) this.secrets.restore(beforeSecrets);
        this.transactions?.clear(transaction?.id);
      } catch (rollbackError) {
        console.warn("[providers] Failed to roll back provider mutation", rollbackError);
      }
      throw error;
    }
  }

  private reconcileSecretRecords(): void {
    if (!this.secrets) return;
    const providers = normalizeProviders(this.configs.listProviders());
    const providerIds = new Set(providers.map((provider) => provider.id));
    const nextProviders = providers.map((provider) => {
      if (!provider.apiKeySecretRef || this.secrets?.hasStoredApiKeyRecord(provider.id)) return provider;
      return {
        ...provider,
        apiKeySecretRef: undefined,
        apiKeyMasked: "",
      };
    });
    let nextSecrets = this.secrets.snapshot();
    for (const providerId of this.secrets.storedProviderIds()) {
      if (!providerIds.has(providerId)) {
        nextSecrets = {
          ...nextSecrets,
          providers: Object.fromEntries(Object.entries(nextSecrets.providers).filter(([id]) => id !== providerId)),
        };
      }
    }
    const profilesChanged = JSON.stringify(nextProviders) !== JSON.stringify(providers);
    const secretsChanged = this.secrets.storedProviderIds().some((providerId) => !providerIds.has(providerId));
    if (secretsChanged) this.secrets.restore(nextSecrets);
    if (profilesChanged) this.configs.replaceProviders(nextProviders);
  }

}

export function normalizeProviders(providers: LegacyProviderConfig[]): ModelProviderConfig[] {
  return providers.map((provider) => {
    const purpose = normalizeProviderPurpose(provider);
    const providerKind = normalizeProviderKind(provider.providerKind, purpose, provider.protocol, provider.baseUrl);
    const preset = providerPreset(providerKind);
    const protocol = preset.protocol;
    const modelSeed = Array.isArray(provider.models) && provider.models.length > 0
      ? provider.models
      : purpose === "agent" || purpose === "vision" || purpose === "ocr" ? [] : presetModels(preset);
    const selectedModel = selectedEnabledModelId(normalizeSelectedModel(provider), modelSeed);
    return {
      id: stringValue(provider.id) || `provider-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`,
      purpose,
      providerKind,
      adapterKind: normalizeProviderAdapterKind(provider.adapterKind, providerKind),
      name: stringValue(provider.name) || (purpose === "agent" ? "Agent Provider" : purpose === "vision" ? "Vision Provider" : purpose === "ocr" ? "OCR Provider" : "Embedding Provider"),
      protocol,
      baseUrl: normalizeBaseUrl(provider.baseUrl || preset.baseUrl),
      apiKeyMasked: stringValue(provider.apiKeyMasked) === "sk-...local" ? "" : stringValue(provider.apiKeyMasked),
      apiKeySecretRef: stringValue(provider.apiKeySecretRef) || (provider.id ? `provider-secret:${provider.id}` : undefined),
      authMode: normalizeProviderAuthMode(provider.authMode, purpose, providerKind),
      models: normalizeProviderModels(modelSeed, selectedModel),
      selectedModel,
      enabled: normalizeProviderEnabled(provider),
      autoCompactThresholdPercent: normalizeAutoCompactThresholdPercent(provider.autoCompactThresholdPercent, purpose),
      createdAt: stringValue(provider.createdAt) || new Date().toISOString(),
      updatedAt: stringValue(provider.updatedAt) || new Date().toISOString(),
    };
  });
}

export function envApiKeyForProvider(provider: ModelProviderConfig): string | undefined {
  if (provider.purpose === "agent") {
    return envAgentApiKey(provider);
  }
  if (provider.purpose === "vision" || provider.purpose === "ocr") {
    return envVisionApiKey(provider);
  }
  return envEmbeddingApiKey(provider);
}

function envAgentApiKey(provider: ModelProviderConfig): string | undefined {
  if (provider.protocol === "openai_responses") {
    return process.env.BREVYN_OPENAI_API_KEY || process.env.OPENAI_API_KEY;
  }
  if (provider.providerKind === "deepseek") {
    return process.env.BREVYN_DEEPSEEK_API_KEY || process.env.DEEPSEEK_API_KEY;
  }
  if (provider.providerKind === "bailian-anthropic") {
    return process.env.BREVYN_BAILIAN_API_KEY || process.env.BAILIAN_API_KEY || process.env.DASHSCOPE_API_KEY;
  }
  if (provider.providerKind === "kimi-api") {
    return process.env.BREVYN_KIMI_API_KEY || process.env.KIMI_API_KEY || process.env.MOONSHOT_API_KEY;
  }
  if (provider.providerKind === "kimi-coding") {
    return process.env.BREVYN_KIMI_CODING_API_KEY || process.env.KIMI_CODING_API_KEY || process.env.KIMI_API_KEY;
  }
  if (provider.authMode === "auth_token" || provider.authMode === "bearer") {
    return process.env.BREVYN_ANTHROPIC_AUTH_TOKEN || process.env.ANTHROPIC_AUTH_TOKEN;
  }
  return process.env.BREVYN_ANTHROPIC_API_KEY || process.env.ANTHROPIC_API_KEY;
}

function envEmbeddingApiKey(provider: ModelProviderConfig): string | undefined {
  if (provider.providerKind === "qwen") {
    return process.env.BREVYN_QWEN_API_KEY || process.env.QWEN_API_KEY || process.env.DASHSCOPE_API_KEY;
  }
  if (provider.providerKind === "doubao") {
    return process.env.BREVYN_DOUBAO_API_KEY || process.env.DOUBAO_API_KEY || process.env.ARK_API_KEY;
  }
  if (provider.providerKind === "zhipu") {
    return process.env.BREVYN_ZHIPU_API_KEY || process.env.ZHIPU_API_KEY;
  }
  if (provider.providerKind === "minimax") {
    return process.env.BREVYN_MINIMAX_API_KEY || process.env.MINIMAX_API_KEY;
  }
  return process.env.BREVYN_OPENAI_COMPATIBLE_API_KEY || process.env.BREVYN_OPENAI_API_KEY || process.env.OPENAI_API_KEY;
}

function envVisionApiKey(provider: ModelProviderConfig): string | undefined {
  if (provider.providerKind === "vision-bailian-openai") {
    return process.env.BREVYN_BAILIAN_API_KEY || process.env.BAILIAN_API_KEY || process.env.DASHSCOPE_API_KEY;
  }
  if (provider.protocol === "openai_responses" || provider.protocol === "openai_compatible") {
    return process.env.BREVYN_OPENAI_API_KEY || process.env.OPENAI_API_KEY || process.env.BREVYN_OPENAI_COMPATIBLE_API_KEY;
  }
  if (provider.authMode === "bearer") {
    return process.env.BREVYN_ANTHROPIC_AUTH_TOKEN || process.env.ANTHROPIC_AUTH_TOKEN;
  }
  return process.env.BREVYN_ANTHROPIC_API_KEY || process.env.ANTHROPIC_API_KEY;
}

function maskApiKey(apiKey: string): string {
  const trimmed = apiKey.trim();
  if (!trimmed) return "";
  if (trimmed.length <= 8) return "....";
  return `${trimmed.slice(0, 3)}...${trimmed.slice(-4)}`;
}

function nextProviderName(providers: ModelProviderConfig[], purpose: ProviderPurpose, excludeId?: string): string {
  const prefix = purpose === "agent" ? "Agent" : purpose === "vision" ? "Vision" : purpose === "ocr" ? "OCR" : "Embedding";
  const used = new Set(
    providers
      .filter((provider) => provider.purpose === purpose && provider.id !== excludeId)
      .map((provider) => normalizeNameKey(provider.name)),
  );
  let index = 1;
  while (used.has(normalizeNameKey(`${prefix} ${index}`))) index += 1;
  return `${prefix} ${index}`;
}

function uniqueProviderName(name: string, providers: ModelProviderConfig[], purpose: ProviderPurpose, excludeId?: string): string {
  const baseName = name.trim() || nextProviderName(providers, purpose, excludeId);
  const used = new Set(
    providers
      .filter((provider) => provider.purpose === purpose && provider.id !== excludeId)
      .map((provider) => normalizeNameKey(provider.name)),
  );
  if (!used.has(normalizeNameKey(baseName))) return baseName;
  let index = 2;
  while (used.has(normalizeNameKey(`${baseName} ${index}`))) index += 1;
  return `${baseName} ${index}`;
}

function normalizeNameKey(name: string): string {
  return name.trim().replace(/\s+/g, " ").toLowerCase();
}

function normalizeProviderPurpose(provider: Pick<LegacyProviderConfig, "purpose" | "protocol" | "providerKind">): ProviderPurpose {
  if (provider.purpose === "agent" || provider.purpose === "embedding" || provider.purpose === "vision" || provider.purpose === "ocr") return provider.purpose;
  const kindPurpose = providerPurposeForKind(provider.providerKind);
  if (kindPurpose) return kindPurpose;
  if (provider.protocol === "openai_responses") return "vision";
  if (provider.protocol === "openai_compatible") return "embedding";
  if (provider.protocol === "anthropic_messages") return "agent";
  return "embedding";
}

function normalizeProviderAuthMode(authMode: string | undefined, purpose: ProviderPurpose, providerKind?: ProviderKind): ProviderAuthMode {
  if (authMode === "api_key" || authMode === "auth_token" || authMode === "bearer") return authMode;
  if (providerKind) return providerPreset(providerKind).authMode;
  return purpose === "agent" ? "api_key" : "bearer";
}

function normalizeProviderAdapterKind(adapterKind: string | undefined, providerKind: ProviderKind): ProviderAdapterKind {
  const expected = providerPreset(providerKind).adapterKind;
  if (adapterKind === expected) return adapterKind;
  return expected;
}

function normalizeProviderKind(kind: string | undefined, purpose: ProviderPurpose, protocol?: string, baseUrl?: string): ProviderKind {
  const normalized = normalizeKindAlias(kind);
  if (purpose === "agent") {
    if (isAgentProviderKind(normalized)) return normalized;
    return inferAgentProviderKind(protocol, baseUrl);
  }
  if (purpose === "vision") {
    if (isVisionProviderKind(normalized)) return normalized;
    return inferVisionProviderKind(protocol, baseUrl);
  }
  if (purpose === "ocr") {
    if (isOcrProviderKind(normalized)) return normalized;
    return inferOcrProviderKind(protocol, baseUrl);
  }
  if (isEmbeddingProviderKind(normalized)) return normalized;
  return inferEmbeddingProviderKind(baseUrl);
}

function normalizeKindAlias(kind: string | undefined): string {
  const value = stringValue(kind).trim().toLowerCase();
  if (value === "kimi_api") return "kimi-api";
  if (value === "kimi_coding") return "kimi-coding";
  if (value === "bailian" || value === "bailian_anthropic" || value === "dashscope-anthropic" || value === "dashscope_anthropic") return "bailian-anthropic";
  if (value === "vision_bailian_anthropic" || value === "vision-bailian-anthropic" || value === "vision_bailian_openai" || value === "bailian_vision" || value === "dashscope_vision") return "vision-bailian-openai";
  if (value === "vision_custom_openai") return "vision-custom-openai";
  if (value === "vision_custom_anthropic") return "vision-custom-anthropic";
  if (value === "vision_openai_responses") return "vision-openai-responses";
  if (value === "vision_custom_openai_responses") return "vision-custom-openai-responses";
  if (value === "ocr_custom_openai" || value === "document_ocr" || value === "vision_ocr") return "ocr-custom-openai";
  if (value === "ocr_custom_anthropic") return "ocr-custom-anthropic";
  if (value === "ocr_openai_responses") return "ocr-openai-responses";
  if (value === "custom_anthropic") return "custom-anthropic";
  if (value === "openai_responses_agent" || value === "openai-responses" || value === "custom_openai_responses_agent") return "openai-responses-agent";
  if (value === "custom_openai" || value === "custom") return "custom-openai";
  return value;
}

function providerPurposeForKind(kind: string | undefined): ProviderPurpose | undefined {
  const normalized = normalizeKindAlias(kind);
  if (isAgentProviderKind(normalized)) return "agent";
  if (isEmbeddingProviderKind(normalized)) return "embedding";
  if (isVisionProviderKind(normalized)) return "vision";
  if (isOcrProviderKind(normalized)) return "ocr";
  return undefined;
}

function isAgentProviderKind(kind: string): kind is AgentProviderKind {
  return Object.prototype.hasOwnProperty.call(AGENT_PROVIDER_PRESETS, kind);
}

function isEmbeddingProviderKind(kind: string): kind is EmbeddingProviderKind {
  return Object.prototype.hasOwnProperty.call(EMBEDDING_PROVIDER_PRESETS, kind);
}

function isVisionProviderKind(kind: string): kind is VisionProviderKind {
  return Object.prototype.hasOwnProperty.call(VISION_PROVIDER_PRESETS, kind);
}

function isOcrProviderKind(kind: string): kind is OcrProviderKind {
  return Object.prototype.hasOwnProperty.call(OCR_PROVIDER_PRESETS, kind);
}

function inferAgentProviderKind(protocol?: string, baseUrl?: string): AgentProviderKind {
  const url = normalizeBaseUrl(baseUrl).toLowerCase();
  if (protocol === "openai_responses") {
    return "openai-responses-agent";
  }
  if (url.includes("deepseek.com")) return "deepseek";
  if (url.includes("dashscope.aliyuncs.com/apps/anthropic")) return "bailian-anthropic";
  if (url.includes("api.kimi.com/coding")) return "kimi-coding";
  if (url.includes("moonshot.cn/anthropic")) return "kimi-api";
  if (url && !url.includes("api.anthropic.com")) return "custom-anthropic";
  if (protocol === "anthropic_messages" || !url) return "anthropic";
  return "custom-anthropic";
}

function inferEmbeddingProviderKind(baseUrl?: string): EmbeddingProviderKind {
  const url = normalizeBaseUrl(baseUrl).toLowerCase();
  if (url.includes("dashscope.aliyuncs.com")) return "qwen";
  if (url.includes("volces.com")) return "doubao";
  if (url.includes("bigmodel.cn")) return "zhipu";
  if (url.includes("minimax.chat")) return "minimax";
  if (url.includes("api.openai.com") || !url) return "openai";
  return "custom-openai";
}

function inferVisionProviderKind(protocol?: string, baseUrl?: string): VisionProviderKind {
  const url = normalizeBaseUrl(baseUrl).toLowerCase();
  if (url.includes("dashscope.aliyuncs.com")) return "vision-bailian-openai";
  if (protocol === "openai_compatible") return "vision-custom-openai";
  if (protocol === "openai_responses") {
    return url.includes("api.openai.com") || !url ? "vision-openai-responses" : "vision-custom-openai-responses";
  }
  return "vision-custom-anthropic";
}

function inferOcrProviderKind(protocol?: string, baseUrl?: string): OcrProviderKind {
  const url = normalizeBaseUrl(baseUrl).toLowerCase();
  if (protocol === "openai_responses") {
    return url.includes("api.openai.com") || !url ? "ocr-openai-responses" : "ocr-custom-openai";
  }
  if (protocol === "anthropic_messages") return "ocr-custom-anthropic";
  return "ocr-custom-openai";
}

function providerPreset(providerKind: ProviderKind): ProviderPreset {
  return PROVIDER_PRESETS[providerKind];
}

function presetModels(preset: ProviderPreset): ProviderModel[] {
  return (preset.models || []).map((model) => ({ ...model }));
}

function normalizeSelectedModel(provider: LegacyProviderConfig): string {
  return stringValue(provider.selectedModel).trim();
}

function normalizeProviderEnabled(provider: LegacyProviderConfig): boolean {
  return Boolean(provider.enabled);
}

function normalizeAutoCompactThresholdPercent(value: unknown, purpose: ProviderPurpose): number | undefined {
  if (purpose !== "agent") return undefined;
  const numeric = typeof value === "number" ? value : Number.parseFloat(stringValue(value));
  if (!Number.isFinite(numeric)) return DEFAULT_AUTO_COMPACT_THRESHOLD_PERCENT;
  return Math.min(MAX_AUTO_COMPACT_THRESHOLD_PERCENT, Math.max(MIN_AUTO_COMPACT_THRESHOLD_PERCENT, numeric));
}

function activeEmbeddingProviderFingerprint(providers: ModelProviderConfig[]): string | undefined {
  const provider = singleActiveProvider(providers.filter((item) =>
    item.purpose === "embedding" &&
    item.protocol === "openai_compatible" &&
    item.adapterKind === "openai_embedding" &&
    item.enabled &&
    Boolean(item.selectedModel) &&
    Boolean(item.baseUrl),
  ));
  if (!provider) return undefined;
  return embeddingProviderFingerprint(provider);
}

function singleActiveProvider(providers: ModelProviderConfig[]): ModelProviderConfig | undefined {
  return providers.length === 1 ? providers[0] : undefined;
}

function upsertProvider(providers: ModelProviderConfig[], provider: ModelProviderConfig): ModelProviderConfig[] {
  const next = providers.map(cloneProvider);
  const index = next.findIndex((item) => item.id === provider.id);
  if (index >= 0) next[index] = cloneProvider(provider);
  else next.push(cloneProvider(provider));
  return next;
}

function normalizeProviderModels(models: unknown, selectedModel: string): ProviderModel[] {
  const normalized = Array.isArray(models)
    ? models.flatMap((model) => {
        if (!model || typeof model !== "object") return [];
        const item = model as Partial<ProviderModel>;
        const id = stringValue(item.id).trim();
        if (!id) return [];
        return [{
          id,
          name: stringValue(item.name).trim() || id,
          enabled: item.enabled !== false,
          supportsVision: item.supportsVision === true,
          contextWindowTokens: positiveInteger(item.contextWindowTokens),
          contextWindowSource: normalizeContextWindowSource(item.contextWindowSource),
        }];
      })
    : [];
  const unique = new Map<string, ProviderModel>();
  for (const model of normalized) unique.set(model.id, withInferredContextWindow(model));
  if (selectedModel && !unique.has(selectedModel)) {
    unique.set(selectedModel, withInferredContextWindow({ id: selectedModel, name: selectedModel, enabled: true }));
  }
  return [...unique.values()];
}

function selectedEnabledModelId(selectedModel: string, models: unknown): string {
  const normalized = Array.isArray(models) ? models : [];
  const selected = stringValue(selectedModel).trim();
  const enabledModels = normalized.flatMap((model) => {
    if (!model || typeof model !== "object") return [];
    const item = model as Partial<ProviderModel>;
    const id = stringValue(item.id).trim();
    return id && item.enabled !== false ? [id] : [];
  });
  if (selected && enabledModels.includes(selected)) return selected;
  return enabledModels[0] || "";
}

function fetchedAgentModelsAsAvailable(models: ProviderModel[]): ProviderModel[] {
  const unique = new Map<string, ProviderModel>();
  for (const model of models) {
    const id = stringValue(model.id).trim();
    if (!id) continue;
    unique.set(id, {
      id,
      name: stringValue(model.name).trim() || id,
      enabled: false,
      supportsVision: model.supportsVision === true,
      contextWindowTokens: positiveInteger(model.contextWindowTokens),
      contextWindowSource: normalizeContextWindowSource(model.contextWindowSource),
    });
  }
  return [...unique.values()].map(withInferredContextWindow);
}

function mergeFetchedModelsAsAvailable(existingModels: ProviderModel[], fetchedModels: ProviderModel[], selectedModel: string): ProviderModel[] {
  const merged = new Map<string, ProviderModel>();
  for (const model of normalizeProviderModels(existingModels, selectedModel)) {
    merged.set(model.id, model);
  }
  for (const model of fetchedModels) {
    const id = stringValue(model.id).trim();
    if (!id || merged.has(id)) continue;
    merged.set(id, {
      id,
      name: stringValue(model.name).trim() || id,
      enabled: false,
      supportsVision: model.supportsVision === true,
      contextWindowTokens: positiveInteger(model.contextWindowTokens),
      contextWindowSource: normalizeContextWindowSource(model.contextWindowSource),
    });
  }
  return [...merged.values()];
}

export function isVisionCapableAgentModel(provider: ModelProviderConfig, model: ProviderModel): boolean {
  if (model.supportsVision) return true;
  if (provider.purpose !== "agent") return false;
  const id = `${model.id} ${model.name}`.toLowerCase();
  const looksLikeClaudeVision = id.includes("claude-3") || id.includes("claude-4") || id.includes("claude-sonnet") || id.includes("claude-opus") || id.includes("claude-haiku");
  if ((provider.providerKind === "anthropic" || provider.providerKind === "custom-anthropic") && looksLikeClaudeVision) return true;
  return [
    "vision",
    "vl",
    "visual",
    "image",
    "multimodal",
    "omni",
    "gpt-4o",
    "gpt-4.1",
    "gemini",
    "qwen-vl",
    "kimi-vision",
  ].some((token) => id.includes(token));
}

async function fetchProviderModels(
  provider: ModelProviderConfig,
  apiKey: string,
  options: { limit?: number } = {},
): Promise<ProviderModel[]> {
  if (!provider.baseUrl) throw new Error("Base URL is required.");
  if (provider.purpose === "vision" || provider.purpose === "ocr") {
    const response = await fetchWithTimeout(visionModelListUrl(provider), {
      method: "GET",
      headers: provider.protocol === "anthropic_messages" ? visionAnthropicHeaders(provider, apiKey) : visionOpenAiHeaders(provider, apiKey),
    });
    if (!response.ok) throw new Error(`Connection failed (${response.status}) ${await responseShortText(response)}`);
    const payload = await responseJson(response);
    if (!payload) throw new Error(`Expected JSON from ${visionModelListUrl(provider)} but received non-JSON response.`);
    const models = parseProviderModelList(payload);
    return typeof options.limit === "number" ? models.slice(0, options.limit) : models;
  }
  const adapter = provider.purpose === "agent"
    ? getAgentProviderAdapter(provider)
    : getEmbeddingProviderAdapter(provider);
  const request = adapter.buildModelListRequest(provider, apiKey);
  const response = await fetchWithTimeout(request.url, request.init);
  if (!response.ok) {
    if (provider.purpose === "agent" && response.status === 404) {
      throw new Error("This provider does not expose a model list endpoint. Add model names manually.");
    }
    throw new Error(`Connection failed (${response.status}) ${await responseShortText(response)}`);
  }
  const payload = await responseJson(response);
  if (!payload) throw new Error(`Expected JSON from ${request.url} but received non-JSON response.`);
  const models = adapter.parseModelList(payload);
  return typeof options.limit === "number" ? models.slice(0, options.limit) : models;
}

function visionModelListUrl(provider: ModelProviderConfig): string {
  return `${normalizeBaseUrl(provider.baseUrl).replace(/\/messages$/, "").replace(/\/responses$/, "").replace(/\/chat\/completions$/, "")}/models`;
}

function visionAnthropicHeaders(provider: ModelProviderConfig, apiKey: string): Record<string, string> {
  const headers: Record<string, string> = {
    "anthropic-version": "2023-06-01",
    "content-type": "application/json",
  };
  if (provider.authMode === "bearer") headers.Authorization = `Bearer ${apiKey}`;
  else {
    headers["x-api-key"] = apiKey;
    headers.Authorization = `Bearer ${apiKey}`;
  }
  return headers;
}

function visionOpenAiHeaders(provider: ModelProviderConfig, apiKey: string): Record<string, string> {
  return provider.authMode === "api_key"
    ? { "x-api-key": apiKey, "content-type": "application/json" }
    : { Authorization: `Bearer ${apiKey}`, "content-type": "application/json" };
}

function parseProviderModelList(payload: unknown): ProviderModel[] {
  const data = payload && typeof payload === "object"
    ? (payload as { data?: Array<{ id?: string; display_name?: string; name?: string; context_window?: unknown; contextWindow?: unknown; context_length?: unknown; max_context_tokens?: unknown }> }).data
    : undefined;
  return (data || [])
    .flatMap((item) => {
      const id = stringValue(item.id).trim();
      if (!id) return [];
      const contextWindowTokens = positiveInteger(item.context_window ?? item.contextWindow ?? item.context_length ?? item.max_context_tokens);
      return [withInferredContextWindow({
        id,
        name: stringValue(item.display_name || item.name) || id,
        enabled: false,
        contextWindowTokens,
        contextWindowSource: contextWindowTokens ? "provider" : undefined,
      })];
    })
    .sort((a, b) => a.id.localeCompare(b.id));
}

async function testAgentProvider(provider: ModelProviderConfig, apiKey: string): Promise<void> {
  const adapter = getAgentProviderAdapter(provider);
  const request = adapter.buildConnectionTestRequest(provider, apiKey);
  const response = await fetchWithTimeout(request.url, request.init);
  if (response.ok) return;
  const text = await responseShortText(response);
  if (response.status === 401) throw new Error(`API key is invalid${text ? `: ${text}` : ""}`);
  throw new Error(`Agent request failed (${response.status}): ${text}`);
}

async function testEmbeddingProvider(provider: ModelProviderConfig, apiKey: string): Promise<number> {
  const model = provider.selectedModel.trim();
  if (!model) throw new Error("Embedding model is required before testing the provider.");
  const adapter = getEmbeddingProviderAdapter(provider);
  const request = adapter.buildEmbeddingRequest(provider, apiKey, ["test"]);
  const response = await fetchWithTimeout(request.url, request.init);
  if (!response.ok) {
    throw new Error(`Embedding request failed (${response.status}): ${await responseShortText(response)}`);
  }
  const payload = await responseJson(response);
  if (!payload) throw new Error("Embedding endpoint returned non-JSON response.");
  const vectors = adapter.parseEmbeddingResponse(payload);
  const embedding = vectors[0];
  if (!embedding) throw new Error("Embedding endpoint returned no vectors.");
  return embedding.length;
}

async function testVisionProvider(provider: ModelProviderConfig, apiKey: string): Promise<void> {
  const model = provider.selectedModel.trim();
  if (!model) throw new Error("Vision model is required before testing the provider.");
  const response = await fetchWithTimeout(visionTestUrl(provider), visionTestInit(provider, apiKey, model));
  if (response.ok) return;
  const text = await responseShortText(response);
  if (response.status === 401) throw new Error(`API key is invalid${text ? `: ${text}` : ""}`);
  throw new Error(`Vision request failed (${response.status}): ${text}`);
}

function visionTestUrl(provider: ModelProviderConfig): string {
  if (provider.protocol === "openai_responses") return `${normalizeBaseUrl(provider.baseUrl)}/responses`;
  if (provider.protocol === "openai_compatible") return `${normalizeBaseUrl(provider.baseUrl).replace(/\/chat\/completions$/, "")}/chat/completions`;
  return `${normalizeBaseUrl(provider.baseUrl).replace(/\/messages$/, "")}/messages`;
}

function visionTestInit(provider: ModelProviderConfig, apiKey: string, model: string): RequestInit {
  if (provider.protocol === "openai_responses") {
    return {
      method: "POST",
      headers: visionOpenAiHeaders(provider, apiKey),
      body: JSON.stringify({
        model,
        max_output_tokens: 16,
        input: [{ role: "user", content: [{ type: "input_text", text: "hi" }] }],
      }),
    };
  }
  if (provider.protocol === "openai_compatible") {
    return {
      method: "POST",
      headers: visionOpenAiHeaders(provider, apiKey),
      body: JSON.stringify({
        model,
        max_tokens: 16,
        messages: [{ role: "user", content: "hi" }],
      }),
    };
  }
  return {
    method: "POST",
    headers: visionAnthropicHeaders(provider, apiKey),
    body: JSON.stringify({
      model,
      max_tokens: 1,
      messages: [{ role: "user", content: "hi" }],
    }),
  };
}

async function fetchWithTimeout(url: string, init: RequestInit): Promise<Response> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), PROVIDER_FETCH_TIMEOUT_MS);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") {
      throw new Error("Connection timed out.");
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

function filterModelsForPurpose(purpose: ProviderPurpose, models: ProviderModel[]): ProviderModel[] {
  if (purpose === "agent") return models;
  if (purpose === "vision" || purpose === "ocr") return models.filter((model) => !isEmbeddingModelId(model.id));
  const embeddingModels = models.filter((model) => isEmbeddingModelId(model.id));
  return embeddingModels.length > 0 ? embeddingModels : models;
}

function isEmbeddingModelId(modelId: string): boolean {
  const lower = modelId.toLowerCase();
  return (
    lower.includes("embedding") ||
    lower.includes("embed") ||
    lower.includes("bge") ||
    lower.includes("gte") ||
    lower.includes("e5") ||
    lower.includes("jina") ||
    lower.includes("voyage")
  );
}

async function responseShortText(response: Response): Promise<string> {
  try {
    return (await response.text()).replace(/\s+/g, " ").slice(0, 180);
  } catch {
    return "";
  }
}

async function responseJson(response: Response): Promise<unknown | null> {
  const contentType = response.headers.get("content-type") || "";
  const text = await response.text();
  if (contentType.includes("application/json") || text.trim().startsWith("{") || text.trim().startsWith("[")) {
    try {
      return JSON.parse(text);
    } catch {
      return null;
    }
  }
  return null;
}

function stringValue(value: unknown): string {
  return typeof value === "string" ? value : value === null || value === undefined ? "" : String(value);
}

function positiveInteger(value: unknown): number | undefined {
  const numeric = typeof value === "number" ? value : Number.parseFloat(stringValue(value));
  return Number.isFinite(numeric) && numeric > 0 ? Math.floor(numeric) : undefined;
}

function normalizeContextWindowSource(value: unknown): ProviderModel["contextWindowSource"] {
  return value === "provider" || value === "user" || value === "inferred" ? value : undefined;
}

function normalizeProviderDraftInput(input: unknown): ProviderDraftInput {
  const draft = input && typeof input === "object" ? input as Partial<ProviderDraftInput> : {};
  const purpose = draft.purpose === "agent" || draft.purpose === "embedding" || draft.purpose === "vision" || draft.purpose === "ocr"
    ? draft.purpose
    : providerPurposeForKind(stringValue(draft.providerKind)) || (draft.protocol === "openai_responses" ? "vision" : draft.protocol === "anthropic_messages" ? "agent" : "embedding");
  const providerKind = normalizeProviderKind(stringValue(draft.providerKind), purpose, stringValue(draft.protocol), stringValue(draft.baseUrl));
  return {
    id: stringValue(draft.id).trim() || undefined,
    purpose,
    providerKind,
    name: stringValue(draft.name).trim(),
    protocol: providerPreset(providerKind).protocol,
    baseUrl: stringValue(draft.baseUrl),
    apiKey: stringValue(draft.apiKey).trim(),
    clearApiKey: Boolean(draft.clearApiKey),
    authMode: normalizeProviderAuthMode(stringValue(draft.authMode), purpose, providerKind),
    models: Array.isArray(draft.models) ? draft.models : [],
    selectedModel: stringValue(draft.selectedModel).trim(),
    enabled: typeof draft.enabled === "boolean" ? draft.enabled : undefined,
    autoCompactThresholdPercent: normalizeAutoCompactThresholdPercent(draft.autoCompactThresholdPercent, purpose),
  };
}

function cloneProvider(provider: ModelProviderConfig): ModelProviderConfig {
  return {
    ...provider,
    models: provider.models.map((model) => ({ ...model })),
  };
}
