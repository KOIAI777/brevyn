import data from "@emoji-mart/data";
import Picker from "@emoji-mart/react";
import { Braces, Camera, Check, ImagePlus, Languages, Monitor, Moon, Sun } from "lucide-react";
import { useEffect, useRef, useState, type CSSProperties, type ChangeEvent, type KeyboardEvent } from "react";
import { createPortal } from "react-dom";
import { Markdownish } from "@/components/chat/Markdownish";
import { ReadOnlyField } from "@/components/settings/shared/SettingsControls";
import { errorMessage } from "@/components/settings/shared/settingsErrors";
import { cx } from "@/lib/cn";
import { profileDisplayName, UserAvatar } from "@/lib/user-profile";
import type { AppCodeThemePreference, AppThemePreference, AppThemeState, UserProfileSettings } from "@/types/domain";

interface EmojiMartEmoji {
  native: string;
}

export function GeneralSettingsPage({
  profile,
  themeState,
  onProfileChange,
  onThemeStateChange,
}: {
  profile: UserProfileSettings;
  themeState: AppThemeState;
  onProfileChange: (profile: UserProfileSettings) => void;
  onThemeStateChange: (themeState: AppThemeState) => void;
}) {
  const [isEditingName, setIsEditingName] = useState(false);
  const [nameInput, setNameInput] = useState(profileDisplayName(profile));
  const [showEmojiPicker, setShowEmojiPicker] = useState(false);
  const [pickerPosition, setPickerPosition] = useState<{ top: number; left: number } | null>(null);
  const [optimisticAvatarId, setOptimisticAvatarId] = useState<string | null>(null);
  const [profileStatusLine, setProfileStatusLine] = useState("");
  const [appearanceStatusLine, setAppearanceStatusLine] = useState("");
  const avatarButtonRef = useRef<HTMLButtonElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const profileStatusTimerRef = useRef<number | null>(null);
  const appearanceStatusTimerRef = useRef<number | null>(null);
  const displayProfile = optimisticAvatarId ? { ...profile, avatarId: optimisticAvatarId } : profile;
  const selectedCodeThemeOption = CODE_THEME_OPTIONS.find((option) => option.value === themeState.codeThemePreference) ?? CODE_THEME_OPTIONS[0];
  const codeThemePreviewMode = themeState.effective === "dark" ? "dark" : "light";
  const isMacOS = /Mac|Darwin/i.test(window.navigator.platform || window.navigator.userAgent);

  useEffect(() => {
    setNameInput(profileDisplayName(profile));
  }, [profile.displayName]);

  useEffect(() => {
    if (optimisticAvatarId && profile.avatarId === optimisticAvatarId) {
      setOptimisticAvatarId(null);
    }
  }, [optimisticAvatarId, profile.avatarId]);

  useEffect(() => {
    if (!showEmojiPicker) return;

    function syncPickerPosition() {
      const rect = avatarButtonRef.current?.getBoundingClientRect();
      if (!rect) return;
      const width = 352;
      const gap = 12;
      const left = Math.min(window.innerWidth - width - 16, rect.right + gap);
      const top = Math.min(window.innerHeight - 472, Math.max(16, rect.top));
      setPickerPosition({ top, left: Math.max(16, left) });
    }

    syncPickerPosition();
    window.addEventListener("resize", syncPickerPosition);
    window.addEventListener("scroll", syncPickerPosition, true);
    return () => {
      window.removeEventListener("resize", syncPickerPosition);
      window.removeEventListener("scroll", syncPickerPosition, true);
    };
  }, [showEmojiPicker]);

  useEffect(() => {
    return () => {
      if (profileStatusTimerRef.current) window.clearTimeout(profileStatusTimerRef.current);
      if (appearanceStatusTimerRef.current) window.clearTimeout(appearanceStatusTimerRef.current);
    };
  }, []);

  function showProfileStatus(message: string, timeoutMs = 2500) {
    setProfileStatusLine(message);
    if (profileStatusTimerRef.current) window.clearTimeout(profileStatusTimerRef.current);
    profileStatusTimerRef.current = window.setTimeout(() => {
      setProfileStatusLine("");
      profileStatusTimerRef.current = null;
    }, timeoutMs);
  }

  function showAppearanceStatus(message: string, timeoutMs = 2500) {
    setAppearanceStatusLine(message);
    if (appearanceStatusTimerRef.current) window.clearTimeout(appearanceStatusTimerRef.current);
    appearanceStatusTimerRef.current = window.setTimeout(() => {
      setAppearanceStatusLine("");
      appearanceStatusTimerRef.current = null;
    }, timeoutMs);
  }

  async function updateProfile(patch: Partial<UserProfileSettings>) {
    try {
      const nextProfile = await window.brevyn.app.updateProfile(patch);
      onProfileChange(nextProfile);
      showProfileStatus("个人信息已保存。");
      return true;
    } catch (error) {
      showProfileStatus(errorMessage(error, "保存个人信息失败。"), 5000);
      return false;
    }
  }

  async function updateThemePreference(preference: AppThemePreference) {
    try {
      const nextThemeState = await window.brevyn.app.updateThemePreference(preference);
      onThemeStateChange(nextThemeState);
      showAppearanceStatus("主题已更新。");
    } catch (error) {
      showAppearanceStatus(errorMessage(error, "保存主题失败。"), 5000);
    }
  }

  async function updateCodeThemePreference(preference: AppCodeThemePreference) {
    try {
      const nextThemeState = await window.brevyn.app.updateCodeThemePreference(preference);
      onThemeStateChange(nextThemeState);
      showAppearanceStatus("代码主题已更新。");
    } catch (error) {
      showAppearanceStatus(errorMessage(error, "保存代码主题失败。"), 5000);
    }
  }

  async function updateFontSmoothing(enabled: boolean) {
    try {
      const nextThemeState = await window.brevyn.app.updateFontSmoothing(enabled);
      onThemeStateChange(nextThemeState);
      showAppearanceStatus("字体平滑已更新。");
    } catch (error) {
      showAppearanceStatus(errorMessage(error, "保存字体平滑失败。"), 5000);
    }
  }

  async function updateAvatar(avatarId: string) {
    setOptimisticAvatarId(avatarId);
    const saved = await updateProfile({ avatarId });
    if (saved) {
      setShowEmojiPicker(false);
    } else {
      setOptimisticAvatarId(null);
    }
  }

  async function saveName() {
    const displayName = nameInput.trim();
    if (!displayName) {
      showProfileStatus("昵称不能为空。", 5000);
      return;
    }
    const saved = await updateProfile({ displayName });
    if (saved) setIsEditingName(false);
  }

  function handleNameKeyDown(event: KeyboardEvent<HTMLInputElement>) {
    if (event.key === "Enter") void saveName();
    if (event.key === "Escape") {
      setNameInput(profileDisplayName(profile));
      setIsEditingName(false);
    }
  }

  function handleImageUpload(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      if (typeof reader.result === "string") void updateAvatar(reader.result);
    };
    reader.readAsDataURL(file);
    event.target.value = "";
  }

  return (
    <div className="space-y-5">
      <section className="brevyn-panel-surface p-4">
        <div className="mb-4">
          <div className="text-sm font-semibold text-foreground">用户档案</div>
          <div className="mt-1 text-[11px] leading-5 text-muted-foreground">设置你的头像和显示名称。</div>
        </div>

        <div className="brevyn-card-surface flex items-center gap-5 bg-background px-4 py-4">
          <div className="relative">
            <button
              ref={avatarButtonRef}
              type="button"
              className="group/avatar relative block rounded-[20%] outline-none"
              onClick={() => setShowEmojiPicker((visible) => {
                const nextVisible = !visible;
                if (nextVisible) {
                  const rect = avatarButtonRef.current?.getBoundingClientRect();
                  if (rect) {
                    const width = 352;
                    const gap = 12;
                    setPickerPosition({
                      top: Math.min(window.innerHeight - 472, Math.max(16, rect.top)),
                      left: Math.max(16, Math.min(window.innerWidth - width - 16, rect.right + gap)),
                    });
                  }
                }
                return nextVisible;
              })}
              title="更换头像"
            >
              <UserAvatar profile={displayProfile} size="lg" />
              <span className="absolute inset-0 flex items-center justify-center rounded-[20%] bg-black/40 opacity-0 transition-opacity group-hover/avatar:opacity-100">
                <Camera className="h-5 w-5 text-white" />
              </span>
            </button>

            {showEmojiPicker && pickerPosition && createPortal(
              <>
                <button
                  type="button"
                  className="fixed inset-0 z-[80] cursor-default"
                  aria-label="关闭头像选择"
                  onClick={() => setShowEmojiPicker(false)}
                />
                <div
                  className="fixed z-[90] w-[352px] overflow-hidden rounded-[var(--radius-panel)] bg-card shadow-2xl ring-1 ring-black/[0.08] animate-in fade-in-0 zoom-in-95 duration-150"
                  style={{ left: pickerPosition.left, top: pickerPosition.top }}
                >
                  <Picker
                    data={data}
                    onEmojiSelect={(emoji: EmojiMartEmoji) => void updateAvatar(emoji.native)}
                    locale="zh"
                    theme="auto"
                    previewPosition="none"
                    skinTonePosition="search"
                    perLine={8}
                  />
                  <div className="border-t border-border/45 bg-card px-3 py-2">
                    <button
                      type="button"
                      className="flex w-full items-center justify-center gap-1.5 rounded-[var(--radius-control)] px-3 py-2 text-[13px] font-medium text-muted-foreground transition hover:bg-accent hover:text-foreground active:scale-[0.98]"
                      onClick={() => fileInputRef.current?.click()}
                    >
                      <ImagePlus className="h-4 w-4" />
                      上传自定义图片
                    </button>
                    <input
                      ref={fileInputRef}
                      type="file"
                      accept="image/png,image/jpeg,image/gif,image/webp"
                      className="hidden"
                      onChange={handleImageUpload}
                    />
                  </div>
                </div>
              </>,
              document.body,
            )}
          </div>

          <div className="min-w-0 flex-1">
            {isEditingName ? (
              <input
                type="text"
                value={nameInput}
                onChange={(event) => setNameInput(event.target.value)}
                onBlur={() => void saveName()}
                onKeyDown={handleNameKeyDown}
                maxLength={40}
                autoFocus
                className="w-full max-w-[240px] border-b-2 border-primary bg-transparent pb-0.5 text-lg font-semibold text-foreground outline-none"
              />
            ) : (
              <button
                type="button"
                className="block truncate text-left text-lg font-semibold text-foreground transition hover:text-primary"
                onClick={() => {
                  setNameInput(profileDisplayName(profile));
                  setIsEditingName(true);
                }}
              >
                {profileDisplayName(profile)}
              </button>
            )}
            <div className="mt-0.5 text-[12px] text-muted-foreground/70">点击头像更换，点击名字编辑</div>
          </div>
        </div>

        {profileStatusLine && (
          <div className={cx("mt-3 text-[11px] font-medium", profileStatusLine.includes("失败") || profileStatusLine.includes("不能为空") ? "text-destructive" : "text-emerald-700")}>
            {profileStatusLine}
          </div>
        )}
      </section>

      <section className="brevyn-panel-surface p-4">
        <div className="mb-4 flex items-start gap-3">
          <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-[var(--radius-card)] bg-primary/10 text-primary">
            <Monitor className="h-4 w-4" />
          </div>
          <div className="min-w-0">
            <div className="text-sm font-semibold text-foreground">个性化</div>
            <div className="mt-1 text-[11px] leading-5 text-muted-foreground">设置应用主题和代码阅读样式。</div>
          </div>
        </div>

        <div className="rounded-[var(--radius-card)] bg-background p-3 shadow-[inset_0_0_0_1px_hsl(var(--border)/0.42)]">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="min-w-0">
              <div className="text-xs font-semibold text-foreground">主题</div>
              <div className="mt-1 text-[11px] leading-5 text-muted-foreground">
                {themeState.preference === "system" ? `跟随系统，当前为${themeState.effective === "dark" ? "深色" : "浅色"}` : "手动固定应用外观"}
              </div>
            </div>
            <div className="inline-flex shrink-0 rounded-[var(--radius-control)] bg-card p-1 shadow-inner ring-1 ring-black/[0.04]">
              {THEME_OPTIONS.map((option) => {
                const selected = themeState.preference === option.value;
                return (
                  <button
                    key={option.value}
                    type="button"
                    className={cx(
                      "inline-flex h-8 min-w-[5.5rem] items-center justify-center gap-1.5 rounded-[var(--radius-badge)] px-3 text-[11px] font-semibold transition active:scale-[0.98]",
                      selected ? "bg-foreground text-background shadow-sm" : "text-muted-foreground hover:bg-background hover:text-foreground",
                    )}
                    title={option.description}
                    onClick={() => void updateThemePreference(option.value)}
                  >
                    <option.icon className="h-3.5 w-3.5" />
                    {option.label}
                  </button>
                );
              })}
            </div>
          </div>
        </div>

        {isMacOS && (
          <div className="mt-3 rounded-[var(--radius-card)] bg-background p-3 shadow-[inset_0_0_0_1px_hsl(var(--border)/0.42)]">
            <div className="flex items-center justify-between gap-3">
              <div className="min-w-0">
                <div className="text-xs font-semibold text-foreground">字体平滑</div>
                <div className="mt-1 text-[11px] leading-5 text-muted-foreground">使用 macOS 原生字体抗锯齿</div>
              </div>
              <button
                type="button"
                role="switch"
                aria-checked={themeState.fontSmoothingEnabled}
                className={cx(
                  "relative h-7 w-12 shrink-0 rounded-full p-0.5 transition active:scale-[0.98]",
                  themeState.fontSmoothingEnabled ? "bg-primary shadow-[0_0_0_1px_hsl(var(--primary)/0.24)]" : "bg-muted shadow-[inset_0_0_0_1px_hsl(var(--border)/0.52)]",
                )}
                onClick={() => void updateFontSmoothing(!themeState.fontSmoothingEnabled)}
              >
                <span
                  className={cx(
                    "block h-6 w-6 rounded-full bg-white shadow-sm transition-transform",
                    themeState.fontSmoothingEnabled ? "translate-x-5" : "translate-x-0",
                  )}
                />
              </button>
            </div>
          </div>
        )}

        <div className="mt-3 rounded-[var(--radius-card)] bg-background p-3 shadow-[inset_0_0_0_1px_hsl(var(--border)/0.42)]">
          <div className="flex items-center justify-between gap-3">
            <div className="min-w-0">
              <div className="text-xs font-semibold text-foreground">代码主题</div>
              <div className="mt-1 text-[11px] leading-5 text-muted-foreground">预览对话里的命令、路径和代码块样式，不改变应用整体主题。</div>
            </div>
            <Braces className="h-4 w-4 shrink-0 text-muted-foreground/70" />
          </div>

          <div className="mt-3 rounded-[var(--radius-card)] bg-card px-3 py-2.5 shadow-[inset_0_0_0_1px_hsl(var(--border)/0.42)]">
            <div className="flex flex-wrap items-center justify-between gap-2 text-[10px] font-semibold text-muted-foreground">
              <span>真实渲染预览</span>
              <span>{selectedCodeThemeOption.label}</span>
            </div>
            <div className="mt-2">
              <Markdownish content={CODE_THEME_MARKDOWN_PREVIEW} />
            </div>
          </div>

          <div className="mt-3 flex flex-wrap gap-2">
            {CODE_THEME_OPTIONS.map((option) => {
              const selected = themeState.codeThemePreference === option.value;
              return (
                <button
                  key={option.value}
                  type="button"
                  className={cx(
                    "group flex min-h-10 items-center gap-2 rounded-[var(--radius-control)] px-2.5 py-2 text-left text-xs transition active:scale-[0.99]",
                    selected ? "bg-primary/10 text-foreground shadow-[inset_0_0_0_1px_hsl(var(--primary)/0.38)]" : "bg-card text-muted-foreground shadow-[inset_0_0_0_1px_hsl(var(--border)/0.46)] hover:bg-accent hover:text-foreground",
                  )}
                  style={option.previewStyle[codeThemePreviewMode]}
                  onClick={() => void updateCodeThemePreference(option.value)}
                >
                  <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-[9px] bg-[var(--code-bg)] font-mono text-[12px] font-semibold text-[var(--code-inline-fg)] shadow-[inset_0_0_0_1px_var(--code-border)]">
                    Aa
                  </span>
                  <span className="min-w-0">
                    <span className="block whitespace-nowrap font-semibold">{option.label}</span>
                    <span className="block whitespace-nowrap text-[10px] text-muted-foreground">{option.description}</span>
                  </span>
                  {selected && <Check className="ml-auto h-3.5 w-3.5 shrink-0 text-foreground/70" />}
                </button>
              );
            })}
          </div>
        </div>

        {appearanceStatusLine && (
          <div className={cx("mt-3 text-[11px] font-medium", appearanceStatusLine.includes("失败") ? "text-destructive" : "text-emerald-700")}>
            {appearanceStatusLine}
          </div>
        )}
      </section>

      <section className="brevyn-panel-surface p-4">
        <div className="mb-4 flex items-start gap-3">
          <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-[var(--radius-card)] bg-primary/10 text-primary">
            <Languages className="h-4 w-4" />
          </div>
          <div className="min-w-0">
            <div className="text-sm font-semibold text-foreground">通用设置</div>
            <div className="mt-1 text-[11px] leading-5 text-muted-foreground">语言和基础行为设置放在这里。</div>
          </div>
        </div>

        <div className="grid gap-2 md:grid-cols-2">
          <ReadOnlyField label="语言" value="中文" />
          <ReadOnlyField label="状态" value="占位，暂不切换界面语言" />
        </div>
      </section>
    </div>
  );
}

const THEME_OPTIONS: Array<{
  value: AppThemePreference;
  label: string;
  description: string;
  icon: typeof Monitor;
}> = [
  {
    value: "system",
    label: "跟随系统",
    description: "随系统自动切换",
    icon: Monitor,
  },
  {
    value: "light",
    label: "浅色",
    description: "固定暖白界面",
    icon: Sun,
  },
  {
    value: "dark",
    label: "深色",
    description: "固定黑色界面",
    icon: Moon,
  },
];

const CODE_THEME_MARKDOWN_PREVIEW = [
  "行内命令示例：`open index.html`，文件路径示例：`src/renderer/App.tsx`。",
  "",
  "```ts",
  "const themePreview = {",
  '  surface: "code",',
  '  accent: "current-theme",',
  "  readable: true,",
  "};",
  "",
  "export function applyPreview(theme: typeof themePreview) {",
  "  return theme.readable ? theme.accent : null;",
  "}",
  "```",
].join("\n");

const CODE_THEME_OPTIONS: Array<{
  value: AppCodeThemePreference;
  label: string;
  description: string;
  accentPreview: string;
  previewStyle: Record<"light" | "dark", CSSProperties>;
}> = [
  {
    value: "brevyn",
    label: "Brevyn 暖调",
    description: "默认阅读样式，和当前界面最统一",
    accentPreview: "#c87552",
    previewStyle: {
      light: {
        "--code-bg": "#f6efe6",
        "--code-fg": "#2d261f",
        "--code-inline-bg": "rgba(151, 104, 70, 0.115)",
        "--code-inline-fg": "#7a3f24",
        "--code-muted": "#8f7a66",
        "--code-border": "rgba(130, 98, 68, 0.18)",
        "--code-shadow": "inset 0 1px 0 rgba(255, 255, 255, 0.45), 0 14px 34px -28px rgba(85, 57, 32, 0.34)",
      } as CSSProperties,
      dark: {
        "--code-bg": "#171412",
        "--code-fg": "#efe4d7",
        "--code-inline-bg": "rgba(238, 168, 117, 0.13)",
        "--code-inline-fg": "#f0b88e",
        "--code-muted": "#a99380",
        "--code-border": "rgba(255, 232, 204, 0.105)",
        "--code-shadow": "inset 0 1px 0 rgba(255, 255, 255, 0.035), 0 18px 40px -32px rgba(0, 0, 0, 0.72)",
      } as CSSProperties,
    },
  },
  {
    value: "github",
    label: "清爽亮色",
    description: "对比更高，适合白天看代码",
    accentPreview: "#0969da",
    previewStyle: {
      light: {
        "--code-bg": "#f7f9fc",
        "--code-fg": "#24292f",
        "--code-inline-bg": "rgba(9, 105, 218, 0.09)",
        "--code-inline-fg": "#0969da",
        "--code-muted": "#6e7781",
        "--code-border": "rgba(36, 41, 47, 0.13)",
        "--code-shadow": "inset 0 1px 0 rgba(255, 255, 255, 0.66), 0 14px 30px -28px rgba(31, 43, 59, 0.3)",
      } as CSSProperties,
      dark: {
        "--code-bg": "#0d1117",
        "--code-fg": "#e6edf3",
        "--code-inline-bg": "rgba(56, 139, 253, 0.14)",
        "--code-inline-fg": "#79c0ff",
        "--code-muted": "#7d8590",
        "--code-border": "rgba(240, 246, 252, 0.12)",
        "--code-shadow": "inset 0 1px 0 rgba(255, 255, 255, 0.045), 0 18px 44px -34px rgba(0, 0, 0, 0.76)",
      } as CSSProperties,
    },
  },
  {
    value: "rose",
    label: "Rose Pine",
    description: "柔和暗色，长代码更耐看",
    accentPreview: "#c4a7e7",
    previewStyle: {
      light: {
        "--code-bg": "#faf4ed",
        "--code-fg": "#575279",
        "--code-inline-bg": "rgba(144, 122, 169, 0.13)",
        "--code-inline-fg": "#907aa9",
        "--code-muted": "#9893a5",
        "--code-border": "rgba(87, 82, 121, 0.15)",
        "--code-shadow": "inset 0 1px 0 rgba(255, 255, 255, 0.58), 0 14px 34px -28px rgba(87, 82, 121, 0.32)",
      } as CSSProperties,
      dark: {
        "--code-bg": "#191724",
        "--code-fg": "#e0def4",
        "--code-inline-bg": "rgba(196, 167, 231, 0.14)",
        "--code-inline-fg": "#c4a7e7",
        "--code-muted": "#908caa",
        "--code-border": "rgba(224, 222, 244, 0.12)",
        "--code-shadow": "inset 0 1px 0 rgba(255, 255, 255, 0.045), 0 18px 44px -34px rgba(0, 0, 0, 0.76)",
      } as CSSProperties,
    },
  },
  {
    value: "mono",
    label: "极简灰阶",
    description: "弱化色彩，突出结构和文本",
    accentPreview: "#8f8a83",
    previewStyle: {
      light: {
        "--code-bg": "#f2f1ee",
        "--code-fg": "#282624",
        "--code-inline-bg": "rgba(42, 39, 35, 0.08)",
        "--code-inline-fg": "#36322e",
        "--code-muted": "#77716a",
        "--code-border": "rgba(43, 39, 35, 0.14)",
        "--code-shadow": "inset 0 1px 0 rgba(255, 255, 255, 0.62), 0 12px 28px -28px rgba(34, 31, 28, 0.34)",
      } as CSSProperties,
      dark: {
        "--code-bg": "#121212",
        "--code-fg": "#e7e2db",
        "--code-inline-bg": "rgba(235, 229, 220, 0.09)",
        "--code-inline-fg": "#e7e2db",
        "--code-muted": "#948f88",
        "--code-border": "rgba(235, 229, 220, 0.11)",
        "--code-shadow": "inset 0 1px 0 rgba(255, 255, 255, 0.035), 0 18px 42px -34px rgba(0, 0, 0, 0.76)",
      } as CSSProperties,
    },
  },
];
