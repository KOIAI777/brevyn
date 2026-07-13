import { Minus, Pencil, Plus, Trash2 } from "lucide-react";
import type { ReactNode } from "react";
import { DropdownSelect } from "@/components/ui/DropdownSelect";
import { IconActionButton } from "@/components/settings/shared/SettingsControls";
import { getProviderKindLogo, getProviderProfileLogo, ModelProviderIcon } from "@/lib/model-provider-logo";
import { cx } from "@/lib/cn";
import { AGENT_PROVIDER_PRESETS, EMBEDDING_PROVIDER_PRESETS, OCR_PROVIDER_PRESETS, VISION_PROVIDER_PRESETS, type AgentProviderKind, type EmbeddingProviderKind, type ModelProviderConfig, type OcrProviderKind, type ProviderKind, type ProviderModel, type ProviderPurpose, type VisionProviderKind } from "../../../../types/domain";
import {
  PROVIDER_PROFILE_ROW_HEIGHT_CLASS,
  contextWindowFromInput,
  contextWindowSourceLabel,
  formatContextWindow,
  providerDisplayName,
  providerKindLabel,
} from "./providerUtils";

const agentProviderKinds = Object.keys(AGENT_PROVIDER_PRESETS) as AgentProviderKind[];
const embeddingProviderKinds = Object.keys(EMBEDDING_PROVIDER_PRESETS) as EmbeddingProviderKind[];
const visionProviderKinds = Object.keys(VISION_PROVIDER_PRESETS) as VisionProviderKind[];
const ocrProviderKinds = Object.keys(OCR_PROVIDER_PRESETS) as OcrProviderKind[];

export function ProviderProfileRow({
  provider,
  active,
  statusLabel,
  statusOn,
  onSelect,
  onEdit,
  onDelete,
  onToggle,
  toggleDisabled,
}: {
  provider: ModelProviderConfig;
  active: boolean;
  statusLabel: string;
  statusOn: boolean;
  onSelect: () => void;
  onEdit: () => void;
  onDelete: () => void;
  onToggle: () => void;
  toggleDisabled?: boolean;
}) {
  const actionsDisabled = Boolean(toggleDisabled);
  const enabledModels = provider.models.filter((model) => model.enabled !== false);
  const displayName = providerDisplayName(provider);
  const icon = getProviderProfileLogo(provider);
  return (
    <div className={cx("group flex items-center gap-2 rounded-lg border p-2 transition-colors", PROVIDER_PROFILE_ROW_HEIGHT_CLASS, active ? "bg-muted text-foreground ring-1 ring-border/70" : "bg-card text-muted-foreground hover:text-foreground")}>
      <ModelProviderIcon icon={icon} title={displayName} className="h-8 w-8 rounded-lg" />
      <button type="button" className="min-w-0 flex-1 text-left" onClick={onSelect}>
        <span className="block truncate text-xs font-semibold" title={provider.name}>{displayName}</span>
        <span className="mt-0.5 block truncate text-[10px]">
          {providerKindLabel(provider.providerKind)} · {provider.baseUrl || "未设置 URL"}
        </span>
        <span className="mt-1 flex min-w-0 flex-wrap gap-1">
          {provider.selectedModel && <span className="max-w-[150px] truncate rounded bg-background/80 px-1.5 py-0.5 text-[9px]">{provider.selectedModel}</span>}
          {enabledModels.length > 1 && <span className="rounded bg-background/80 px-1.5 py-0.5 text-[9px]">+{enabledModels.length - 1}</span>}
        </span>
      </button>
      <div className="ml-auto flex items-center gap-1.5">
        <div className="flex w-[72px] shrink-0 items-center justify-end gap-1">
          <IconActionButton icon={<Pencil className="h-3.5 w-3.5" />} label={`编辑 ${displayName}`} onClick={onEdit} disabled={actionsDisabled} />
          <IconActionButton icon={<Trash2 className="h-3.5 w-3.5" />} label={`删除 ${displayName}`} onClick={onDelete} disabled={actionsDisabled} danger />
        </div>
        <ProviderSwitch enabled={statusOn} label={statusLabel} onClick={onToggle} disabled={toggleDisabled} />
      </div>
    </div>
  );
}

export function ProviderSwitch({ enabled, label, onClick, disabled }: { enabled: boolean; label: string; onClick: () => void; disabled?: boolean }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={enabled}
      aria-label={label}
      title={label}
      disabled={disabled}
      onClick={onClick}
      className={cx(
        "relative inline-flex h-6 w-11 shrink-0 items-center rounded-full border transition-colors duration-200 disabled:cursor-not-allowed",
        enabled ? "border-[hsl(var(--status-success)/0.85)] bg-[hsl(var(--status-success))]" : "border-border bg-muted hover:bg-muted/80",
      )}
    >
      <span
        className={cx(
          "pointer-events-none h-5 w-5 rounded-full bg-white shadow-sm ring-1 ring-black/5 transition-transform duration-200",
          enabled ? "translate-x-[21px]" : "translate-x-0.5",
        )}
      />
    </button>
  );
}

export function ProviderKindField({
  purpose,
  value,
  onChange,
  disabled,
}: {
  purpose: ProviderPurpose;
  value: ProviderKind;
  onChange: (value: ProviderKind) => void;
  disabled?: boolean;
}) {
  const options = purpose === "agent" ? agentProviderKinds : purpose === "vision" ? visionProviderKinds : purpose === "ocr" ? ocrProviderKinds : embeddingProviderKinds;
  return (
    <label className="space-y-1 text-[11px] text-muted-foreground">
      <span>服务商</span>
      <DropdownSelect
        value={value}
        options={options.map((kind) => ({
          value: kind,
          label: providerKindLabel(kind),
          icon: <ModelProviderIcon icon={getProviderKindLogo(kind)} title={providerKindLabel(kind)} className="h-4 w-4 rounded-[0.28rem]" />,
        }))}
        placeholder="选择服务商"
        ariaLabel="选择服务商类型"
        onChange={(next) => onChange(next as ProviderKind)}
        disabled={disabled}
        renderValue={(option) => (
          option ? (
            <span className="flex min-w-0 items-center gap-1.5">
              {option.icon}
              <span className="truncate">{option.label}</span>
            </span>
          ) : "选择服务商"
        )}
      />
    </label>
  );
}

export function ModelPicker({
  providerKind,
  baseUrl,
  models,
  selectedModel,
  onPick,
  disabled,
}: {
  providerKind: ProviderKind;
  baseUrl: string;
  models: ProviderModel[];
  selectedModel: string;
  onPick: (model: ProviderModel) => void;
  disabled?: boolean;
}) {
  if (models.length === 0) return null;
  return (
    <div className="mt-3 rounded-md border bg-card p-2">
      <div className="mb-2 flex items-center justify-between gap-2 px-1 text-[10px] font-semibold uppercase tracking-[0.14em] text-muted-foreground">
        <span>模型</span>
        <span>{models.length}</span>
      </div>
      <div className="max-h-64 space-y-1 overflow-y-auto pr-1 brevyn-scrollbar">
        {models.map((model) => {
          const selected = model.id === selectedModel;
          return (
            <button
              key={model.id}
              type="button"
              className={cx(
                "flex w-full min-w-0 items-center gap-2 rounded-md border px-2 py-2 text-left text-[11px] transition-colors",
                disabled
                  ? "cursor-not-allowed border-border/45 bg-muted/35 text-muted-foreground/70"
                  : selected
                    ? "border-[hsl(var(--status-success)/0.32)] bg-[hsl(var(--status-success)/0.11)] text-foreground shadow-sm ring-1 ring-[hsl(var(--status-success)/0.16)]"
                    : "border-border/55 bg-background text-muted-foreground hover:border-[hsl(var(--status-success)/0.24)] hover:bg-[hsl(var(--status-success)/0.08)] hover:text-foreground",
              )}
              disabled={disabled}
              onClick={() => onPick(model)}
            >
              <ModelProviderIcon modelId={model.id} baseUrl={baseUrl} providerKind={providerKind} title={model.name || model.id} className="h-7 w-7 rounded-md" />
              <span className="min-w-0 flex-1">
                <span className="block truncate font-medium text-foreground">{model.name}</span>
                <span className={cx("block truncate text-[10px]", selected ? "text-[hsl(var(--status-success))]" : "text-muted-foreground")}>{model.id}</span>
                {model.contextWindowTokens && (
                  <span className={cx("mt-0.5 block text-[10px]", selected ? "text-[hsl(var(--status-success))]" : "text-muted-foreground")}>
                    {formatContextWindow(model.contextWindowTokens)} 上下文
                  </span>
                )}
              </span>
            </button>
          );
        })}
      </div>
    </div>
  );
}

export function AgentModelManager({
  title = "聊天模型",
  providerKind,
  baseUrl,
  availableEmptyLabel = "已获取的模型都已启用。",
  enabledEmptyLabel = "至少启用一个模型用于聊天。",
  models,
  selectedModel,
  onToggle,
  onMakeDefault,
  onUpdateModel,
  onRemoveModel,
}: {
  title?: string;
  providerKind: ProviderKind;
  baseUrl: string;
  availableEmptyLabel?: string;
  enabledEmptyLabel?: string;
  models: ProviderModel[];
  selectedModel: string;
  onToggle: (model: ProviderModel) => void;
  onMakeDefault: (model: ProviderModel) => void;
  onUpdateModel?: (model: ProviderModel) => void;
  onRemoveModel?: (model: ProviderModel) => void;
}) {
  const availableModels = models.filter((model) => model.enabled === false);
  const enabledModels = models.filter((model) => model.enabled !== false);
  return (
    <div className="mt-3 rounded-md border bg-card p-2">
      <div className="mb-2 flex items-center justify-between gap-2 px-1 text-[10px] font-semibold uppercase tracking-[0.14em] text-muted-foreground">
        <span>{title}</span>
        <span>{enabledModels.length}/{models.length} 已启用</span>
      </div>
      <div className="grid min-h-0 gap-2 md:grid-cols-2">
        <ModelColumn title="可用" emptyLabel={availableEmptyLabel} empty={availableModels.length === 0}>
          {availableModels.map((model) => (
            <ModelTransferRow
              key={model.id}
              model={model}
              providerKind={providerKind}
              baseUrl={baseUrl}
              icon={<Plus className="h-3.5 w-3.5" />}
              label="启用模型"
              onClick={() => onToggle(model)}
              onUpdateModel={onUpdateModel}
              onRemoveModel={onRemoveModel}
            />
          ))}
        </ModelColumn>
        <ModelColumn title="已启用" emptyLabel={enabledEmptyLabel} empty={enabledModels.length === 0}>
          {enabledModels.map((model) => {
            const selected = model.id === selectedModel;
            return (
              <ModelTransferRow
                key={model.id}
                model={model}
                providerKind={providerKind}
                baseUrl={baseUrl}
                selected={selected}
                icon={<Minus className="h-3.5 w-3.5" />}
                label="停用模型"
                onClick={() => onToggle(model)}
                onMakeDefault={() => onMakeDefault(model)}
                onUpdateModel={onUpdateModel}
                onRemoveModel={onRemoveModel}
              />
            );
          })}
        </ModelColumn>
      </div>
    </div>
  );
}

function ModelColumn({ title, emptyLabel, empty, children }: { title: string; emptyLabel: string; empty: boolean; children: ReactNode }) {
  return (
    <div className="min-w-0 rounded-md border bg-background/70">
      <div className="border-b px-2 py-1.5 text-[10px] font-medium text-muted-foreground">{title}</div>
      <div className="max-h-64 space-y-1 overflow-y-auto p-1.5 brevyn-scrollbar">
        {empty ? <div className="rounded-md border border-dashed px-2 py-6 text-center text-[11px] text-muted-foreground">{emptyLabel}</div> : children}
      </div>
    </div>
  );
}

function ModelTransferRow({
  model,
  providerKind,
  baseUrl,
  selected,
  icon,
  label,
  onClick,
  onMakeDefault,
  onUpdateModel,
  onRemoveModel,
}: {
  model: ProviderModel;
  providerKind: ProviderKind;
  baseUrl: string;
  selected?: boolean;
  icon: ReactNode;
  label: string;
  onClick: () => void;
  onMakeDefault?: () => void;
  onUpdateModel?: (model: ProviderModel) => void;
  onRemoveModel?: (model: ProviderModel) => void;
}) {
  const contextWindowValue = model.contextWindowTokens ? model.contextWindowTokens.toLocaleString() : "";
  return (
    <div className={cx("grid min-w-0 grid-cols-[auto_minmax(0,1fr)_7.5rem_auto_auto] items-center gap-2 rounded-md border px-2 py-2 text-[11px] transition-colors", selected ? "border-[hsl(var(--status-success)/0.32)] bg-[hsl(var(--status-success)/0.1)] text-foreground ring-1 ring-[hsl(var(--status-success)/0.15)]" : "border-border/55 bg-card text-muted-foreground")}>
      <ModelProviderIcon modelId={model.id} baseUrl={baseUrl} providerKind={providerKind} title={model.name || model.id} className="h-8 w-8 rounded-lg" />
      <button type="button" className="min-w-0 text-left" onClick={onMakeDefault} disabled={!onMakeDefault} title={model.id}>
        <span className="flex min-w-0 items-center gap-1.5">
          <span className="truncate font-medium text-foreground">{model.name}</span>
          {selected && <span className="shrink-0 rounded-full border border-[hsl(var(--status-success)/0.26)] bg-[hsl(var(--status-success)/0.12)] px-1.5 py-0.5 text-[9px] text-[hsl(var(--status-success))]">默认</span>}
        </span>
        <span className="mt-0.5 block truncate text-[10px] text-muted-foreground">{model.id}</span>
        <span className="mt-0.5 block truncate text-[10px] text-muted-foreground">
          {model.contextWindowTokens ? `${formatContextWindow(model.contextWindowTokens)} · ${contextWindowSourceLabel(model.contextWindowSource)}` : "上下文窗口未设置"}
        </span>
      </button>
      <label className="min-w-0 text-[10px] text-muted-foreground">
        <span className="sr-only">上下文窗口 token</span>
        <input
          className="h-7 w-full rounded-md border bg-background px-2 text-right text-[11px] text-foreground outline-none placeholder:text-muted-foreground/45 focus:border-foreground/35"
          inputMode="numeric"
          value={contextWindowValue}
          placeholder="窗口"
          title="上下文窗口 token"
          onClick={(event) => event.stopPropagation()}
          onChange={(event) => {
            const next = contextWindowFromInput(event.target.value);
            onUpdateModel?.({
              ...model,
              contextWindowTokens: next,
              contextWindowSource: next ? "user" : undefined,
            });
          }}
        />
      </label>
      <button
        type="button"
        className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md border bg-background text-muted-foreground transition hover:border-red-200 hover:bg-red-50 hover:text-red-700 disabled:cursor-not-allowed disabled:opacity-45"
        onClick={(event) => {
          event.stopPropagation();
          onRemoveModel?.(model);
        }}
        disabled={!onRemoveModel}
        aria-label="删除模型"
        title="删除模型"
      >
        <Trash2 className="h-3.5 w-3.5" />
      </button>
      <button
        type="button"
        className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md border bg-background text-muted-foreground transition hover:bg-accent hover:text-foreground"
        onClick={onClick}
        aria-label={label}
        title={label}
      >
        {icon}
      </button>
    </div>
  );
}
