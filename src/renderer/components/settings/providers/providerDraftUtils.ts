import { withInferredContextWindow } from "../../../../shared/model-context-window";
import { DEFAULT_AUTO_COMPACT_THRESHOLD_PERCENT, PROVIDER_PRESETS, type ModelProviderConfig, type ProviderDraftInput, type ProviderKind, type ProviderModel, type ProviderPurpose } from "../../../../types/domain";

export type ProviderDraftFetchTarget = Pick<ProviderDraftInput, "id" | "purpose" | "providerKind" | "protocol" | "authMode" | "baseUrl" | "apiKey">;

export function nextProviderDraftName(providers: ModelProviderConfig[], purpose: ProviderPurpose): string {
  const prefix = purpose === "agent" ? "Agent" : purpose === "vision" ? "Vision" : purpose === "ocr" ? "OCR" : "Embedding";
  const used = new Set(
    providers
      .filter((provider) => provider.purpose === purpose)
      .map((provider) => provider.name.trim().replace(/\s+/g, " ").toLowerCase()),
  );
  let index = 1;
  while (used.has(`${prefix} ${index}`.toLowerCase())) index += 1;
  return `${prefix} ${index}`;
}

export function toProviderDraft(provider: ModelProviderConfig, overrides: Partial<ProviderDraftInput> = {}): ProviderDraftInput {
  return {
    id: provider.id,
    purpose: provider.purpose,
    providerKind: provider.providerKind,
    name: provider.name,
    protocol: provider.protocol,
    authMode: provider.authMode,
    baseUrl: provider.baseUrl,
    apiKey: "",
    clearApiKey: false,
    models: provider.models.map((model) => ({ ...model })),
    selectedModel: provider.selectedModel,
    enabled: provider.enabled,
    autoCompactThresholdPercent: provider.autoCompactThresholdPercent ?? DEFAULT_AUTO_COMPACT_THRESHOLD_PERCENT,
    ...overrides,
  };
}

export function providerDraftFetchTarget(draft: ProviderDraftInput): ProviderDraftFetchTarget {
  return {
    id: draft.id,
    purpose: draft.purpose,
    providerKind: draft.providerKind,
    protocol: draft.protocol,
    authMode: draft.authMode,
    baseUrl: normalizeProviderDraftBaseUrl(draft.baseUrl),
    apiKey: draft.apiKey,
  };
}

export function isSameProviderDraftFetchTarget(draft: ProviderDraftInput, target: ProviderDraftFetchTarget): boolean {
  const current = providerDraftFetchTarget(draft);
  return current.id === target.id
    && current.purpose === target.purpose
    && current.providerKind === target.providerKind
    && current.protocol === target.protocol
    && current.authMode === target.authMode
    && current.baseUrl === target.baseUrl
    && current.apiKey === target.apiKey;
}

export function normalizeProviderDraftBaseUrl(value: string): string {
  return value.trim().replace(/\/+$/, "");
}

export function selectedEnabledModel(selectedModel: string, models: ProviderModel[]): string {
  if (selectedModel && models.some((model) => model.id === selectedModel && model.enabled !== false)) return selectedModel;
  return models.find((model) => model.enabled !== false)?.id || "";
}

export function toggleDraftModel(draft: ProviderDraftInput, modelId: string): ProviderDraftInput {
  const models = (draft.models || []).map((model) => (
    model.id === modelId ? { ...model, enabled: model.enabled === false } : model
  ));
  const selectedModel = selectedEnabledModel(draft.selectedModel === modelId ? "" : draft.selectedModel, models);
  return { ...draft, models, selectedModel };
}

export function updateDraftModel(draft: ProviderDraftInput, nextModel: ProviderModel): ProviderDraftInput {
  const models = (draft.models || []).map((model) => (
    model.id === nextModel.id ? { ...nextModel } : model
  ));
  return { ...draft, models };
}

export function removeDraftModel(draft: ProviderDraftInput, modelId: string): ProviderDraftInput {
  const models = (draft.models || []).filter((model) => model.id !== modelId);
  return {
    ...draft,
    models,
    selectedModel: selectedEnabledModel(draft.selectedModel === modelId ? "" : draft.selectedModel, models),
  };
}

export function addDraftModel(draft: ProviderDraftInput, modelId: string): ProviderDraftInput {
  const normalizedId = modelId.trim();
  if (!normalizedId) return draft;
  const existing = draft.models || [];
  const models = existing.some((model) => model.id === normalizedId)
    ? existing.map((model) => (model.id === normalizedId ? { ...model, enabled: true } : model))
    : [...existing, withInferredContextWindow({ id: normalizedId, name: normalizedId, enabled: true })];
  return {
    ...draft,
    models,
    selectedModel: selectedEnabledModel(draft.selectedModel, models) || normalizedId,
  };
}

export function mergeFetchedDraftModels(draft: ProviderDraftInput, fetchedModels: ProviderModel[]): ProviderDraftInput {
  const merged = new Map<string, ProviderModel>();
  for (const fetched of fetchedModels) {
    const model = withInferredContextWindow({ ...fetched });
    merged.set(model.id, model);
  }

  for (const existingModel of draft.models || []) {
    const existing = withInferredContextWindow({ ...existingModel });
    const fetched = merged.get(existing.id);
    if (!fetched) {
      merged.set(existing.id, existing);
      continue;
    }
    const userContextWindow = existing.contextWindowSource === "user" && existing.contextWindowTokens;
    merged.set(existing.id, {
      ...fetched,
      enabled: existing.enabled,
      supportsVision: fetched.supportsVision || existing.supportsVision,
      contextWindowTokens: userContextWindow ? existing.contextWindowTokens : fetched.contextWindowTokens ?? existing.contextWindowTokens,
      contextWindowSource: userContextWindow ? "user" : fetched.contextWindowSource ?? existing.contextWindowSource,
    });
  }

  const models = [...merged.values()];
  return {
    ...draft,
    models,
    selectedModel: selectedEnabledModel(draft.selectedModel, models),
  };
}

export function applyProviderPreset(draft: ProviderDraftInput, providerKind: ProviderKind): ProviderDraftInput {
  const preset = PROVIDER_PRESETS[providerKind];
  const models = preset.purpose === "agent" || preset.purpose === "vision" || preset.purpose === "ocr" ? [] : presetModels(providerKind);
  return {
    ...draft,
    purpose: preset.purpose,
    providerKind,
    protocol: preset.protocol,
    authMode: preset.authMode,
    baseUrl: preset.baseUrl,
    models,
    selectedModel: "",
    autoCompactThresholdPercent: preset.purpose === "agent"
      ? draft.autoCompactThresholdPercent ?? DEFAULT_AUTO_COMPACT_THRESHOLD_PERCENT
      : undefined,
  };
}

export function presetModels(providerKind: ProviderKind): ProviderModel[] {
  const preset = PROVIDER_PRESETS[providerKind];
  if (!("models" in preset)) return [];
  return preset.models.map((model) => withInferredContextWindow({ ...model }));
}

export function adapterLabel(providerKind: ProviderKind): string {
  const preset = PROVIDER_PRESETS[providerKind];
  if (preset.adapterKind === "anthropic") return "Anthropic Messages";
  if (preset.adapterKind === "openai_chat_completions") return "OpenAI Chat Completions";
  if (preset.adapterKind === "openai_responses") return "OpenAI Responses";
  return "OpenAI-compatible Embeddings";
}

export function hasRunnableVisionProvider(providers: ModelProviderConfig[]): boolean {
  return providers.some((provider) =>
    provider.enabled &&
    Boolean(provider.selectedModel) &&
    provider.models.some((model) => model.id === provider.selectedModel && model.enabled !== false),
  );
}
