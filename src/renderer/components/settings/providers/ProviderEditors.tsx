import { ArrowLeft, Database, Eye, KeyRound, PlugZap, Plus, RefreshCw, Save, ScanText, Trash2 } from "lucide-react";
import type { ReactNode } from "react";
import {
  ActionButton,
  Field,
  ReadOnlyField,
} from "@/components/settings/shared/SettingsControls";
import { cx } from "@/lib/cn";
import {
  DEFAULT_AUTO_COMPACT_THRESHOLD_PERCENT,
  type AgentProviderKind,
  type EmbeddingProviderKind,
  type ModelProviderConfig,
  type OcrProviderKind,
  type ProviderDraftInput,
  type ProviderKind,
  type ProviderModel,
  type VisionProviderKind,
} from "../../../../types/domain";
import { AgentModelManager, ModelPicker, ProviderKindField } from "./ProviderControls";

type AgentEditorBusyAction = "agent-fetch" | "agent-test" | "agent-save";
type EmbeddingEditorBusyAction = "embedding-fetch" | "embedding-test" | "embedding-save";
type VisionEditorBusyAction = "vision-fetch" | "vision-test" | "vision-save";
type OcrEditorBusyAction = "ocr-fetch" | "ocr-test" | "ocr-save";

export function AgentProviderEditor({
  runtimeBanner,
  creatingProvider,
  selectedProvider,
  selectedProviderId,
  draft,
  manualAgentModel,
  statusLine,
  agentBusy,
  isBusy,
  adapterLabel,
  onClose,
  onDeleteProvider,
  onDraftChange,
  onProviderKindChange,
  onManualAgentModelChange,
  onAddManualAgentModel,
  onToggleModel,
  onMakeDefaultModel,
  onUpdateModel,
  onRemoveModel,
  onFetchModels,
  onTestProvider,
  onSaveProvider,
}: {
  runtimeBanner: ReactNode;
  creatingProvider: boolean;
  selectedProvider: ModelProviderConfig | undefined;
  selectedProviderId: string;
  draft: ProviderDraftInput;
  manualAgentModel: string;
  statusLine: string;
  agentBusy: boolean;
  isBusy: (action: AgentEditorBusyAction) => boolean;
  adapterLabel: (providerKind: ProviderKind) => string;
  onClose: () => void;
  onDeleteProvider: (provider: ModelProviderConfig) => void;
  onDraftChange: (draft: ProviderDraftInput) => void;
  onProviderKindChange: (providerKind: AgentProviderKind) => void;
  onManualAgentModelChange: (value: string) => void;
  onAddManualAgentModel: () => void;
  onToggleModel: (model: ProviderModel) => void;
  onMakeDefaultModel: (model: ProviderModel) => void;
  onUpdateModel: (model: ProviderModel) => void;
  onRemoveModel: (model: ProviderModel) => void;
  onFetchModels: () => void;
  onTestProvider: () => void;
  onSaveProvider: () => void;
}) {
  return (
    <div className="space-y-4">
      {runtimeBanner}
      <section className="rounded-lg border bg-background/70 p-4">
        <div className="mb-4 flex items-start justify-between gap-3">
          <div className="min-w-0">
            <button
              type="button"
              className="mb-3 inline-flex h-8 items-center gap-1.5 rounded-md border bg-card px-2.5 text-xs text-muted-foreground transition hover:bg-accent hover:text-foreground"
              onClick={onClose}
              disabled={agentBusy}
            >
              <ArrowLeft className="h-3.5 w-3.5" />
              返回配置列表
            </button>
            <div className="flex items-center gap-2 text-sm font-semibold">
              <PlugZap className="h-4 w-4" />
              {creatingProvider ? "新建 Agent 配置" : `编辑 Agent 配置 · ${selectedProvider?.name || "未命名"}`}
            </div>
            <div className="mt-1 text-[11px] text-muted-foreground">用于聊天、多模态识别和工具调用回复。</div>
          </div>
          <div className="flex shrink-0 items-center gap-2">
            {selectedProvider && <ActionButton icon={<Trash2 className="h-3.5 w-3.5" />} label="删除" onClick={() => onDeleteProvider(selectedProvider)} disabled={agentBusy} />}
          </div>
        </div>

        {creatingProvider && (
          <div className="mb-4 rounded-md border border-dashed bg-muted/35 px-3 py-2 text-[11px] text-muted-foreground">
            这个 Agent 配置还没有保存。填写完成后保存，它会加入 Agent 列表。
          </div>
        )}

        <div className="grid gap-2 md:grid-cols-2">
          <Field label="配置名称" value={draft.name} onChange={(value) => onDraftChange({ ...draft, name: value })} />
          <ReadOnlyField label="用途" value="聊天" />
          <ProviderKindField purpose="agent" value={draft.providerKind as AgentProviderKind} onChange={(value) => onProviderKindChange(value as AgentProviderKind)} />
          <ReadOnlyField label="适配器" value={adapterLabel(draft.providerKind)} />
          <Field label="Base URL" value={draft.baseUrl} onChange={(value) => onDraftChange({ ...draft, baseUrl: value })} />
          <Field
            label="API Key"
            value={draft.apiKey}
            onChange={(value) => onDraftChange({ ...draft, apiKey: value, clearApiKey: false })}
            type="password"
            placeholder={selectedProviderId ? "留空则不更新" : "输入 API Key"}
            icon={<KeyRound className="h-3 w-3" />}
          />
          <ReadOnlyField label="默认模型" value={draft.selectedModel || "请在下方选择已启用模型"} />
          <Field
            label="自动压缩阈值 (%)"
            value={String(draft.autoCompactThresholdPercent ?? DEFAULT_AUTO_COMPACT_THRESHOLD_PERCENT)}
            onChange={(value) => {
              if (!value.trim()) {
                onDraftChange({ ...draft, autoCompactThresholdPercent: undefined });
                return;
              }
              const numeric = Number(value);
              if (Number.isFinite(numeric)) onDraftChange({ ...draft, autoCompactThresholdPercent: numeric });
            }}
            type="number"
            placeholder={String(DEFAULT_AUTO_COMPACT_THRESHOLD_PERCENT)}
          />
        </div>
        <div className="mt-2 text-[11px] leading-5 text-muted-foreground">
          每个模型上下文窗口不同，这里只设置百分比；默认按 Proma/SDK 经验在 77.5% 左右触发自动压缩。
        </div>

        <div className="mt-3 rounded-md border bg-card p-2">
          <div className="mb-2 px-1 text-[10px] font-semibold uppercase tracking-[0.14em] text-muted-foreground">手动添加模型</div>
          <div className="flex gap-2">
            <input
              className="h-8 min-w-0 flex-1 rounded-md border bg-background px-2 text-xs text-foreground outline-none placeholder:text-muted-foreground/55"
              value={manualAgentModel}
              placeholder="e.g. qwen-plus, claude-sonnet-4-6"
              onChange={(event) => onManualAgentModelChange(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter") {
                  event.preventDefault();
                  onAddManualAgentModel();
                }
              }}
            />
            <ActionButton icon={<Plus className="h-3.5 w-3.5" />} label="添加" onClick={onAddManualAgentModel} disabled={!manualAgentModel.trim()} />
          </div>
          <div className="mt-2 text-[11px] leading-5 text-muted-foreground">
            部分 Anthropic 兼容服务商，包括 DashScope app endpoint，不提供模型列表接口。
          </div>
        </div>

        {(draft.models?.length ?? 0) > 0 && (
          <AgentModelManager
            providerKind={draft.providerKind}
            baseUrl={draft.baseUrl}
            models={draft.models ?? []}
            selectedModel={draft.selectedModel}
            onToggle={onToggleModel}
            onMakeDefault={onMakeDefaultModel}
            onUpdateModel={onUpdateModel}
            onRemoveModel={onRemoveModel}
          />
        )}

        <div className="mt-4 flex flex-wrap gap-2">
          <ActionButton icon={<RefreshCw className={cx("h-3.5 w-3.5", isBusy("agent-fetch") && "animate-spin")} />} label="获取模型" onClick={onFetchModels} disabled={agentBusy} />
          <ActionButton icon={<PlugZap className={cx("h-3.5 w-3.5", isBusy("agent-test") && "animate-pulse")} />} label="测试" onClick={onTestProvider} disabled={agentBusy} />
          <ActionButton icon={<Save className={cx("h-3.5 w-3.5", isBusy("agent-save") && "animate-pulse")} />} label="保存" onClick={onSaveProvider} primary disabled={agentBusy} />
        </div>
        {statusLine && <div className="mt-3 rounded-md bg-muted/55 px-2 py-2 text-[11px] text-muted-foreground">{statusLine}</div>}
      </section>
    </div>
  );
}

export function EmbeddingProviderEditor({
  runtimeBanner,
  creatingEmbeddingProvider,
  selectedEmbeddingProvider,
  selectedEmbeddingProviderId,
  embeddingDraft,
  embeddingLockedByIndexing,
  embeddingStatusLine,
  embeddingBusy,
  isBusy,
  adapterLabel,
  onClose,
  onDeleteEmbeddingProvider,
  onEmbeddingDraftChange,
  onProviderKindChange,
  onFetchEmbeddingModels,
  onTestEmbeddingProvider,
  onSaveEmbeddingProvider,
}: {
  runtimeBanner: ReactNode;
  creatingEmbeddingProvider: boolean;
  selectedEmbeddingProvider: ModelProviderConfig | undefined;
  selectedEmbeddingProviderId: string;
  embeddingDraft: ProviderDraftInput;
  embeddingLockedByIndexing: boolean;
  embeddingStatusLine: string;
  embeddingBusy: boolean;
  isBusy: (action: EmbeddingEditorBusyAction) => boolean;
  adapterLabel: (providerKind: ProviderKind) => string;
  onClose: () => void;
  onDeleteEmbeddingProvider: (provider: ModelProviderConfig) => void;
  onEmbeddingDraftChange: (draft: ProviderDraftInput) => void;
  onProviderKindChange: (providerKind: EmbeddingProviderKind) => void;
  onFetchEmbeddingModels: () => void;
  onTestEmbeddingProvider: () => void;
  onSaveEmbeddingProvider: () => void;
}) {
  return (
    <div className="space-y-4">
      {runtimeBanner}
      <section className="rounded-lg border bg-background/70 p-4">
        <div className="mb-4 flex items-start justify-between gap-3">
          <div className="min-w-0">
            <button
              type="button"
              className="mb-3 inline-flex h-8 items-center gap-1.5 rounded-md border bg-card px-2.5 text-xs text-muted-foreground transition hover:bg-accent hover:text-foreground"
              onClick={onClose}
              disabled={embeddingBusy}
            >
              <ArrowLeft className="h-3.5 w-3.5" />
              返回配置列表
            </button>
            <div className="flex items-center gap-2 text-sm font-semibold">
              <Database className="h-4 w-4" />
              {creatingEmbeddingProvider ? "新建 Embedding 配置" : `编辑 Embedding 配置 · ${selectedEmbeddingProvider?.name || "未命名"}`}
            </div>
            <div className="mt-1 text-[11px] text-muted-foreground">用于 RAG 搜索、课程文件索引和上下文召回。</div>
          </div>
          <div className="flex shrink-0 items-center gap-2">
            {selectedEmbeddingProvider && <ActionButton icon={<Trash2 className="h-3.5 w-3.5" />} label="删除" onClick={() => onDeleteEmbeddingProvider(selectedEmbeddingProvider)} disabled={embeddingBusy} />}
          </div>
        </div>

        {creatingEmbeddingProvider && (
          <div className="mb-4 rounded-md border border-dashed bg-muted/35 px-3 py-2 text-[11px] text-muted-foreground">
            这个 Embedding 配置还没有保存。保存后会加入 Embedding 列表。
          </div>
        )}
        {embeddingLockedByIndexing && (
          <div className="mb-4 rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-[11px] leading-5 text-amber-900">
            当前有向量索引任务正在进行。完成或取消后，才可以切换、保存、删除 Embedding 配置，避免同一批课程资料混用不同向量模型。
          </div>
        )}

        <div className="grid gap-2 md:grid-cols-2">
          <Field label="配置名称" value={embeddingDraft.name} onChange={(value) => onEmbeddingDraftChange({ ...embeddingDraft, name: value })} disabled={embeddingLockedByIndexing} />
          <ReadOnlyField label="用途" value="向量" />
          <ProviderKindField purpose="embedding" value={embeddingDraft.providerKind as EmbeddingProviderKind} onChange={(value) => onProviderKindChange(value as EmbeddingProviderKind)} disabled={embeddingLockedByIndexing} />
          <ReadOnlyField label="适配器" value={adapterLabel(embeddingDraft.providerKind)} />
          <Field label="Base URL" value={embeddingDraft.baseUrl} onChange={(value) => onEmbeddingDraftChange({ ...embeddingDraft, baseUrl: value })} disabled={embeddingLockedByIndexing} />
          <Field
            label="API Key"
            value={embeddingDraft.apiKey}
            onChange={(value) => onEmbeddingDraftChange({ ...embeddingDraft, apiKey: value, clearApiKey: false })}
            type="password"
            placeholder={selectedEmbeddingProviderId ? "留空则不更新" : "输入 API Key"}
            icon={<KeyRound className="h-3 w-3" />}
            disabled={embeddingLockedByIndexing}
          />
          <Field label="模型" value={embeddingDraft.selectedModel} onChange={(value) => onEmbeddingDraftChange({ ...embeddingDraft, selectedModel: value })} disabled={embeddingLockedByIndexing} />
        </div>

        {(embeddingDraft.models?.length ?? 0) > 0 && (
          <ModelPicker
            providerKind={embeddingDraft.providerKind}
            baseUrl={embeddingDraft.baseUrl}
            selectedModel={embeddingDraft.selectedModel}
            models={embeddingDraft.models ?? []}
            onPick={(model) => onEmbeddingDraftChange({ ...embeddingDraft, selectedModel: model.id })}
            disabled={embeddingLockedByIndexing}
          />
        )}

        <div className="mt-4 flex flex-wrap gap-2">
          <ActionButton icon={<RefreshCw className={cx("h-3.5 w-3.5", isBusy("embedding-fetch") && "animate-spin")} />} label="获取模型" onClick={onFetchEmbeddingModels} disabled={embeddingBusy} />
          <ActionButton icon={<PlugZap className={cx("h-3.5 w-3.5", isBusy("embedding-test") && "animate-pulse")} />} label="测试" onClick={onTestEmbeddingProvider} disabled={embeddingBusy} />
          <ActionButton icon={<Save className={cx("h-3.5 w-3.5", isBusy("embedding-save") && "animate-pulse")} />} label="保存向量配置" onClick={onSaveEmbeddingProvider} primary disabled={embeddingBusy} />
        </div>
        {embeddingStatusLine && <div className="mt-3 rounded-md bg-muted/55 px-2 py-2 text-[11px] text-muted-foreground">{embeddingStatusLine}</div>}
      </section>
    </div>
  );
}

export function VisionProviderEditor({
  runtimeBanner,
  creatingVisionProvider,
  selectedVisionProvider,
  selectedVisionProviderId,
  visionDraft,
  manualVisionModel,
  visionStatusLine,
  visionBusy,
  isBusy,
  adapterLabel,
  onClose,
  onDeleteVisionProvider,
  onVisionDraftChange,
  onProviderKindChange,
  onManualVisionModelChange,
  onAddManualVisionModel,
  onToggleModel,
  onMakeDefaultModel,
  onUpdateModel,
  onRemoveModel,
  onFetchVisionModels,
  onTestVisionProvider,
  onSaveVisionProvider,
}: {
  runtimeBanner: ReactNode;
  creatingVisionProvider: boolean;
  selectedVisionProvider: ModelProviderConfig | undefined;
  selectedVisionProviderId: string;
  visionDraft: ProviderDraftInput;
  manualVisionModel: string;
  visionStatusLine: string;
  visionBusy: boolean;
  isBusy: (action: VisionEditorBusyAction) => boolean;
  adapterLabel: (providerKind: ProviderKind) => string;
  onClose: () => void;
  onDeleteVisionProvider: (provider: ModelProviderConfig) => void;
  onVisionDraftChange: (draft: ProviderDraftInput) => void;
  onProviderKindChange: (providerKind: VisionProviderKind) => void;
  onManualVisionModelChange: (value: string) => void;
  onAddManualVisionModel: () => void;
  onToggleModel: (model: ProviderModel) => void;
  onMakeDefaultModel: (model: ProviderModel) => void;
  onUpdateModel: (model: ProviderModel) => void;
  onRemoveModel: (model: ProviderModel) => void;
  onFetchVisionModels: () => void;
  onTestVisionProvider: () => void;
  onSaveVisionProvider: () => void;
}) {
  return (
    <div className="space-y-4">
      {runtimeBanner}
      <section className="rounded-lg border bg-background/70 p-4">
        <div className="mb-4 flex items-start justify-between gap-3">
          <div className="min-w-0">
            <button
              type="button"
              className="mb-3 inline-flex h-8 items-center gap-1.5 rounded-md border bg-card px-2.5 text-xs text-muted-foreground transition hover:bg-accent hover:text-foreground"
              onClick={onClose}
              disabled={visionBusy}
            >
              <ArrowLeft className="h-3.5 w-3.5" />
              返回配置列表
            </button>
            <div className="flex items-center gap-2 text-sm font-semibold">
              <Eye className="h-4 w-4" />
              {creatingVisionProvider ? "新建 Vision 配置" : `编辑 Vision 配置 · ${selectedVisionProvider?.name || "未命名"}`}
            </div>
            <div className="mt-1 text-[11px] text-muted-foreground">用于校历和课程表图片识别。</div>
          </div>
          <div className="flex shrink-0 items-center gap-2">
            {selectedVisionProvider && <ActionButton icon={<Trash2 className="h-3.5 w-3.5" />} label="删除" onClick={() => onDeleteVisionProvider(selectedVisionProvider)} disabled={visionBusy} />}
          </div>
        </div>

        {creatingVisionProvider && (
          <div className="mb-4 rounded-md border border-dashed bg-muted/35 px-3 py-2 text-[11px] text-muted-foreground">
            这个 Vision 配置还没有保存。保存后会加入 Vision 列表。
          </div>
        )}

        <div className="grid gap-2 md:grid-cols-2">
          <Field label="配置名称" value={visionDraft.name} onChange={(value) => onVisionDraftChange({ ...visionDraft, name: value })} />
          <ReadOnlyField label="用途" value="视觉" />
          <ProviderKindField purpose="vision" value={visionDraft.providerKind as VisionProviderKind} onChange={(value) => onProviderKindChange(value as VisionProviderKind)} />
          <ReadOnlyField label="适配器" value={adapterLabel(visionDraft.providerKind)} />
          <Field label="Base URL" value={visionDraft.baseUrl} onChange={(value) => onVisionDraftChange({ ...visionDraft, baseUrl: value })} />
          <Field
            label="API Key"
            value={visionDraft.apiKey}
            onChange={(value) => onVisionDraftChange({ ...visionDraft, apiKey: value, clearApiKey: false })}
            type="password"
            placeholder={selectedVisionProviderId ? "留空则不更新" : "输入 API Key"}
            icon={<KeyRound className="h-3 w-3" />}
          />
          <ReadOnlyField label="默认模型" value={visionDraft.selectedModel || "请在下方选择已启用模型"} />
        </div>

        <div className="mt-3 rounded-md border bg-card p-2">
          <div className="mb-2 px-1 text-[10px] font-semibold uppercase tracking-[0.14em] text-muted-foreground">手动添加模型</div>
          <div className="flex gap-2">
            <input
              className="h-8 min-w-0 flex-1 rounded-md border bg-background px-2 text-xs text-foreground outline-none placeholder:text-muted-foreground/55"
              value={manualVisionModel}
              placeholder="e.g. qwen-vl-plus, gpt-4.1-mini"
              onChange={(event) => onManualVisionModelChange(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter") {
                  event.preventDefault();
                  onAddManualVisionModel();
                }
              }}
            />
            <ActionButton icon={<Plus className="h-3.5 w-3.5" />} label="添加" onClick={onAddManualVisionModel} disabled={!manualVisionModel.trim()} />
          </div>
          <div className="mt-2 text-[11px] leading-5 text-muted-foreground">
            如果服务商不提供模型列表接口，可以手动添加视觉模型 ID。
          </div>
        </div>

        {(visionDraft.models?.length ?? 0) > 0 && (
          <AgentModelManager
            title="视觉模型"
            providerKind={visionDraft.providerKind}
            baseUrl={visionDraft.baseUrl}
            availableEmptyLabel="已获取的视觉模型都已启用。"
            enabledEmptyLabel="至少启用一个模型用于识别。"
            models={visionDraft.models ?? []}
            selectedModel={visionDraft.selectedModel}
            onToggle={onToggleModel}
            onMakeDefault={onMakeDefaultModel}
            onUpdateModel={onUpdateModel}
            onRemoveModel={onRemoveModel}
          />
        )}

        <div className="mt-4 flex flex-wrap gap-2">
          <ActionButton icon={<RefreshCw className={cx("h-3.5 w-3.5", isBusy("vision-fetch") && "animate-spin")} />} label="获取模型" onClick={onFetchVisionModels} disabled={visionBusy} />
          <ActionButton icon={<PlugZap className={cx("h-3.5 w-3.5", isBusy("vision-test") && "animate-pulse")} />} label="测试" onClick={onTestVisionProvider} disabled={visionBusy} />
          <ActionButton icon={<Save className={cx("h-3.5 w-3.5", isBusy("vision-save") && "animate-pulse")} />} label="保存视觉配置" onClick={onSaveVisionProvider} primary disabled={visionBusy} />
        </div>
        {visionStatusLine && <div className="mt-3 rounded-md bg-muted/55 px-2 py-2 text-[11px] text-muted-foreground">{visionStatusLine}</div>}
      </section>
    </div>
  );
}

export function OcrProviderEditor({
  runtimeBanner,
  creatingOcrProvider,
  selectedOcrProvider,
  selectedOcrProviderId,
  ocrDraft,
  manualOcrModel,
  ocrStatusLine,
  ocrBusy,
  isBusy,
  adapterLabel,
  onClose,
  onDeleteOcrProvider,
  onOcrDraftChange,
  onProviderKindChange,
  onManualOcrModelChange,
  onAddManualOcrModel,
  onToggleModel,
  onMakeDefaultModel,
  onUpdateModel,
  onRemoveModel,
  onFetchOcrModels,
  onTestOcrProvider,
  onSaveOcrProvider,
}: {
  runtimeBanner: ReactNode;
  creatingOcrProvider: boolean;
  selectedOcrProvider: ModelProviderConfig | undefined;
  selectedOcrProviderId: string;
  ocrDraft: ProviderDraftInput;
  ocrModels: ProviderModel[];
  manualOcrModel: string;
  ocrStatusLine: string;
  ocrBusy: boolean;
  isBusy: (action: OcrEditorBusyAction) => boolean;
  adapterLabel: (providerKind: ProviderKind) => string;
  onClose: () => void;
  onDeleteOcrProvider: (provider: ModelProviderConfig) => void;
  onOcrDraftChange: (draft: ProviderDraftInput) => void;
  onProviderKindChange: (providerKind: OcrProviderKind) => void;
  onManualOcrModelChange: (value: string) => void;
  onAddManualOcrModel: () => void;
  onToggleModel: (model: ProviderModel) => void;
  onMakeDefaultModel: (model: ProviderModel) => void;
  onUpdateModel: (model: ProviderModel) => void;
  onRemoveModel: (model: ProviderModel) => void;
  onFetchOcrModels: () => void;
  onTestOcrProvider: () => void;
  onSaveOcrProvider: () => void;
}) {
  return (
    <div className="space-y-4">
      {runtimeBanner}
      <section className="rounded-lg border bg-background/70 p-4">
        <div className="mb-4 flex items-start justify-between gap-3">
          <div className="min-w-0">
            <button
              type="button"
              className="mb-3 inline-flex h-8 items-center gap-1.5 rounded-md border bg-card px-2.5 text-xs text-muted-foreground transition hover:bg-accent hover:text-foreground"
              onClick={onClose}
              disabled={ocrBusy}
            >
              <ArrowLeft className="h-3.5 w-3.5" />
              返回配置列表
            </button>
            <div className="flex items-center gap-2 text-sm font-semibold">
              <ScanText className="h-4 w-4" />
              {creatingOcrProvider ? "新建 OCR 配置" : `编辑 OCR 配置 · ${selectedOcrProvider?.name || "未命名"}`}
            </div>
            <div className="mt-1 text-[11px] text-muted-foreground">用于课程文件索引前的扫描件、图片页和低文本覆盖补识别。</div>
          </div>
          <div className="flex shrink-0 items-center gap-2">
            {selectedOcrProvider && <ActionButton icon={<Trash2 className="h-3.5 w-3.5" />} label="删除" onClick={() => onDeleteOcrProvider(selectedOcrProvider)} disabled={ocrBusy} />}
          </div>
        </div>

        {creatingOcrProvider && (
          <div className="mb-4 rounded-md border border-dashed bg-muted/35 px-3 py-2 text-[11px] text-muted-foreground">
            这个 OCR 配置还没有保存。保存后会加入 OCR 列表。
          </div>
        )}

        <div className="grid gap-2 md:grid-cols-2">
          <Field label="配置名称" value={ocrDraft.name} onChange={(value) => onOcrDraftChange({ ...ocrDraft, name: value })} />
          <ReadOnlyField label="用途" value="文档 OCR" />
          <ProviderKindField purpose="ocr" value={ocrDraft.providerKind as OcrProviderKind} onChange={(value) => onProviderKindChange(value as OcrProviderKind)} />
          <ReadOnlyField label="适配器" value={adapterLabel(ocrDraft.providerKind)} />
          <Field label="Base URL" value={ocrDraft.baseUrl} onChange={(value) => onOcrDraftChange({ ...ocrDraft, baseUrl: value })} />
          <Field
            label="API Key"
            value={ocrDraft.apiKey}
            onChange={(value) => onOcrDraftChange({ ...ocrDraft, apiKey: value, clearApiKey: false })}
            type="password"
            placeholder={selectedOcrProviderId ? "留空则不更新" : "输入 API Key"}
            icon={<KeyRound className="h-3 w-3" />}
          />
          <ReadOnlyField label="默认模型" value={ocrDraft.selectedModel || "请在下方选择已启用模型"} />
        </div>

        <div className="mt-3 rounded-md border bg-card p-2">
          <div className="mb-2 px-1 text-[10px] font-semibold uppercase tracking-[0.14em] text-muted-foreground">手动添加模型</div>
          <div className="flex gap-2">
            <input
              className="h-8 min-w-0 flex-1 rounded-md border bg-background px-2 text-xs text-foreground outline-none placeholder:text-muted-foreground/55"
              value={manualOcrModel}
              placeholder="e.g. DeepSeek-OCR, PaddleOCR-VL, Qwen3-VL-30B"
              onChange={(event) => onManualOcrModelChange(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter") {
                  event.preventDefault();
                  onAddManualOcrModel();
                }
              }}
            />
            <ActionButton icon={<Plus className="h-3.5 w-3.5" />} label="添加" onClick={onAddManualOcrModel} disabled={!manualOcrModel.trim()} />
          </div>
          <div className="mt-2 text-[11px] leading-5 text-muted-foreground">
            OpenAI-compatible OCR 适合图片和轻量扫描页；MinerU 文档解析会作为独立 OCR adapter 接入。
          </div>
        </div>

        {(ocrDraft.models?.length ?? 0) > 0 && (
          <AgentModelManager
            title="OCR 模型"
            providerKind={ocrDraft.providerKind}
            baseUrl={ocrDraft.baseUrl}
            availableEmptyLabel="已获取的 OCR 模型都已启用。"
            enabledEmptyLabel="至少启用一个模型用于 OCR。"
            models={ocrDraft.models ?? []}
            selectedModel={ocrDraft.selectedModel}
            onToggle={onToggleModel}
            onMakeDefault={onMakeDefaultModel}
            onUpdateModel={onUpdateModel}
            onRemoveModel={onRemoveModel}
          />
        )}

        <div className="mt-4 flex flex-wrap gap-2">
          <ActionButton icon={<RefreshCw className={cx("h-3.5 w-3.5", isBusy("ocr-fetch") && "animate-spin")} />} label="获取模型" onClick={onFetchOcrModels} disabled={ocrBusy} />
          <ActionButton icon={<PlugZap className={cx("h-3.5 w-3.5", isBusy("ocr-test") && "animate-pulse")} />} label="测试" onClick={onTestOcrProvider} disabled={ocrBusy} />
          <ActionButton icon={<Save className={cx("h-3.5 w-3.5", isBusy("ocr-save") && "animate-pulse")} />} label="保存 OCR 配置" onClick={onSaveOcrProvider} primary disabled={ocrBusy} />
        </div>
        {ocrStatusLine && <div className="mt-3 rounded-md bg-muted/55 px-2 py-2 text-[11px] text-muted-foreground">{ocrStatusLine}</div>}
      </section>
    </div>
  );
}
