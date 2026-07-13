import { createElement, type CSSProperties } from "react";
import type { IconType } from "@lobehub/icons/es/types";
import OpenAiMono from "@lobehub/icons/es/OpenAI/components/Mono";
import { AVATAR_BACKGROUND as OPENAI_BG, AVATAR_COLOR as OPENAI_COLOR, AVATAR_ICON_MULTIPLE as OPENAI_SCALE } from "@lobehub/icons/es/OpenAI/style";
import ClaudeMono from "@lobehub/icons/es/Claude/components/Mono";
import { AVATAR_BACKGROUND as CLAUDE_BG, AVATAR_COLOR as CLAUDE_COLOR, AVATAR_ICON_MULTIPLE as CLAUDE_SCALE } from "@lobehub/icons/es/Claude/style";
import DeepSeekMono from "@lobehub/icons/es/DeepSeek/components/Mono";
import { AVATAR_BACKGROUND as DEEPSEEK_BG, AVATAR_COLOR as DEEPSEEK_COLOR, AVATAR_ICON_MULTIPLE as DEEPSEEK_SCALE } from "@lobehub/icons/es/DeepSeek/style";
import QwenMono from "@lobehub/icons/es/Qwen/components/Mono";
import { AVATAR_BACKGROUND as QWEN_BG, AVATAR_COLOR as QWEN_COLOR, AVATAR_ICON_MULTIPLE as QWEN_SCALE } from "@lobehub/icons/es/Qwen/style";
import KimiMono from "@lobehub/icons/es/Kimi/components/Mono";
import { AVATAR_BACKGROUND as KIMI_BG, AVATAR_COLOR as KIMI_COLOR, AVATAR_ICON_MULTIPLE as KIMI_SCALE } from "@lobehub/icons/es/Kimi/style";
import GeminiColor from "@lobehub/icons/es/Gemini/components/Color";
import { AVATAR_BACKGROUND as GEMINI_BG, AVATAR_ICON_MULTIPLE as GEMINI_SCALE } from "@lobehub/icons/es/Gemini/style";
import GoogleColor from "@lobehub/icons/es/Google/components/Color";
import { AVATAR_BACKGROUND as GOOGLE_BG, AVATAR_ICON_MULTIPLE as GOOGLE_SCALE } from "@lobehub/icons/es/Google/style";
import GoogleCloudColor from "@lobehub/icons/es/GoogleCloud/components/Color";
import { AVATAR_BACKGROUND as GOOGLE_CLOUD_BG, AVATAR_ICON_MULTIPLE as GOOGLE_CLOUD_SCALE } from "@lobehub/icons/es/GoogleCloud/style";
import ByteDanceMono from "@lobehub/icons/es/ByteDance/components/Mono";
import { AVATAR_BACKGROUND as BYTEDANCE_BG, AVATAR_COLOR as BYTEDANCE_COLOR, AVATAR_ICON_MULTIPLE as BYTEDANCE_SCALE } from "@lobehub/icons/es/ByteDance/style";
import DoubaoColor from "@lobehub/icons/es/Doubao/components/Color";
import { AVATAR_BACKGROUND as DOUBAO_BG, AVATAR_ICON_MULTIPLE as DOUBAO_SCALE } from "@lobehub/icons/es/Doubao/style";
import VolcengineColor from "@lobehub/icons/es/Volcengine/components/Color";
import { AVATAR_BACKGROUND as VOLCENGINE_BG, AVATAR_ICON_MULTIPLE as VOLCENGINE_SCALE } from "@lobehub/icons/es/Volcengine/style";
import MiniMaxMono from "@lobehub/icons/es/Minimax/components/Mono";
import { AVATAR_BACKGROUND as MINIMAX_BG, AVATAR_COLOR as MINIMAX_COLOR, AVATAR_ICON_MULTIPLE as MINIMAX_SCALE } from "@lobehub/icons/es/Minimax/style";
import AlibabaCloudMono from "@lobehub/icons/es/AlibabaCloud/components/Mono";
import { AVATAR_BACKGROUND as ALIBABA_CLOUD_BG, AVATAR_COLOR as ALIBABA_CLOUD_COLOR, AVATAR_ICON_MULTIPLE as ALIBABA_CLOUD_SCALE } from "@lobehub/icons/es/AlibabaCloud/style";
import BailianColor from "@lobehub/icons/es/Bailian/components/Color";
import { AVATAR_BACKGROUND as BAILIAN_BG, AVATAR_ICON_MULTIPLE as BAILIAN_SCALE } from "@lobehub/icons/es/Bailian/style";
import ZhipuMono from "@lobehub/icons/es/Zhipu/components/Mono";
import { AVATAR_BACKGROUND as ZHIPU_BG, AVATAR_COLOR as ZHIPU_COLOR, AVATAR_ICON_MULTIPLE as ZHIPU_SCALE } from "@lobehub/icons/es/Zhipu/style";
import modelGenericLogo from "@/assets/models/model-generic.svg";
import type { ModelProviderConfig, ProviderKind } from "@/types/domain";
import { cx } from "@/lib/cn";

type ProviderLike = Pick<ModelProviderConfig, "providerKind" | "baseUrl" | "selectedModel">;

interface ResolveModelProviderIconInput {
  modelId?: string;
  providerKind?: ProviderKind;
  baseUrl?: string;
}

type ModelProviderIconKey =
  | "openai"
  | "claude"
  | "deepseek"
  | "qwen"
  | "kimi"
  | "gemini"
  | "google"
  | "google-cloud"
  | "bytedance"
  | "doubao"
  | "volcengine"
  | "minimax"
  | "alibaba-cloud"
  | "bailian"
  | "zhipu"
  | "generic";

interface ModelProviderIconDefinition {
  Icon?: IconType;
  background?: string;
  color?: string;
  iconMultiple?: number;
  label: string;
}

const ICON_DEFINITIONS: Record<ModelProviderIconKey, ModelProviderIconDefinition> = {
  openai: { Icon: OpenAiMono, background: OPENAI_BG, color: OPENAI_COLOR, iconMultiple: OPENAI_SCALE, label: "OpenAI" },
  claude: { Icon: ClaudeMono, background: CLAUDE_BG, color: CLAUDE_COLOR, iconMultiple: CLAUDE_SCALE, label: "Claude" },
  deepseek: { Icon: DeepSeekMono, background: DEEPSEEK_BG, color: DEEPSEEK_COLOR, iconMultiple: DEEPSEEK_SCALE, label: "DeepSeek" },
  qwen: { Icon: QwenMono, background: QWEN_BG, color: QWEN_COLOR, iconMultiple: QWEN_SCALE, label: "Qwen" },
  kimi: { Icon: KimiMono, background: KIMI_BG, color: KIMI_COLOR, iconMultiple: KIMI_SCALE, label: "Kimi" },
  gemini: { Icon: GeminiColor, background: GEMINI_BG, iconMultiple: GEMINI_SCALE, label: "Gemini" },
  google: { Icon: GoogleColor, background: GOOGLE_BG, iconMultiple: GOOGLE_SCALE, label: "Google" },
  "google-cloud": { Icon: GoogleCloudColor, background: GOOGLE_CLOUD_BG, iconMultiple: GOOGLE_CLOUD_SCALE, label: "Google Cloud" },
  bytedance: { Icon: ByteDanceMono, background: BYTEDANCE_BG, color: BYTEDANCE_COLOR, iconMultiple: BYTEDANCE_SCALE, label: "ByteDance" },
  doubao: { Icon: DoubaoColor, background: DOUBAO_BG, iconMultiple: DOUBAO_SCALE, label: "Doubao" },
  volcengine: { Icon: VolcengineColor, background: VOLCENGINE_BG, iconMultiple: VOLCENGINE_SCALE, label: "Volcengine" },
  minimax: { Icon: MiniMaxMono, background: MINIMAX_BG, color: MINIMAX_COLOR, iconMultiple: MINIMAX_SCALE, label: "MiniMax" },
  "alibaba-cloud": { Icon: AlibabaCloudMono, background: ALIBABA_CLOUD_BG, color: ALIBABA_CLOUD_COLOR, iconMultiple: ALIBABA_CLOUD_SCALE, label: "Alibaba Cloud" },
  bailian: { Icon: BailianColor, background: BAILIAN_BG, iconMultiple: BAILIAN_SCALE, label: "Bailian" },
  zhipu: { Icon: ZhipuMono, background: ZHIPU_BG, color: ZHIPU_COLOR, iconMultiple: ZHIPU_SCALE, label: "Zhipu" },
  generic: { label: "Model" },
};

const MODEL_ICON_RULES: Array<[RegExp, ModelProviderIconKey]> = [
  [/gpt-?5|gpt-?4|gpt-?3(?:\.5)?|gpt|o1|o3|o4|codex|openai/i, "openai"],
  [/claude|anthropic/i, "claude"],
  [/deepseek/i, "deepseek"],
  [/glm|chatglm|zhipu|bigmodel|cogview|cogvideo/i, "zhipu"],
  [/qwen|qwq|qvq|wan-|dashscope|aliyun|alibaba/i, "qwen"],
  [/kimi|moonshot/i, "kimi"],
  [/gemini|gemma/i, "gemini"],
  [/google-cloud|googlecloud/i, "google-cloud"],
  [/google/i, "google"],
  [/doubao|seed/i, "doubao"],
  [/bytedance|byte[-_ ]?dance/i, "bytedance"],
  [/volc|volces|volcengine/i, "volcengine"],
  [/minimax|abab/i, "minimax"],
  [/bailian/i, "bailian"],
  [/embedding/i, "generic"],
];

const BASE_URL_ICON_RULES: Array<[RegExp, ModelProviderIconKey]> = [
  [/bigmodel|zhipu/i, "zhipu"],
  [/bailian/i, "bailian"],
  [/dashscope|aliyuncs|alibaba/i, "qwen"],
  [/moonshot|kimi/i, "kimi"],
  [/deepseek/i, "deepseek"],
  [/anthropic/i, "claude"],
  [/openai/i, "openai"],
  [/googleapis|generativelanguage/i, "gemini"],
  [/googlecloud/i, "google-cloud"],
  [/google/i, "google"],
  [/doubao/i, "doubao"],
  [/volces|volcengine/i, "volcengine"],
  [/bytedance|byte[-_ ]?dance/i, "bytedance"],
  [/minimax/i, "minimax"],
];

const PROVIDER_KIND_ICONS: Partial<Record<ProviderKind, ModelProviderIconKey>> = {
  anthropic: "claude",
  deepseek: "deepseek",
  "bailian-anthropic": "qwen",
  "kimi-api": "kimi",
  "kimi-coding": "kimi",
  "custom-anthropic": "claude",
  "openai-responses-agent": "openai",
  openai: "openai",
  qwen: "qwen",
  doubao: "doubao",
  zhipu: "zhipu",
  minimax: "minimax",
  "custom-openai": "openai",
  "vision-bailian-openai": "qwen",
  "vision-custom-openai": "openai",
  "vision-custom-anthropic": "claude",
  "vision-openai-responses": "openai",
  "vision-custom-openai-responses": "openai",
  "ocr-custom-openai": "openai",
  "ocr-custom-anthropic": "claude",
  "ocr-openai-responses": "openai",
};

export function getModelLogo(modelId: string, providerKind?: ProviderKind): ModelProviderIconKey {
  return resolveModelProviderIcon({ modelId, providerKind });
}

export function getModelLogoById(modelId: string): ModelProviderIconKey | undefined {
  return iconFromRules(modelId, MODEL_ICON_RULES);
}

export function getProviderKindLogo(providerKind: ProviderKind): ModelProviderIconKey {
  return PROVIDER_KIND_ICONS[providerKind] || "generic";
}

export function getProviderProfileLogo(provider: ProviderLike): ModelProviderIconKey {
  return resolveModelProviderIcon({
    modelId: provider.selectedModel,
    baseUrl: provider.baseUrl,
    providerKind: provider.providerKind,
  });
}

export function getProviderBaseUrlLogo(baseUrl: string, providerKind?: ProviderKind): ModelProviderIconKey {
  return iconFromRules(baseUrl, BASE_URL_ICON_RULES) || (providerKind ? getProviderKindLogo(providerKind) : "generic");
}

export function resolveModelProviderIcon({
  modelId,
  baseUrl,
  providerKind,
}: ResolveModelProviderIconInput): ModelProviderIconKey {
  const directIcon = iconFromRules(modelId, MODEL_ICON_RULES) || iconFromRules(baseUrl, BASE_URL_ICON_RULES);
  if (directIcon) return directIcon;
  if (!providerKind) return "generic";
  const providerIcon = getProviderKindLogo(providerKind);
  return providerIcon === "openai" && providerKind === "custom-openai" ? "generic" : providerIcon;
}

export function ModelProviderIcon({
  modelId,
  baseUrl,
  providerKind,
  icon,
  title,
  className,
  style,
}: ResolveModelProviderIconInput & {
  icon?: ModelProviderIconKey;
  title?: string;
  className?: string;
  style?: CSSProperties;
}) {
  const key = icon || resolveModelProviderIcon({ modelId, baseUrl, providerKind });
  const definition = ICON_DEFINITIONS[key];
  if (!definition.Icon) {
    return createElement("img", {
      src: modelGenericLogo,
      alt: "",
      title: title || definition.label,
      className: cx("brevyn-model-logo-tile object-contain p-[2px]", className),
      style,
    });
  }

  const Icon = definition.Icon;
  const iconSize = `${Math.round((definition.iconMultiple || 0.75) * 100)}%`;
  return createElement(
    "span",
    {
      className: cx("brevyn-model-logo-tile inline-flex shrink-0 items-center justify-center overflow-hidden", className),
      title: title || definition.label,
      style: {
        background: definition.background,
        color: definition.color,
        ...style,
      },
    },
    createElement(Icon, {
      "aria-hidden": true,
      focusable: false,
      size: iconSize,
      style: { flex: "none" },
    }),
  );
}

function iconFromRules(value: string | undefined, rules: Array<[RegExp, ModelProviderIconKey]>): ModelProviderIconKey | undefined {
  if (!value) return undefined;
  return rules.find(([rule]) => rule.test(value))?.[1];
}
