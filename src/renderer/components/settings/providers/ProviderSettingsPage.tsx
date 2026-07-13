import { BookOpen, CalendarDays, Database, Eye, PlugZap, Plus, RefreshCw, ScanText } from "lucide-react";
import { useState } from "react";
import { ActionButton, IconActionButton } from "@/components/settings/shared/SettingsControls";
import { errorMessage } from "@/components/settings/shared/settingsErrors";
import { cx } from "@/lib/cn";
import type { AgentGatewayStatus, EmbeddingIndexHealth, ModelProviderConfig, ProviderDraftInput, ProviderModel, ProviderPurpose, RecognizedAcademicCalendar, RecognizedCourseTimetable } from "../../../../types/domain";
import { PROVIDER_PROFILE_LIST_HEIGHT_CLASS } from "./providerUtils";
import { ProviderProfileRow } from "./ProviderControls";
import { AgentProviderEditor, EmbeddingProviderEditor, OcrProviderEditor, VisionProviderEditor } from "./ProviderEditors";
import { AgentGatewayAdvancedPanel, VisionTestResultPanel } from "./ProviderPanels";
import { adapterLabel, addDraftModel, applyProviderPreset, hasRunnableVisionProvider, removeDraftModel, toggleDraftModel, updateDraftModel } from "./providerDraftUtils";

export type ProviderBusyAction =
  | "agent-save"
  | "agent-delete"
  | "agent-toggle"
  | "agent-fetch"
  | "agent-test"
  | "embedding-save"
  | "embedding-delete"
  | "embedding-toggle"
  | "embedding-fetch"
  | "embedding-test"
  | "vision-save"
  | "vision-delete"
  | "vision-toggle"
  | "vision-fetch"
  | "vision-test"
  | "ocr-save"
  | "ocr-delete"
  | "ocr-toggle"
  | "ocr-fetch"
  | "ocr-test";

type VisionTestKind = "calendar" | "timetable";
type VisionTestResult = RecognizedAcademicCalendar | RecognizedCourseTimetable;

export function ProviderSettingsPage({
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
  busyActions,
  agentGatewayStatus,
  agentGatewayBusy,
  onSelectProvider,
  onSelectEmbeddingProvider,
  onSelectVisionProvider,
  onSelectOcrProvider,
  onNewProvider,
  onNewEmbeddingProvider,
  onNewVisionProvider,
  onNewOcrProvider,
  onCloseProviderEditor,
  onCloseEmbeddingEditor,
  onCloseVisionEditor,
  onCloseOcrEditor,
  onToggleProvider,
  onToggleEmbeddingProvider,
  onToggleVisionProvider,
  onToggleOcrProvider,
  onDeleteProvider,
  onDeleteEmbeddingProvider,
  onDeleteVisionProvider,
  onDeleteOcrProvider,
  onDraftChange,
  onEmbeddingDraftChange,
  onVisionDraftChange,
  onOcrDraftChange,
  onFetchModels,
  onFetchEmbeddingModels,
  onFetchVisionModels,
  onFetchOcrModels,
  onTestProvider,
  onTestEmbeddingProvider,
  onTestVisionProvider,
  onTestOcrProvider,
  onSaveProvider,
  onSaveEmbeddingProvider,
  onSaveVisionProvider,
  onSaveOcrProvider,
  onReindexActiveSemester,
  onToggleOpenAiResponsesGateway,
}: {
  providers: ModelProviderConfig[];
  selectedProviderId: string;
  selectedEmbeddingProviderId: string;
  selectedVisionProviderId: string;
  selectedOcrProviderId: string;
  creatingProvider: boolean;
  creatingEmbeddingProvider: boolean;
  creatingVisionProvider: boolean;
  creatingOcrProvider: boolean;
  draft: ProviderDraftInput;
  embeddingDraft: ProviderDraftInput;
  visionDraft: ProviderDraftInput;
  ocrDraft: ProviderDraftInput;
  models: ProviderModel[];
  visionModels: ProviderModel[];
  ocrModels: ProviderModel[];
  statusLine: string;
  embeddingStatusLine: string;
  visionStatusLine: string;
  ocrStatusLine: string;
  embeddingReindexNotice: string;
  embeddingIndexHealth: EmbeddingIndexHealth | null;
  embeddingLockedByIndexing: boolean;
  reindexingActiveSemester: boolean;
  busyActions: Partial<Record<ProviderBusyAction, boolean>>;
  agentGatewayStatus: AgentGatewayStatus | null;
  agentGatewayBusy: boolean;
  onSelectProvider: (provider: ModelProviderConfig) => void;
  onSelectEmbeddingProvider: (provider: ModelProviderConfig) => void;
  onSelectVisionProvider: (provider: ModelProviderConfig) => void;
  onSelectOcrProvider: (provider: ModelProviderConfig) => void;
  onNewProvider: () => void;
  onNewEmbeddingProvider: () => void;
  onNewVisionProvider: () => void;
  onNewOcrProvider: () => void;
  onCloseProviderEditor: () => void;
  onCloseEmbeddingEditor: () => void;
  onCloseVisionEditor: () => void;
  onCloseOcrEditor: () => void;
  onToggleProvider: (provider: ModelProviderConfig) => void;
  onToggleEmbeddingProvider: (provider: ModelProviderConfig) => void;
  onToggleVisionProvider: (provider: ModelProviderConfig) => void;
  onToggleOcrProvider: (provider: ModelProviderConfig) => void;
  onDeleteProvider: (provider: ModelProviderConfig) => void;
  onDeleteEmbeddingProvider: (provider: ModelProviderConfig) => void;
  onDeleteVisionProvider: (provider: ModelProviderConfig) => void;
  onDeleteOcrProvider: (provider: ModelProviderConfig) => void;
  onDraftChange: (draft: ProviderDraftInput) => void;
  onEmbeddingDraftChange: (draft: ProviderDraftInput) => void;
  onVisionDraftChange: (draft: ProviderDraftInput) => void;
  onOcrDraftChange: (draft: ProviderDraftInput) => void;
  onFetchModels: () => void;
  onFetchEmbeddingModels: () => void;
  onFetchVisionModels: () => void;
  onFetchOcrModels: () => void;
  onTestProvider: () => void;
  onTestEmbeddingProvider: () => void;
  onTestVisionProvider: () => void;
  onTestOcrProvider: () => void;
  onSaveProvider: () => void;
  onSaveEmbeddingProvider: () => void;
  onSaveVisionProvider: () => void;
  onSaveOcrProvider: () => void;
  onReindexActiveSemester: () => void;
  onToggleOpenAiResponsesGateway: (enabled: boolean) => void;
}) {
  const selectedProvider = providers.find((provider) => provider.id === selectedProviderId);
  const selectedEmbeddingProvider = providers.find((provider) => provider.id === selectedEmbeddingProviderId);
  const selectedVisionProvider = providers.find((provider) => provider.id === selectedVisionProviderId);
  const selectedOcrProvider = providers.find((provider) => provider.id === selectedOcrProviderId);
  const agentProviders = providers.filter((provider) => provider.purpose === "agent");
  const embeddingProviders = providers.filter((provider) => provider.purpose === "embedding");
  const visionProviders = providers.filter((provider) => provider.purpose === "vision");
  const ocrProviders = providers.filter((provider) => provider.purpose === "ocr");
  const providerEditorOpen = creatingProvider || Boolean(selectedProvider);
  const embeddingEditorOpen = creatingEmbeddingProvider || Boolean(selectedEmbeddingProvider);
  const visionEditorOpen = creatingVisionProvider || Boolean(selectedVisionProvider);
  const ocrEditorOpen = creatingOcrProvider || Boolean(selectedOcrProvider);
  const runtimeBanner = null;
  const isBusy = (action: ProviderBusyAction) => Boolean(busyActions[action]);
  const isPurposeBlockingBusy = (purpose: ProviderPurpose) => {
    const prefix = purpose === "agent" ? "agent" : purpose === "vision" ? "vision" : purpose === "ocr" ? "ocr" : "embedding";
    return Object.entries(busyActions).some(([action, busy]) => Boolean(busy) && action.startsWith(`${prefix}-`) && action !== `${prefix}-toggle`);
  };
  const agentBusy = isPurposeBlockingBusy("agent");
  const embeddingBusy = isPurposeBlockingBusy("embedding") || embeddingLockedByIndexing;
  const visionBusy = isPurposeBlockingBusy("vision");
  const ocrBusy = isPurposeBlockingBusy("ocr");
  const agentToggleBusy = isBusy("agent-toggle");
  const embeddingToggleBusy = isBusy("embedding-toggle");
  const visionToggleBusy = isBusy("vision-toggle");
  const ocrToggleBusy = isBusy("ocr-toggle");
  const [visionTestBusy, setVisionTestBusy] = useState<VisionTestKind | null>(null);
  const [visionTestResult, setVisionTestResult] = useState<VisionTestResult | null>(null);
  const [visionTestError, setVisionTestError] = useState("");
  const showEmbeddingIndexNotice = Boolean(
    embeddingReindexNotice ||
    (embeddingIndexHealth && embeddingIndexHealth.totalFiles > 0 && embeddingIndexHealth.state !== "ready"),
  );
  const [manualAgentModel, setManualAgentModel] = useState("");
  const [manualVisionModel, setManualVisionModel] = useState("");
  const [manualOcrModel, setManualOcrModel] = useState("");

  function addManualAgentModel() {
    const modelId = manualAgentModel.trim();
    if (!modelId) return;
    onDraftChange(addDraftModel(draft, modelId));
    setManualAgentModel("");
  }

  function addManualVisionModel() {
    const modelId = manualVisionModel.trim();
    if (!modelId) return;
    onVisionDraftChange(addDraftModel(visionDraft, modelId));
    setManualVisionModel("");
  }

  function addManualOcrModel() {
    const modelId = manualOcrModel.trim();
    if (!modelId) return;
    onOcrDraftChange(addDraftModel(ocrDraft, modelId));
    setManualOcrModel("");
  }

  async function runVisionTest(kind: VisionTestKind) {
    setVisionTestBusy(kind);
    setVisionTestError("");
    setVisionTestResult(null);
    try {
      const sourcePath = await window.brevyn.vision.pickImage();
      if (!sourcePath) return;
      const result = kind === "calendar"
        ? await window.brevyn.vision.recognizeAcademicCalendar({ sourcePath, apply: false })
        : await window.brevyn.vision.recognizeCourseTimetable({ sourcePath, apply: false });
      setVisionTestResult(result);
    } catch (error) {
      setVisionTestError(errorMessage(error, "视觉识别失败。"));
    } finally {
      setVisionTestBusy(null);
    }
  }

  if (providerEditorOpen) {
    return (
      <AgentProviderEditor
        runtimeBanner={runtimeBanner}
        creatingProvider={creatingProvider}
        selectedProvider={selectedProvider}
        selectedProviderId={selectedProviderId}
        draft={draft}
        manualAgentModel={manualAgentModel}
        statusLine={statusLine}
        agentBusy={agentBusy}
        isBusy={isBusy}
        adapterLabel={adapterLabel}
        onClose={onCloseProviderEditor}
        onDeleteProvider={onDeleteProvider}
        onDraftChange={onDraftChange}
        onProviderKindChange={(value) => onDraftChange(applyProviderPreset(draft, value))}
        onManualAgentModelChange={setManualAgentModel}
        onAddManualAgentModel={addManualAgentModel}
        onToggleModel={(model) => onDraftChange(toggleDraftModel(draft, model.id))}
        onMakeDefaultModel={(model) => onDraftChange({ ...draft, selectedModel: model.id })}
        onUpdateModel={(model) => onDraftChange(updateDraftModel(draft, model))}
        onRemoveModel={(model) => onDraftChange(removeDraftModel(draft, model.id))}
        onFetchModels={onFetchModels}
        onTestProvider={onTestProvider}
        onSaveProvider={onSaveProvider}
      />
    );
  }

  if (embeddingEditorOpen) {
    return (
      <EmbeddingProviderEditor
        runtimeBanner={runtimeBanner}
        creatingEmbeddingProvider={creatingEmbeddingProvider}
        selectedEmbeddingProvider={selectedEmbeddingProvider}
        selectedEmbeddingProviderId={selectedEmbeddingProviderId}
        embeddingDraft={embeddingDraft}
        embeddingLockedByIndexing={embeddingLockedByIndexing}
        embeddingStatusLine={embeddingStatusLine}
        embeddingBusy={embeddingBusy}
        isBusy={isBusy}
        adapterLabel={adapterLabel}
        onClose={onCloseEmbeddingEditor}
        onDeleteEmbeddingProvider={onDeleteEmbeddingProvider}
        onEmbeddingDraftChange={onEmbeddingDraftChange}
        onProviderKindChange={(value) => onEmbeddingDraftChange(applyProviderPreset(embeddingDraft, value))}
        onFetchEmbeddingModels={onFetchEmbeddingModels}
        onTestEmbeddingProvider={onTestEmbeddingProvider}
        onSaveEmbeddingProvider={onSaveEmbeddingProvider}
      />
    );
  }

  if (visionEditorOpen) {
    return (
      <VisionProviderEditor
        runtimeBanner={runtimeBanner}
        creatingVisionProvider={creatingVisionProvider}
        selectedVisionProvider={selectedVisionProvider}
        selectedVisionProviderId={selectedVisionProviderId}
        visionDraft={visionDraft}
        manualVisionModel={manualVisionModel}
        visionStatusLine={visionStatusLine}
        visionBusy={visionBusy}
        isBusy={isBusy}
        adapterLabel={adapterLabel}
        onClose={onCloseVisionEditor}
        onDeleteVisionProvider={onDeleteVisionProvider}
        onVisionDraftChange={onVisionDraftChange}
        onProviderKindChange={(value) => onVisionDraftChange(applyProviderPreset(visionDraft, value))}
        onManualVisionModelChange={setManualVisionModel}
        onAddManualVisionModel={addManualVisionModel}
        onToggleModel={(model) => onVisionDraftChange(toggleDraftModel(visionDraft, model.id))}
        onMakeDefaultModel={(model) => onVisionDraftChange({ ...visionDraft, selectedModel: model.id })}
        onUpdateModel={(model) => onVisionDraftChange(updateDraftModel(visionDraft, model))}
        onRemoveModel={(model) => onVisionDraftChange(removeDraftModel(visionDraft, model.id))}
        onFetchVisionModels={onFetchVisionModels}
        onTestVisionProvider={onTestVisionProvider}
        onSaveVisionProvider={onSaveVisionProvider}
      />
    );
  }

  if (ocrEditorOpen) {
    return (
      <OcrProviderEditor
        runtimeBanner={runtimeBanner}
        creatingOcrProvider={creatingOcrProvider}
        selectedOcrProvider={selectedOcrProvider}
        selectedOcrProviderId={selectedOcrProviderId}
        ocrDraft={ocrDraft}
        ocrModels={ocrModels}
        manualOcrModel={manualOcrModel}
        ocrStatusLine={ocrStatusLine}
        ocrBusy={ocrBusy}
        isBusy={isBusy}
        adapterLabel={adapterLabel}
        onClose={onCloseOcrEditor}
        onDeleteOcrProvider={onDeleteOcrProvider}
        onOcrDraftChange={onOcrDraftChange}
        onProviderKindChange={(value) => onOcrDraftChange(applyProviderPreset(ocrDraft, value))}
        onManualOcrModelChange={setManualOcrModel}
        onAddManualOcrModel={addManualOcrModel}
        onToggleModel={(model) => onOcrDraftChange(toggleDraftModel(ocrDraft, model.id))}
        onMakeDefaultModel={(model) => onOcrDraftChange({ ...ocrDraft, selectedModel: model.id })}
        onUpdateModel={(model) => onOcrDraftChange(updateDraftModel(ocrDraft, model))}
        onRemoveModel={(model) => onOcrDraftChange(removeDraftModel(ocrDraft, model.id))}
        onFetchOcrModels={onFetchOcrModels}
        onTestOcrProvider={onTestOcrProvider}
        onSaveOcrProvider={onSaveOcrProvider}
      />
    );
  }

  return (
    <div className="space-y-4">
      {runtimeBanner}
      <div className="grid gap-4">
        <section className="rounded-lg border bg-background/70 p-3">
          <div className="mb-3 flex items-center justify-between gap-2">
            <div>
              <div className="flex items-center gap-2 text-xs font-semibold">
                <PlugZap className="h-3.5 w-3.5" />
                Agent
              </div>
              <div className="mt-1 text-[11px] text-muted-foreground">自定义模型配置。</div>
            </div>
            <IconActionButton icon={<Plus className="h-3.5 w-3.5" />} label="新建 Agent" onClick={onNewProvider} disabled={agentBusy} />
          </div>

          <div className={cx(PROVIDER_PROFILE_LIST_HEIGHT_CLASS, "space-y-2 overflow-y-auto overscroll-contain pr-1 [scrollbar-gutter:stable] brevyn-scrollbar")}>
            {agentProviders.map((provider) => (
              <ProviderProfileRow
                key={provider.id}
                provider={provider}
                active={provider.enabled}
                statusLabel={provider.enabled ? "已启用" : "已关闭"}
                statusOn={provider.enabled}
                onSelect={() => onSelectProvider(provider)}
                onEdit={() => onSelectProvider(provider)}
                onDelete={() => onDeleteProvider(provider)}
                onToggle={() => onToggleProvider(provider)}
                toggleDisabled={agentBusy || agentToggleBusy}
              />
            ))}
            {agentProviders.length === 0 && <div className="rounded-lg border border-dashed bg-card px-3 py-8 text-center text-xs text-muted-foreground">暂无 Agent 配置。</div>}
          </div>
          <AgentGatewayAdvancedPanel
            status={agentGatewayStatus}
            busy={agentGatewayBusy}
            onToggle={onToggleOpenAiResponsesGateway}
          />
          {statusLine && <div className="mt-3 rounded-md bg-muted/55 px-2 py-2 text-[11px] text-muted-foreground">{statusLine}</div>}
        </section>

        <section className="rounded-lg border bg-background/70 p-3">
          <div className="mb-3 flex items-center justify-between gap-2">
            <div>
              <div className="flex items-center gap-2 text-xs font-semibold">
                <Database className="h-3.5 w-3.5" />
                Embedding
              </div>
              <div className="mt-1 text-[11px] text-muted-foreground">这里只显示已保存的配置。</div>
            </div>
            <IconActionButton icon={<Plus className="h-3.5 w-3.5" />} label="新建 Embedding" onClick={onNewEmbeddingProvider} disabled={embeddingBusy} />
          </div>
          {embeddingLockedByIndexing && (
            <div className="mb-3 rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-[11px] leading-5 text-amber-900">
              向量索引任务进行中，Embedding 配置已临时锁定。
            </div>
          )}

          <div className={cx(PROVIDER_PROFILE_LIST_HEIGHT_CLASS, "space-y-2 overflow-y-auto overscroll-contain pr-1 [scrollbar-gutter:stable] brevyn-scrollbar")}>
            {embeddingProviders.map((provider) => (
              <ProviderProfileRow
                key={provider.id}
                provider={provider}
                active={provider.enabled}
                statusLabel={provider.enabled ? "已启用" : "已关闭"}
                statusOn={Boolean(provider.enabled)}
                onSelect={() => onSelectEmbeddingProvider(provider)}
                onEdit={() => onSelectEmbeddingProvider(provider)}
                onDelete={() => onDeleteEmbeddingProvider(provider)}
                onToggle={() => onToggleEmbeddingProvider(provider)}
                toggleDisabled={embeddingBusy || embeddingToggleBusy}
              />
            ))}
            {embeddingProviders.length === 0 && <div className="rounded-lg border border-dashed bg-card px-3 py-8 text-center text-xs text-muted-foreground">暂无 Embedding 配置。新建后会显示在这里。</div>}
          </div>
          {showEmbeddingIndexNotice && (
            <div className="mt-3 rounded-md border border-[hsl(var(--status-warning)/0.25)] bg-[hsl(var(--status-warning)/0.1)] px-3 py-2 text-[11px] leading-5 text-[hsl(var(--status-warning))]">
              <div className="flex gap-2">
                <Database className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                <div className="min-w-0 flex-1">
                  <div className="font-medium">{embeddingIndexNoticeTitle(embeddingIndexHealth)}</div>
                  <div>{embeddingReindexNotice || embeddingIndexNoticeDescription(embeddingIndexHealth)}</div>
                  {embeddingIndexHealth?.embeddingConfigured && embeddingIndexHealth.totalFiles > 0 && (
                    <div className="mt-2 flex flex-wrap gap-2">
                      <span title="使用当前 Embedding 配置，重新构建当前学期全部资料的向量索引。可能消耗 Embedding 额度。">
                        <button
                          type="button"
                          className="inline-flex h-7 items-center gap-1.5 rounded-md border border-[hsl(var(--status-warning)/0.28)] bg-[hsl(var(--status-warning)/0.12)] px-2 text-[10px] font-medium text-[hsl(var(--status-warning))] transition hover:bg-[hsl(var(--status-warning)/0.18)] disabled:cursor-not-allowed disabled:opacity-50"
                          disabled={reindexingActiveSemester || embeddingLockedByIndexing}
                          onClick={onReindexActiveSemester}
                          title="使用当前 Embedding 配置，重新构建当前学期全部资料的向量索引。可能消耗 Embedding 额度。"
                        >
                          {reindexingActiveSemester ? <RefreshCw className="h-3 w-3 animate-spin" /> : <RefreshCw className="h-3 w-3" />}
                          {reindexingActiveSemester ? "正在重建..." : "重建当前学期全部资料"}
                        </button>
                      </span>
                    </div>
                  )}
                </div>
              </div>
            </div>
          )}
          {embeddingStatusLine && <div className="mt-3 rounded-md bg-muted/55 px-2 py-2 text-[11px] text-muted-foreground">{embeddingStatusLine}</div>}
        </section>

        <section className="rounded-lg border bg-background/70 p-3">
          <div className="mb-3 flex items-center justify-between gap-2">
            <div>
              <div className="flex items-center gap-2 text-xs font-semibold">
                <Eye className="h-3.5 w-3.5" />
                Vision
              </div>
              <div className="mt-1 text-[11px] text-muted-foreground">这里只显示已保存的配置。</div>
            </div>
            <IconActionButton icon={<Plus className="h-3.5 w-3.5" />} label="新建 Vision" onClick={onNewVisionProvider} disabled={visionBusy} />
          </div>

          <div className={cx(PROVIDER_PROFILE_LIST_HEIGHT_CLASS, "space-y-2 overflow-y-auto overscroll-contain pr-1 [scrollbar-gutter:stable] brevyn-scrollbar")}>
            {visionProviders.map((provider) => (
              <ProviderProfileRow
                key={provider.id}
                provider={provider}
                active={provider.enabled}
                statusLabel={provider.enabled ? "已启用" : "已关闭"}
                statusOn={Boolean(provider.enabled)}
                onSelect={() => onSelectVisionProvider(provider)}
                onEdit={() => onSelectVisionProvider(provider)}
                onDelete={() => onDeleteVisionProvider(provider)}
                onToggle={() => onToggleVisionProvider(provider)}
                toggleDisabled={visionBusy || visionToggleBusy}
              />
            ))}
            {visionProviders.length === 0 && <div className="rounded-lg border border-dashed bg-card px-3 py-8 text-center text-xs text-muted-foreground">暂无 Vision 配置。新建后可用于校历和课程表识别。</div>}
          </div>
          <div className="mt-3 flex flex-wrap gap-2">
            <ActionButton
              icon={visionTestBusy === "calendar" ? <RefreshCw className="h-3.5 w-3.5 animate-spin" /> : <CalendarDays className="h-3.5 w-3.5" />}
              label="测试校历"
              onClick={() => void runVisionTest("calendar")}
              disabled={Boolean(visionTestBusy) || !hasRunnableVisionProvider(visionProviders)}
            />
            <ActionButton
              icon={visionTestBusy === "timetable" ? <RefreshCw className="h-3.5 w-3.5 animate-spin" /> : <BookOpen className="h-3.5 w-3.5" />}
              label="测试课表"
              onClick={() => void runVisionTest("timetable")}
              disabled={Boolean(visionTestBusy) || !hasRunnableVisionProvider(visionProviders)}
            />
          </div>
          {visionTestError && <div className="mt-3 rounded-md border border-rose-200 bg-rose-50 px-2 py-2 text-[11px] leading-5 text-rose-900">{visionTestError}</div>}
          {visionTestResult && <VisionTestResultPanel result={visionTestResult} />}
          {visionStatusLine && <div className="mt-3 rounded-md bg-muted/55 px-2 py-2 text-[11px] text-muted-foreground">{visionStatusLine}</div>}
        </section>

        <section className="rounded-lg border bg-background/70 p-3">
          <div className="mb-3 flex items-center justify-between gap-2">
            <div>
              <div className="flex items-center gap-2 text-xs font-semibold">
                <ScanText className="h-3.5 w-3.5" />
                OCR
              </div>
              <div className="mt-1 text-[11px] text-muted-foreground">用于扫描课件、图片页和低文本覆盖文件的索引补识别。</div>
            </div>
            <IconActionButton icon={<Plus className="h-3.5 w-3.5" />} label="新建 OCR" onClick={onNewOcrProvider} disabled={ocrBusy} />
          </div>

          <div className={cx(PROVIDER_PROFILE_LIST_HEIGHT_CLASS, "space-y-2 overflow-y-auto overscroll-contain pr-1 [scrollbar-gutter:stable] brevyn-scrollbar")}>
            {ocrProviders.map((provider) => (
              <ProviderProfileRow
                key={provider.id}
                provider={provider}
                active={provider.enabled}
                statusLabel={provider.enabled ? "已启用" : "已关闭"}
                statusOn={Boolean(provider.enabled)}
                onSelect={() => onSelectOcrProvider(provider)}
                onEdit={() => onSelectOcrProvider(provider)}
                onDelete={() => onDeleteOcrProvider(provider)}
                onToggle={() => onToggleOcrProvider(provider)}
                toggleDisabled={ocrBusy || ocrToggleBusy}
              />
            ))}
            {ocrProviders.length === 0 && <div className="rounded-lg border border-dashed bg-card px-3 py-8 text-center text-xs text-muted-foreground">暂无 OCR 配置。新建后可用于课程文件索引前的扫描件补识别。</div>}
          </div>
          {ocrStatusLine && <div className="mt-3 rounded-md bg-muted/55 px-2 py-2 text-[11px] text-muted-foreground">{ocrStatusLine}</div>}
        </section>
      </div>
    </div>
  );
}

function embeddingIndexNoticeTitle(health: EmbeddingIndexHealth | null): string {
  if (health && !health.embeddingConfigured) return "尚未启用 Embedding";
  if (health?.state === "empty") return "当前学期尚未建立索引";
  if (health?.state === "needs_rebuild") return "当前学期索引需要重建";
  return "索引重建未完成";
}

function embeddingIndexNoticeDescription(health: EmbeddingIndexHealth | null): string {
  if (!health) return "无法确认当前学期索引状态，请稍后重试。";
  if (!health.embeddingConfigured) return "当前没有启用 Embedding 服务商，无法建立或更新向量索引。";
  const details = [
    health.staleFiles > 0 ? `${health.staleFiles} 个资料使用旧配置` : "",
    health.unindexedFiles > 0 ? `${health.unindexedFiles} 个资料尚未索引` : "",
  ].filter(Boolean).join("，");
  return `当前学期${details ? `有${details}` : "的向量索引需要更新"}。`;
}
