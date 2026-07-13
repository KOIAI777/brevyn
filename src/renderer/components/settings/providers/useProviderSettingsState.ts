import { useEffect, useRef, useState, type ComponentProps } from "react";
import { useConfirmDialog } from "@/components/ui/ConfirmDialog";
import { ProviderSettingsPage, type ProviderBusyAction } from "@/components/settings/providers/ProviderSettingsPage";
import { providerDisplayName } from "@/components/settings/providers/providerUtils";
import {
  isSameProviderDraftFetchTarget,
  mergeFetchedDraftModels,
  nextProviderDraftName,
  providerDraftFetchTarget,
  selectedEnabledModel,
  toProviderDraft,
} from "@/components/settings/providers/providerDraftUtils";
import { errorMessage } from "@/components/settings/shared/settingsErrors";
import {
  AGENT_PROVIDER_PRESETS,
  DEFAULT_AUTO_COMPACT_THRESHOLD_PERCENT,
  EMBEDDING_PROVIDER_PRESETS,
  OCR_PROVIDER_PRESETS,
  VISION_PROVIDER_PRESETS,
  type AgentGatewayStatus,
  type AgentProviderKind,
  type EmbeddingIndexHealth,
  type ModelProviderConfig,
  type ProviderDraftInput,
  type ProviderModel,
} from "../../../../types/domain";

interface UseProviderSettingsStateArgs {
  onAgentProviderChanged?: (providerSelection: string) => Promise<void> | void;
}

const emptyDraft: ProviderDraftInput = {
  purpose: "agent",
  providerKind: "anthropic",
  name: "",
  protocol: "anthropic_messages",
  authMode: AGENT_PROVIDER_PRESETS.anthropic.authMode,
  baseUrl: AGENT_PROVIDER_PRESETS.anthropic.baseUrl,
  apiKey: "",
  clearApiKey: false,
  models: [],
  selectedModel: "",
  enabled: false,
  autoCompactThresholdPercent: DEFAULT_AUTO_COMPACT_THRESHOLD_PERCENT,
};

const emptyEmbeddingDraft: ProviderDraftInput = {
  purpose: "embedding",
  providerKind: "openai",
  name: "",
  protocol: "openai_compatible",
  authMode: EMBEDDING_PROVIDER_PRESETS.openai.authMode,
  baseUrl: EMBEDDING_PROVIDER_PRESETS.openai.baseUrl,
  apiKey: "",
  clearApiKey: false,
  models: [],
  selectedModel: "",
  enabled: false,
};

const emptyVisionDraft: ProviderDraftInput = {
  purpose: "vision",
  providerKind: "vision-bailian-openai",
  name: "",
  protocol: "openai_compatible",
  authMode: VISION_PROVIDER_PRESETS["vision-bailian-openai"].authMode,
  baseUrl: VISION_PROVIDER_PRESETS["vision-bailian-openai"].baseUrl,
  apiKey: "",
  clearApiKey: false,
  models: [],
  selectedModel: "",
  enabled: false,
};

const emptyOcrDraft: ProviderDraftInput = {
  purpose: "ocr",
  providerKind: "ocr-custom-openai",
  name: "",
  protocol: "openai_compatible",
  authMode: OCR_PROVIDER_PRESETS["ocr-custom-openai"].authMode,
  baseUrl: OCR_PROVIDER_PRESETS["ocr-custom-openai"].baseUrl,
  apiKey: "",
  clearApiKey: false,
  models: [],
  selectedModel: "",
  enabled: false,
};

export function useProviderSettingsState({ onAgentProviderChanged }: UseProviderSettingsStateArgs) {
  const [providers, setProviders] = useState<ModelProviderConfig[]>([]);
  const [selectedProviderId, setSelectedProviderId] = useState("");
  const [selectedEmbeddingProviderId, setSelectedEmbeddingProviderId] = useState("");
  const [selectedVisionProviderId, setSelectedVisionProviderId] = useState("");
  const [selectedOcrProviderId, setSelectedOcrProviderId] = useState("");
  const [creatingProvider, setCreatingProvider] = useState(false);
  const [creatingEmbeddingProvider, setCreatingEmbeddingProvider] = useState(false);
  const [creatingVisionProvider, setCreatingVisionProvider] = useState(false);
  const [creatingOcrProvider, setCreatingOcrProvider] = useState(false);
  const [draft, setDraft] = useState<ProviderDraftInput>(emptyDraft);
  const [embeddingDraft, setEmbeddingDraft] = useState<ProviderDraftInput>(emptyEmbeddingDraft);
  const [visionDraft, setVisionDraft] = useState<ProviderDraftInput>(emptyVisionDraft);
  const [ocrDraft, setOcrDraft] = useState<ProviderDraftInput>(emptyOcrDraft);
  const [models, setModels] = useState<ProviderModel[]>([]);
  const [visionModels, setVisionModels] = useState<ProviderModel[]>([]);
  const [ocrModels, setOcrModels] = useState<ProviderModel[]>([]);
  const [statusLine, setStatusLine] = useState("");
  const [embeddingStatusLine, setEmbeddingStatusLine] = useState("");
  const [visionStatusLine, setVisionStatusLine] = useState("");
  const [ocrStatusLine, setOcrStatusLine] = useState("");
  const [embeddingReindexNotice, setEmbeddingReindexNotice] = useState("");
  const [embeddingIndexHealth, setEmbeddingIndexHealth] = useState<EmbeddingIndexHealth | null>(null);
  const [embeddingLockedByIndexing, setEmbeddingLockedByIndexing] = useState(false);
  const [reindexingActiveSemester, setReindexingActiveSemester] = useState(false);
  const [providerToast, setProviderToast] = useState<{ id: number; message: string } | null>(null);
  const [providerBusyActions, setProviderBusyActions] = useState<Partial<Record<ProviderBusyAction, boolean>>>({});
  const [agentGatewayStatus, setAgentGatewayStatus] = useState<AgentGatewayStatus | null>(null);
  const [agentGatewayBusy, setAgentGatewayBusy] = useState(false);
  const { confirm: confirmProviderAction, confirmDialog: providerConfirmDialog } = useConfirmDialog();
  const providerApiKeyLoadRequestRef = useRef(0);
  const embeddingApiKeyLoadRequestRef = useRef(0);
  const visionApiKeyLoadRequestRef = useRef(0);
  const ocrApiKeyLoadRequestRef = useRef(0);
  const agentModelsFetchRequestRef = useRef(0);
  const embeddingModelsFetchRequestRef = useRef(0);
  const visionModelsFetchRequestRef = useRef(0);
  const ocrModelsFetchRequestRef = useRef(0);
  const draftRef = useRef(draft);
  const embeddingDraftRef = useRef(embeddingDraft);
  const visionDraftRef = useRef(visionDraft);
  const ocrDraftRef = useRef(ocrDraft);

  useEffect(() => {
    void loadProviders();
    void loadEmbeddingMutable();
    void loadEmbeddingIndexHealth();
    void loadAgentGatewayStatus();
  }, []);

  useEffect(() => {
    const unsubscribe = window.brevyn.files.onChanged(() => {
      void loadEmbeddingMutable();
      void loadEmbeddingIndexHealth();
    });
    const timer = window.setInterval(() => {
      void loadEmbeddingMutable();
      void loadEmbeddingIndexHealth();
    }, embeddingLockedByIndexing ? 1600 : 5000);
    return () => {
      unsubscribe();
      window.clearInterval(timer);
    };
  }, [embeddingLockedByIndexing]);

  useEffect(() => {
    draftRef.current = draft;
  }, [draft]);

  useEffect(() => {
    embeddingDraftRef.current = embeddingDraft;
  }, [embeddingDraft]);

  useEffect(() => {
    visionDraftRef.current = visionDraft;
  }, [visionDraft]);

  useEffect(() => {
    ocrDraftRef.current = ocrDraft;
  }, [ocrDraft]);

  useEffect(() => {
    if (!providerToast) return;
    const timeout = window.setTimeout(() => setProviderToast(null), 2200);
    return () => window.clearTimeout(timeout);
  }, [providerToast]);

  useEffect(() => {
    if (!selectedProviderId || creatingProvider) return;
    const provider = providers.find((item) => item.id === selectedProviderId);
    if (!provider) return;
    const requestId = ++providerApiKeyLoadRequestRef.current;
    void window.brevyn.providers
      .decryptApiKey(provider.id)
      .then((apiKey) => {
        if (providerApiKeyLoadRequestRef.current !== requestId) return;
        setDraft((current) => {
          if (current.id !== provider.id) return current;
          if (current.apiKey.trim()) return current;
          return { ...current, apiKey };
        });
      })
      .catch((error) => {
        if (providerApiKeyLoadRequestRef.current !== requestId) return;
        console.warn("[providers] Failed to load provider API key", error);
      });
    return () => {
      providerApiKeyLoadRequestRef.current += 1;
    };
  }, [creatingProvider, providers, selectedProviderId]);

  useEffect(() => {
    if (!selectedEmbeddingProviderId || creatingEmbeddingProvider) return;
    const provider = providers.find((item) => item.id === selectedEmbeddingProviderId);
    if (!provider) return;
    const requestId = ++embeddingApiKeyLoadRequestRef.current;
    void window.brevyn.providers
      .decryptApiKey(provider.id)
      .then((apiKey) => {
        if (embeddingApiKeyLoadRequestRef.current !== requestId) return;
        setEmbeddingDraft((current) => {
          if (current.id !== provider.id) return current;
          if (current.apiKey.trim()) return current;
          return { ...current, apiKey };
        });
      })
      .catch((error) => {
        if (embeddingApiKeyLoadRequestRef.current !== requestId) return;
        console.warn("[providers] Failed to load embedding provider API key", error);
      });
    return () => {
      embeddingApiKeyLoadRequestRef.current += 1;
    };
  }, [creatingEmbeddingProvider, providers, selectedEmbeddingProviderId]);

  useEffect(() => {
    if (!selectedVisionProviderId || creatingVisionProvider) return;
    const provider = providers.find((item) => item.id === selectedVisionProviderId);
    if (!provider) return;
    const requestId = ++visionApiKeyLoadRequestRef.current;
    void window.brevyn.providers
      .decryptApiKey(provider.id)
      .then((apiKey) => {
        if (visionApiKeyLoadRequestRef.current !== requestId) return;
        setVisionDraft((current) => {
          if (current.id !== provider.id) return current;
          if (current.apiKey.trim()) return current;
          return { ...current, apiKey };
        });
      })
      .catch((error) => {
        if (visionApiKeyLoadRequestRef.current !== requestId) return;
        console.warn("[providers] Failed to load vision provider API key", error);
      });
    return () => {
      visionApiKeyLoadRequestRef.current += 1;
    };
  }, [creatingVisionProvider, providers, selectedVisionProviderId]);

  useEffect(() => {
    if (!selectedOcrProviderId || creatingOcrProvider) return;
    const provider = providers.find((item) => item.id === selectedOcrProviderId);
    if (!provider) return;
    const requestId = ++ocrApiKeyLoadRequestRef.current;
    void window.brevyn.providers
      .decryptApiKey(provider.id)
      .then((apiKey) => {
        if (ocrApiKeyLoadRequestRef.current !== requestId) return;
        setOcrDraft((current) => {
          if (current.id !== provider.id) return current;
          if (current.apiKey.trim()) return current;
          return { ...current, apiKey };
        });
      })
      .catch((error) => {
        if (ocrApiKeyLoadRequestRef.current !== requestId) return;
        console.warn("[providers] Failed to load OCR provider API key", error);
      });
    return () => {
      ocrApiKeyLoadRequestRef.current += 1;
    };
  }, [creatingOcrProvider, providers, selectedOcrProviderId]);

  async function loadProviders() {
    try {
      const result = await window.brevyn.providers.list();
      setProviders(result);
      closeProviderEditor();
      closeEmbeddingEditor();
      closeVisionEditor();
      closeOcrEditor();
      setStatusLine("");
      setEmbeddingStatusLine("");
      setVisionStatusLine("");
      setOcrStatusLine("");
    } catch (error) {
      setProviders([]);
      const message = errorMessage(error, "加载服务商失败。");
      setStatusLine(message);
      setEmbeddingStatusLine(message);
      setVisionStatusLine(message);
      setOcrStatusLine(message);
    }
  }

  async function loadEmbeddingMutable() {
    try {
      setEmbeddingLockedByIndexing(!(await window.brevyn.providers.embeddingMutable()));
    } catch (error) {
      console.warn("[providers] Failed to load embedding mutability", error);
      setEmbeddingLockedByIndexing(false);
    }
  }

  async function loadEmbeddingIndexHealth() {
    try {
      setEmbeddingIndexHealth(await window.brevyn.files.indexHealth());
    } catch (error) {
      console.warn("[providers] Failed to load embedding index health", error);
      setEmbeddingIndexHealth(null);
    }
  }

  async function loadAgentGatewayStatus() {
    try {
      setAgentGatewayStatus(await window.brevyn.agentGateway.status());
    } catch (error) {
      console.warn("[agent-gateway] Failed to load status", error);
    }
  }

  async function setOpenAiResponsesGatewayEnabled(enabled: boolean) {
    setAgentGatewayBusy(true);
    try {
      const status = await window.brevyn.agentGateway.setEnabled(enabled);
      setAgentGatewayStatus(status);
      showProviderToast(enabled ? "OpenAI Responses Gateway 已启用。" : "OpenAI Responses Gateway 已关闭。");
    } catch (error) {
      setAgentGatewayStatus((current) => ({
        enabled,
        state: "failed",
        activeRuns: current?.activeRuns ?? 0,
        url: current?.url,
        error: errorMessage(error),
      }));
    } finally {
      setAgentGatewayBusy(false);
    }
  }

  function selectProvider(provider: ModelProviderConfig) {
    agentModelsFetchRequestRef.current += 1;
    setProviderBusy("agent-fetch", false);
    closeEmbeddingEditor();
    closeVisionEditor();
    closeOcrEditor();
    setCreatingProvider(false);
    setSelectedProviderId(provider.id);
    setDraft(toProviderDraft(provider));
    setModels([]);
    setStatusLine("");
  }

  function selectEmbeddingProvider(provider: ModelProviderConfig) {
    embeddingModelsFetchRequestRef.current += 1;
    setProviderBusy("embedding-fetch", false);
    closeProviderEditor();
    closeVisionEditor();
    closeOcrEditor();
    setCreatingEmbeddingProvider(false);
    setSelectedEmbeddingProviderId(provider.id);
    setEmbeddingDraft(toProviderDraft(provider));
    setEmbeddingStatusLine("");
  }

  function selectVisionProvider(provider: ModelProviderConfig) {
    visionModelsFetchRequestRef.current += 1;
    setProviderBusy("vision-fetch", false);
    closeProviderEditor();
    closeEmbeddingEditor();
    closeOcrEditor();
    setCreatingVisionProvider(false);
    setSelectedVisionProviderId(provider.id);
    setVisionDraft(toProviderDraft(provider));
    setVisionModels([]);
    setVisionStatusLine("");
  }

  function selectOcrProvider(provider: ModelProviderConfig) {
    ocrModelsFetchRequestRef.current += 1;
    setProviderBusy("ocr-fetch", false);
    closeProviderEditor();
    closeEmbeddingEditor();
    closeVisionEditor();
    setCreatingOcrProvider(false);
    setSelectedOcrProviderId(provider.id);
    setOcrDraft(toProviderDraft(provider));
    setOcrModels([]);
    setOcrStatusLine("");
  }

  function newProvider() {
    agentModelsFetchRequestRef.current += 1;
    setProviderBusy("agent-fetch", false);
    closeEmbeddingEditor();
    closeVisionEditor();
    closeOcrEditor();
    setCreatingProvider(true);
    setSelectedProviderId("");
    setDraft({ ...emptyDraft, name: nextProviderDraftName(providers, "agent"), enabled: true });
    setModels([]);
    setStatusLine("");
  }

  function newEmbeddingProvider() {
    if (embeddingLockedByIndexing) {
      setEmbeddingStatusLine("当前有向量索引任务正在进行。请等待完成或取消后，再新建 Embedding 配置。");
      return;
    }
    embeddingModelsFetchRequestRef.current += 1;
    setProviderBusy("embedding-fetch", false);
    closeProviderEditor();
    closeVisionEditor();
    closeOcrEditor();
    setCreatingEmbeddingProvider(true);
    setSelectedEmbeddingProviderId("");
    setEmbeddingDraft({ ...emptyEmbeddingDraft, name: nextProviderDraftName(providers, "embedding"), enabled: true });
    setEmbeddingStatusLine("");
  }

  function newVisionProvider() {
    visionModelsFetchRequestRef.current += 1;
    setProviderBusy("vision-fetch", false);
    closeProviderEditor();
    closeEmbeddingEditor();
    closeOcrEditor();
    setCreatingVisionProvider(true);
    setSelectedVisionProviderId("");
    setVisionDraft({ ...emptyVisionDraft, name: nextProviderDraftName(providers, "vision"), enabled: true });
    setVisionModels([]);
    setVisionStatusLine("");
  }

  function newOcrProvider() {
    ocrModelsFetchRequestRef.current += 1;
    setProviderBusy("ocr-fetch", false);
    closeProviderEditor();
    closeEmbeddingEditor();
    closeVisionEditor();
    setCreatingOcrProvider(true);
    setSelectedOcrProviderId("");
    setOcrDraft({ ...emptyOcrDraft, name: nextProviderDraftName(providers, "ocr"), enabled: true });
    setOcrModels([]);
    setOcrStatusLine("");
  }

  function closeProviderEditor() {
    agentModelsFetchRequestRef.current += 1;
    setProviderBusy("agent-fetch", false);
    setCreatingProvider(false);
    setSelectedProviderId("");
    setDraft({ ...emptyDraft });
    setModels([]);
  }

  function closeEmbeddingEditor() {
    embeddingModelsFetchRequestRef.current += 1;
    setProviderBusy("embedding-fetch", false);
    setCreatingEmbeddingProvider(false);
    setSelectedEmbeddingProviderId("");
    setEmbeddingDraft({ ...emptyEmbeddingDraft });
  }

  function closeVisionEditor() {
    visionModelsFetchRequestRef.current += 1;
    setProviderBusy("vision-fetch", false);
    setCreatingVisionProvider(false);
    setSelectedVisionProviderId("");
    setVisionDraft({ ...emptyVisionDraft });
    setVisionModels([]);
  }

  function closeOcrEditor() {
    ocrModelsFetchRequestRef.current += 1;
    setProviderBusy("ocr-fetch", false);
    setCreatingOcrProvider(false);
    setSelectedOcrProviderId("");
    setOcrDraft({ ...emptyOcrDraft });
    setOcrModels([]);
  }

  function setProviderBusy(action: ProviderBusyAction, busy: boolean) {
    setProviderBusyActions((current) => {
      if (busy) return { ...current, [action]: true };
      const { [action]: _finished, ...rest } = current;
      return rest;
    });
  }

  function showProviderToast(message: string) {
    setProviderToast({ id: Date.now(), message });
  }

  async function handleEmbeddingIndexNotice(savedMessage: string) {
    showProviderToast(savedMessage);
    setEmbeddingReindexNotice("");
    setEmbeddingStatusLine("");
    await loadEmbeddingIndexHealth();
  }

  async function reindexActiveSemester() {
    setReindexingActiveSemester(true);
    try {
      const result = await window.brevyn.files.indexActiveSemester();
      const queued = result.jobs.filter((job) => job.status === "queued" || job.status === "indexing").length;
      const failed = result.failures.length;
      if (failed > 0) {
        const summary = result.failures.slice(0, 2).map((failure) => `${failure.courseName}: ${failure.message}`).join("; ");
        const suffix = result.failures.length > 2 ? `；另有 ${result.failures.length - 2} 个失败` : "";
        setEmbeddingReindexNotice(`部分工作区无法加入队列：${summary}${suffix}。请修复后重试。`);
        setEmbeddingStatusLine(`已为 ${queued} 个活跃工作区加入重建索引队列；${failed} 个失败。`);
      } else {
        setEmbeddingReindexNotice("");
        setEmbeddingStatusLine(`已为 ${queued} 个活跃工作区加入重建索引队列。`);
      }
      await loadEmbeddingIndexHealth();
    } catch (error) {
      setEmbeddingReindexNotice("无法开始重建索引。请修复问题后重试。");
      setEmbeddingStatusLine(`重建索引失败：${errorMessage(error)}`);
    } finally {
      setReindexingActiveSemester(false);
    }
  }

  async function saveProvider() {
    setProviderBusy("agent-save", true);
    try {
      const result = await window.brevyn.providers.save({ ...draft, purpose: "agent", protocol: AGENT_PROVIDER_PRESETS[draft.providerKind as AgentProviderKind]?.protocol || draft.protocol });
      const saved = result.provider;
      const next = await window.brevyn.providers.list();
      setProviders(next);
      setCreatingProvider(false);
      setSelectedProviderId(saved.id);
      setDraft((current) => ({
        ...current,
        id: saved.id,
        purpose: saved.purpose,
        providerKind: saved.providerKind,
        name: saved.name,
        protocol: saved.protocol,
        authMode: saved.authMode,
        baseUrl: saved.baseUrl,
        models: saved.models.map((model) => ({ ...model })),
        selectedModel: saved.selectedModel,
        enabled: saved.enabled,
      }));
      setStatusLine("");
      showProviderToast("聊天服务商已保存。");
    } catch (error) {
      setStatusLine(`保存模型服务商配置失败：${errorMessage(error)}`);
    } finally {
      setProviderBusy("agent-save", false);
    }
  }

  async function deleteProvider(provider: ModelProviderConfig) {
    const ok = await confirmProviderAction({
      title: `删除模型服务商配置“${provider.name}”？`,
      message: "这会删除已保存的配置和本地元数据。",
      confirmLabel: "删除",
      cancelLabel: "取消",
      tone: "danger",
    });
    if (!ok) return;
    setProviderBusy("agent-delete", true);
    try {
      await window.brevyn.providers.delete(provider.id);
      const next = await window.brevyn.providers.list();
      setProviders(next);
      closeProviderEditor();
      setStatusLine(`已删除模型服务商配置“${provider.name}”。`);
    } catch (error) {
      setStatusLine(`删除模型服务商配置失败：${errorMessage(error)}`);
    } finally {
      setProviderBusy("agent-delete", false);
    }
  }

  async function saveEmbeddingProvider() {
    if (embeddingLockedByIndexing) {
      setEmbeddingStatusLine("当前有向量索引任务正在进行。请等待完成或取消后，再保存 Embedding 配置。");
      return;
    }
    setProviderBusy("embedding-save", true);
    try {
      const result = await window.brevyn.providers.save({ ...embeddingDraft, purpose: "embedding", protocol: "openai_compatible" });
      const saved = result.provider;
      const next = await window.brevyn.providers.list();
      await loadEmbeddingMutable();
      setProviders(next);
      setCreatingEmbeddingProvider(false);
      setSelectedEmbeddingProviderId(saved.id);
      setEmbeddingDraft((current) => ({
        ...current,
        id: saved.id,
        purpose: saved.purpose,
        providerKind: saved.providerKind,
        name: saved.name,
        protocol: saved.protocol,
        authMode: saved.authMode,
        baseUrl: saved.baseUrl,
        models: saved.models.map((model) => ({ ...model })),
        selectedModel: saved.selectedModel,
        enabled: saved.enabled,
      }));
      await handleEmbeddingIndexNotice("向量服务商已保存。");
    } catch (error) {
      setEmbeddingStatusLine(`保存向量服务商失败：${errorMessage(error)}`);
    } finally {
      setProviderBusy("embedding-save", false);
    }
  }

  async function deleteEmbeddingProvider(provider: ModelProviderConfig) {
    if (embeddingLockedByIndexing) {
      setEmbeddingStatusLine("当前有向量索引任务正在进行。请等待完成或取消后，再删除 Embedding 配置。");
      return;
    }
    const ok = await confirmProviderAction({
      title: `删除向量服务商配置“${provider.name}”？`,
      message: "这会删除已保存的配置和本地元数据。",
      confirmLabel: "删除",
      cancelLabel: "取消",
      tone: "danger",
    });
    if (!ok) return;
    setProviderBusy("embedding-delete", true);
    try {
      await window.brevyn.providers.delete(provider.id);
      const next = await window.brevyn.providers.list();
      setProviders(next);
      closeEmbeddingEditor();
      setEmbeddingStatusLine(`已删除向量服务商配置“${provider.name}”。`);
      await loadEmbeddingIndexHealth();
    } catch (error) {
      setEmbeddingStatusLine(`删除向量服务商失败：${errorMessage(error)}`);
    } finally {
      setProviderBusy("embedding-delete", false);
    }
  }

  async function toggleProvider(provider: ModelProviderConfig) {
    setProviderBusy("agent-toggle", true);
    try {
      const result = await window.brevyn.providers.save(toProviderDraft(provider, { enabled: !provider.enabled }));
      const saved = result.provider;
      const next = await window.brevyn.providers.list();
      setProviders(next);
      if (provider.id === selectedProviderId) selectProvider(saved);
    } catch (error) {
      setStatusLine(errorMessage(error));
    } finally {
      setProviderBusy("agent-toggle", false);
    }
  }

  async function toggleEmbeddingProvider(provider: ModelProviderConfig) {
    if (embeddingLockedByIndexing) {
      setEmbeddingStatusLine("当前有向量索引任务正在进行。请等待完成或取消后，再启用或关闭 Embedding 配置。");
      return;
    }
    setProviderBusy("embedding-toggle", true);
    try {
      const result = await window.brevyn.providers.save(toProviderDraft(provider, { enabled: !provider.enabled }));
      const saved = result.provider;
      const next = await window.brevyn.providers.list();
      setProviders(next);
      if (provider.id === selectedEmbeddingProviderId) selectEmbeddingProvider(saved);
      await handleEmbeddingIndexNotice(`已更新向量服务商“${saved.name}”。`);
    } catch (error) {
      setEmbeddingStatusLine(errorMessage(error));
    } finally {
      setProviderBusy("embedding-toggle", false);
    }
  }

  async function toggleVisionProvider(provider: ModelProviderConfig) {
    setProviderBusy("vision-toggle", true);
    try {
      const result = await window.brevyn.providers.save(toProviderDraft(provider, { enabled: !provider.enabled }));
      const saved = result.provider;
      const next = await window.brevyn.providers.list();
      setProviders(next);
      if (provider.id === selectedVisionProviderId) selectVisionProvider(saved);
      setVisionStatusLine(`已更新视觉服务商“${saved.name}”。`);
    } catch (error) {
      setVisionStatusLine(errorMessage(error));
    } finally {
      setProviderBusy("vision-toggle", false);
    }
  }

  async function toggleOcrProvider(provider: ModelProviderConfig) {
    setProviderBusy("ocr-toggle", true);
    try {
      const result = await window.brevyn.providers.save(toProviderDraft(provider, { enabled: !provider.enabled }));
      const saved = result.provider;
      const next = await window.brevyn.providers.list();
      setProviders(next);
      if (provider.id === selectedOcrProviderId) selectOcrProvider(saved);
      setOcrStatusLine(`已更新 OCR 服务商“${saved.name}”。`);
    } catch (error) {
      setOcrStatusLine(errorMessage(error));
    } finally {
      setProviderBusy("ocr-toggle", false);
    }
  }

  async function fetchModels() {
    if (!draft.baseUrl.trim() || !draft.apiKey.trim()) {
      setStatusLine("获取模型前需要填写 Base URL 和 API Key。");
      return;
    }
    const requestId = ++agentModelsFetchRequestRef.current;
    const target = providerDraftFetchTarget(draft);
    setProviderBusy("agent-fetch", true);
    try {
      const fetchedModels = await window.brevyn.providers.models(draft);
      if (agentModelsFetchRequestRef.current !== requestId || !isSameProviderDraftFetchTarget(draftRef.current, target)) return;
      setModels(fetchedModels);
      setDraft((current) => mergeFetchedDraftModels(current, fetchedModels));
      setStatusLine("已获取可用模型。");
    } catch (error) {
      if (agentModelsFetchRequestRef.current !== requestId || !isSameProviderDraftFetchTarget(draftRef.current, target)) return;
      setStatusLine(`获取聊天模型失败：${providerFetchErrorMessage(error)}`);
    } finally {
      if (agentModelsFetchRequestRef.current === requestId) setProviderBusy("agent-fetch", false);
    }
  }

  async function fetchEmbeddingModels() {
    if (!embeddingDraft.baseUrl.trim() || !embeddingDraft.apiKey.trim()) {
      setEmbeddingStatusLine("获取模型前需要填写 Base URL 和 API Key。");
      return;
    }
    const requestId = ++embeddingModelsFetchRequestRef.current;
    const target = providerDraftFetchTarget(embeddingDraft);
    setProviderBusy("embedding-fetch", true);
    try {
      const fetchedModels = await window.brevyn.providers.models(embeddingDraft);
      if (embeddingModelsFetchRequestRef.current !== requestId || !isSameProviderDraftFetchTarget(embeddingDraftRef.current, target)) return;
      setEmbeddingDraft((current) => ({
        ...current,
        models: fetchedModels,
        selectedModel: selectedEnabledModel(current.selectedModel, fetchedModels),
      }));
      setEmbeddingStatusLine("已获取向量模型。");
    } catch (error) {
      if (embeddingModelsFetchRequestRef.current !== requestId || !isSameProviderDraftFetchTarget(embeddingDraftRef.current, target)) return;
      setEmbeddingStatusLine(`获取向量模型失败：${errorMessage(error)}`);
    } finally {
      if (embeddingModelsFetchRequestRef.current === requestId) setProviderBusy("embedding-fetch", false);
    }
  }

  async function fetchVisionModels() {
    if (!visionDraft.baseUrl.trim() || !visionDraft.apiKey.trim()) {
      setVisionStatusLine("获取模型前需要填写 Base URL 和 API Key。");
      return;
    }
    const requestId = ++visionModelsFetchRequestRef.current;
    const target = providerDraftFetchTarget(visionDraft);
    setProviderBusy("vision-fetch", true);
    try {
      const fetchedModels = await window.brevyn.providers.models(visionDraft);
      if (visionModelsFetchRequestRef.current !== requestId || !isSameProviderDraftFetchTarget(visionDraftRef.current, target)) return;
      setVisionModels(fetchedModels);
      setVisionDraft((current) => mergeFetchedDraftModels(current, fetchedModels));
      setVisionStatusLine("已获取视觉模型。");
    } catch (error) {
      if (visionModelsFetchRequestRef.current !== requestId || !isSameProviderDraftFetchTarget(visionDraftRef.current, target)) return;
      setVisionModels([]);
      setVisionStatusLine(`获取视觉模型失败：${providerFetchErrorMessage(error)}`);
    } finally {
      if (visionModelsFetchRequestRef.current === requestId) setProviderBusy("vision-fetch", false);
    }
  }

  async function fetchOcrModels() {
    if (!ocrDraft.baseUrl.trim() || !ocrDraft.apiKey.trim()) {
      setOcrStatusLine("获取模型前需要填写 Base URL 和 API Key。");
      return;
    }
    const requestId = ++ocrModelsFetchRequestRef.current;
    const target = providerDraftFetchTarget(ocrDraft);
    setProviderBusy("ocr-fetch", true);
    try {
      const fetchedModels = await window.brevyn.providers.models(ocrDraft);
      if (ocrModelsFetchRequestRef.current !== requestId || !isSameProviderDraftFetchTarget(ocrDraftRef.current, target)) return;
      setOcrModels(fetchedModels);
      setOcrDraft((current) => mergeFetchedDraftModels(current, fetchedModels));
      setOcrStatusLine("已获取 OCR 模型。");
    } catch (error) {
      if (ocrModelsFetchRequestRef.current !== requestId || !isSameProviderDraftFetchTarget(ocrDraftRef.current, target)) return;
      setOcrModels([]);
      setOcrStatusLine(`获取 OCR 模型失败：${providerFetchErrorMessage(error)}`);
    } finally {
      if (ocrModelsFetchRequestRef.current === requestId) setProviderBusy("ocr-fetch", false);
    }
  }

  async function testProvider() {
    setProviderBusy("agent-test", true);
    try {
      const result = await window.brevyn.providers.test(draft);
      setStatusLine(result.ok ? `已连接 · ${result.latencyMs}ms · ${result.message}` : `失败 · ${result.message}`);
    } catch (error) {
      setStatusLine(errorMessage(error));
    } finally {
      setProviderBusy("agent-test", false);
    }
  }

  async function testEmbeddingProvider() {
    setProviderBusy("embedding-test", true);
    try {
      const result = await window.brevyn.providers.test(embeddingDraft);
      setEmbeddingStatusLine(result.ok ? `已连接 · ${result.latencyMs}ms · ${result.message}` : `失败 · ${result.message}`);
    } catch (error) {
      setEmbeddingStatusLine(errorMessage(error));
    } finally {
      setProviderBusy("embedding-test", false);
    }
  }

  async function testVisionProvider() {
    setProviderBusy("vision-test", true);
    try {
      const result = await window.brevyn.providers.test(visionDraft);
      setVisionStatusLine(result.ok ? `已连接 · ${result.latencyMs}ms · ${result.message}` : `失败 · ${result.message}`);
    } catch (error) {
      setVisionStatusLine(errorMessage(error));
    } finally {
      setProviderBusy("vision-test", false);
    }
  }

  async function testOcrProvider() {
    setProviderBusy("ocr-test", true);
    try {
      const result = await window.brevyn.providers.test(ocrDraft);
      setOcrStatusLine(result.ok ? `已连接 · ${result.latencyMs}ms · ${result.message}` : `失败 · ${result.message}`);
    } catch (error) {
      setOcrStatusLine(errorMessage(error));
    } finally {
      setProviderBusy("ocr-test", false);
    }
  }

  async function saveVisionProvider() {
    setProviderBusy("vision-save", true);
    try {
      const result = await window.brevyn.providers.save({ ...visionDraft, purpose: "vision" });
      const saved = result.provider;
      const next = await window.brevyn.providers.list();
      setProviders(next);
      setCreatingVisionProvider(false);
      setSelectedVisionProviderId(saved.id);
      setVisionDraft((current) => ({
        ...current,
        id: saved.id,
        purpose: saved.purpose,
        providerKind: saved.providerKind,
        name: saved.name,
        protocol: saved.protocol,
        authMode: saved.authMode,
        baseUrl: saved.baseUrl,
        models: saved.models.map((model) => ({ ...model })),
        selectedModel: saved.selectedModel,
        enabled: saved.enabled,
      }));
      setVisionStatusLine("");
      showProviderToast("视觉服务商已保存。");
    } catch (error) {
      setVisionStatusLine(`保存视觉服务商失败：${errorMessage(error)}`);
    } finally {
      setProviderBusy("vision-save", false);
    }
  }

  async function deleteVisionProvider(provider: ModelProviderConfig) {
    const ok = await confirmProviderAction({
      title: `删除视觉服务商配置“${provider.name}”？`,
      message: "这会删除已保存的配置和本地元数据。",
      confirmLabel: "删除",
      cancelLabel: "取消",
      tone: "danger",
    });
    if (!ok) return;
    setProviderBusy("vision-delete", true);
    try {
      await window.brevyn.providers.delete(provider.id);
      const next = await window.brevyn.providers.list();
      setProviders(next);
      closeVisionEditor();
      setVisionStatusLine(`已删除视觉服务商配置“${provider.name}”。`);
    } catch (error) {
      setVisionStatusLine(`删除视觉服务商失败：${errorMessage(error)}`);
    } finally {
      setProviderBusy("vision-delete", false);
    }
  }

  async function saveOcrProvider() {
    setProviderBusy("ocr-save", true);
    try {
      const result = await window.brevyn.providers.save({ ...ocrDraft, purpose: "ocr" });
      const saved = result.provider;
      const next = await window.brevyn.providers.list();
      setProviders(next);
      setCreatingOcrProvider(false);
      setSelectedOcrProviderId(saved.id);
      setOcrDraft((current) => ({
        ...current,
        id: saved.id,
        purpose: saved.purpose,
        providerKind: saved.providerKind,
        name: saved.name,
        protocol: saved.protocol,
        authMode: saved.authMode,
        baseUrl: saved.baseUrl,
        models: saved.models.map((model) => ({ ...model })),
        selectedModel: saved.selectedModel,
        enabled: saved.enabled,
      }));
      setOcrStatusLine("");
      showProviderToast("OCR 服务商已保存。");
    } catch (error) {
      setOcrStatusLine(`保存 OCR 服务商失败：${errorMessage(error)}`);
    } finally {
      setProviderBusy("ocr-save", false);
    }
  }

  async function deleteOcrProvider(provider: ModelProviderConfig) {
    const ok = await confirmProviderAction({
      title: `删除 OCR 服务商配置“${provider.name}”？`,
      message: "这会删除已保存的配置和本地元数据。",
      confirmLabel: "删除",
      cancelLabel: "取消",
      tone: "danger",
    });
    if (!ok) return;
    setProviderBusy("ocr-delete", true);
    try {
      await window.brevyn.providers.delete(provider.id);
      const next = await window.brevyn.providers.list();
      setProviders(next);
      closeOcrEditor();
      setOcrStatusLine(`已删除 OCR 服务商配置“${provider.name}”。`);
    } catch (error) {
      setOcrStatusLine(`删除 OCR 服务商失败：${errorMessage(error)}`);
    } finally {
      setProviderBusy("ocr-delete", false);
    }
  }

  const providerPageProps: ComponentProps<typeof ProviderSettingsPage> = {
    providers,
    selectedProviderId,
    selectedEmbeddingProviderId,
    selectedVisionProviderId,
    selectedOcrProviderId,
    creatingProvider,
    creatingEmbeddingProvider,
    creatingVisionProvider,
    creatingOcrProvider,
    draft,
    embeddingDraft,
    visionDraft,
    ocrDraft,
    models,
    visionModels,
    ocrModels,
    statusLine,
    embeddingStatusLine,
    visionStatusLine,
    ocrStatusLine,
    embeddingReindexNotice,
    embeddingIndexHealth,
    embeddingLockedByIndexing,
    reindexingActiveSemester,
    busyActions: providerBusyActions,
    agentGatewayStatus,
    agentGatewayBusy,
    onSelectProvider: selectProvider,
    onSelectEmbeddingProvider: selectEmbeddingProvider,
    onSelectVisionProvider: selectVisionProvider,
    onSelectOcrProvider: selectOcrProvider,
    onNewProvider: newProvider,
    onNewEmbeddingProvider: newEmbeddingProvider,
    onNewVisionProvider: newVisionProvider,
    onNewOcrProvider: newOcrProvider,
    onCloseProviderEditor: closeProviderEditor,
    onCloseEmbeddingEditor: closeEmbeddingEditor,
    onCloseVisionEditor: closeVisionEditor,
    onCloseOcrEditor: closeOcrEditor,
    onToggleProvider: toggleProvider,
    onToggleEmbeddingProvider: toggleEmbeddingProvider,
    onToggleVisionProvider: toggleVisionProvider,
    onToggleOcrProvider: toggleOcrProvider,
    onDeleteProvider: (provider) => void deleteProvider(provider),
    onDeleteEmbeddingProvider: (provider) => void deleteEmbeddingProvider(provider),
    onDeleteVisionProvider: (provider) => void deleteVisionProvider(provider),
    onDeleteOcrProvider: (provider) => void deleteOcrProvider(provider),
    onDraftChange: setDraft,
    onEmbeddingDraftChange: setEmbeddingDraft,
    onVisionDraftChange: setVisionDraft,
    onOcrDraftChange: setOcrDraft,
    onFetchModels: fetchModels,
    onFetchEmbeddingModels: fetchEmbeddingModels,
    onFetchVisionModels: fetchVisionModels,
    onFetchOcrModels: fetchOcrModels,
    onTestProvider: testProvider,
    onTestEmbeddingProvider: testEmbeddingProvider,
    onTestVisionProvider: testVisionProvider,
    onTestOcrProvider: testOcrProvider,
    onSaveProvider: saveProvider,
    onSaveEmbeddingProvider: saveEmbeddingProvider,
    onSaveVisionProvider: saveVisionProvider,
    onSaveOcrProvider: saveOcrProvider,
    onReindexActiveSemester: () => void reindexActiveSemester(),
    onToggleOpenAiResponsesGateway: (enabled) => void setOpenAiResponsesGatewayEnabled(enabled),
  };

  return {
    providers,
    providerToast,
    providerConfirmDialog,
    providerPageProps,
    loadProviders,
    showProviderToast,
  };
}

function agentProviderSelectionValue(providerId: string, modelId: string): string {
  if (!providerId || !modelId) return "";
  return `${encodeURIComponent(providerId)}::${encodeURIComponent(modelId)}`;
}

function providerFetchErrorMessage(error: unknown): string {
  return errorMessage(error)
    .replace(/^Error invoking remote method '[^']+': Error:\s*/i, "")
    .replace(/^Failed to fetch agent models:\s*/i, "")
    .replace(/^Failed to fetch embedding models:\s*/i, "");
}
