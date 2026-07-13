import { useMemo } from "react";
import type { AgentPermissionMode, ModelProviderConfig } from "@/types/domain";
import { DropdownSelect } from "@/components/ui/DropdownSelect";
import { AgentPermissionModeButton } from "@/components/agent/AgentPermissionModeButton";
import { ModelProviderIcon } from "@/lib/model-provider-logo";

export function AgentProviderPicker({
  running,
  permissionMode,
  agentProviders,
  activeProviderId,
  onSetPermissionMode,
  onSelectProvider,
}: {
  running: boolean;
  permissionMode: AgentPermissionMode;
  agentProviders: ModelProviderConfig[];
  activeProviderId: string;
  onSetPermissionMode: (mode: AgentPermissionMode) => void;
  onSelectProvider: (providerId: string) => Promise<void>;
}) {
  const providerOptions = useMemo(
    () => agentProviders
      .filter((provider) => provider.enabled)
      .flatMap((provider) => {
        const models = provider.models.filter((model) => model.enabled !== false);
        const orderedModels = [
          ...models.filter((model) => model.id === provider.selectedModel),
          ...models.filter((model) => model.id !== provider.selectedModel),
        ];
        return orderedModels.map((model) => ({
          value: providerModelValue(provider.id, model.id),
          label: model.name || model.id,
          detail: provider.name,
          icon: <ModelProviderIcon modelId={model.id} baseUrl={provider.baseUrl} providerKind={provider.providerKind} title={model.name || model.id} className="h-4 w-4 rounded-[0.28rem]" />,
        }));
      }),
    [agentProviders],
  );
  const menuWidth = useMemo(() => measuredProviderMenuWidth(providerOptions), [providerOptions]);
  return (
    <>
      <AgentPermissionModeButton running={running} permissionMode={permissionMode} onSetPermissionMode={onSetPermissionMode} />
      <DropdownSelect
        value={activeProviderId}
        options={providerOptions}
        onChange={(providerId) => void onSelectProvider(providerId)}
        placeholder="Select model"
        ariaLabel="Select agent model"
        disabled={providerOptions.length === 0}
        className="inline-block shrink-0"
        style={{ width: "fit-content", minWidth: 132, maxWidth: "min(44vw, 280px)" }}
        buttonClassName="h-8 rounded-full !border-transparent !bg-[hsl(var(--foreground)/0.06)] px-2.5 text-[11px] font-semibold !shadow-none hover:!bg-[hsl(var(--foreground)/0.09)]"
        menuClassName="bg-[hsl(var(--card))]"
        menuWidth={menuWidth}
        menuMinWidth={220}
        menuItemHeight={50}
        menuMaxVisibleItems={5}
        renderValue={(option) => (
          option ? (
            <span className="flex min-w-0 items-center gap-1.5">
              {option.icon}
              <span className="truncate">{option.label}</span>
            </span>
          ) : "Select model"
        )}
      />
    </>
  );
}

function measuredProviderMenuWidth(options: Array<{ label: string; detail?: string }>): number {
  const maxTextWidth = options.reduce((maxWidth, option) => {
    const labelWidth = measureTextWidth(option.label, "600 12px ui-sans-serif, system-ui, sans-serif");
    const detailWidth = option.detail ? measureTextWidth(option.detail, "400 10px ui-sans-serif, system-ui, sans-serif") : 0;
    return Math.max(maxWidth, labelWidth, detailWidth);
  }, 0);
  const chromeWidth = 16 + 6 + 20 + 24 + 10;
  return Math.ceil(Math.min(Math.max(maxTextWidth + chromeWidth, 220), 360));
}

let measureCanvas: HTMLCanvasElement | null = null;

function measureTextWidth(text: string, font: string): number {
  if (typeof document === "undefined") return text.length * 7;
  measureCanvas ||= document.createElement("canvas");
  const context = measureCanvas.getContext("2d");
  if (!context) return text.length * 7;
  context.font = font;
  return context.measureText(text).width;
}

export function providerModelValue(providerId: string, modelId: string): string {
  return `${encodeURIComponent(providerId)}::${encodeURIComponent(modelId)}`;
}

export function parseProviderModelValue(value: string): { providerId?: string; modelId?: string } {
  const [providerId, modelId] = value.split("::");
  if (!providerId || !modelId) return {};
  return {
    providerId: decodeURIComponent(providerId),
    modelId: decodeURIComponent(modelId),
  };
}
