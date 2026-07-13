import type { UserProfileSettings } from "@/types/domain";
import { cx } from "@/lib/cn";

export interface UserAvatarOption {
  id: string;
  label: string;
  emoji: string;
  className: string;
}

export const LEGACY_USER_AVATAR_OPTIONS: UserAvatarOption[] = [
  { id: "prism", label: "灵感", emoji: "✨", className: "bg-sky-100 ring-sky-200/80" },
  { id: "spark", label: "火花", emoji: "🔥", className: "bg-amber-100 ring-amber-200/80" },
  { id: "book", label: "书页", emoji: "📚", className: "bg-stone-100 ring-stone-200/80" },
  { id: "compass", label: "罗盘", emoji: "🧭", className: "bg-cyan-100 ring-cyan-200/80" },
  { id: "landmark", label: "学院", emoji: "🏛️", className: "bg-lime-100 ring-lime-200/80" },
  { id: "moon", label: "月弧", emoji: "🌙", className: "bg-slate-100 ring-slate-200/80" },
  { id: "gem", label: "晶石", emoji: "💎", className: "bg-teal-100 ring-teal-200/80" },
  { id: "scale", label: "天平", emoji: "⚖️", className: "bg-zinc-100 ring-zinc-200/80" },
];

export const DEFAULT_USER_AVATAR = "🧑‍💻";

export function profileDisplayName(profile?: UserProfileSettings | null): string {
  return profile?.displayName?.trim() || "Brevyn User";
}

export function profileAvatarValue(profile?: UserProfileSettings | null, avatarId?: string): string {
  const raw = (avatarId || profile?.avatarId || DEFAULT_USER_AVATAR).trim();
  return LEGACY_USER_AVATAR_OPTIONS.find((option) => option.id === raw)?.emoji || raw || DEFAULT_USER_AVATAR;
}

function isImageAvatar(value: string): boolean {
  return value.startsWith("data:image/") || value.startsWith("http://") || value.startsWith("https://");
}

export function UserAvatar({
  profile,
  avatarId,
  size = "md",
  className,
}: {
  profile?: UserProfileSettings | null;
  avatarId?: string;
  size?: "sm" | "md" | "lg";
  className?: string;
}) {
  const avatar = profileAvatarValue(profile, avatarId);
  const sizeClass = size === "sm" ? "h-8 w-8" : size === "lg" ? "h-14 w-14 rounded-[20%]" : "h-9 w-9";
  const emojiClass = size === "sm" ? "text-lg" : size === "lg" ? "text-3xl" : "text-xl";

  if (isImageAvatar(avatar)) {
    return (
      <span
        className={cx(
          "inline-flex shrink-0 overflow-hidden rounded-[20%] bg-foreground/[0.04] ring-1 ring-foreground/10 shadow-sm",
          sizeClass,
          className,
        )}
        title="用户头像"
        aria-hidden="true"
      >
        <img src={avatar} alt="" className="h-full w-full object-cover" />
      </span>
    );
  }

  return (
    <span
      className={cx(
        "inline-flex shrink-0 items-center justify-center rounded-[20%] bg-foreground/[0.04] ring-1 ring-foreground/10 shadow-sm",
        sizeClass,
        className,
      )}
      title="用户头像"
      aria-hidden="true"
    >
      <span
        className={cx("leading-none", emojiClass)}
        style={{ fontFamily: "\"Apple Color Emoji\", \"Segoe UI Emoji\", \"Noto Color Emoji\", sans-serif" }}
      >
        {avatar}
      </span>
    </span>
  );
}
