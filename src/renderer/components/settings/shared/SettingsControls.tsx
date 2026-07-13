import { Eye, EyeOff, ToggleLeft, ToggleRight } from "lucide-react";
import { useState, type ReactNode } from "react";
import { cx } from "@/lib/cn";

export function Field({
  label,
  value,
  onChange,
  type = "text",
  placeholder,
  icon,
  disabled,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  type?: string;
  placeholder?: string;
  icon?: ReactNode;
  disabled?: boolean;
}) {
  const [passwordVisible, setPasswordVisible] = useState(false);
  const isPassword = type === "password";
  const inputType = isPassword && passwordVisible ? "text" : type;

  return (
    <label className="space-y-1 text-[11px] text-muted-foreground">
      <span>{label}</span>
      <div className="brevyn-control-surface flex h-9 items-center gap-1 px-2.5">
        {icon}
        <input
          className="min-w-0 flex-1 bg-transparent text-xs text-foreground outline-none placeholder:text-muted-foreground/55 disabled:cursor-not-allowed disabled:text-muted-foreground"
          type={inputType}
          value={value}
          placeholder={placeholder}
          disabled={disabled}
          onChange={(event) => onChange(event.target.value)}
        />
        {isPassword && (
          <button
            type="button"
            className="flex h-6 w-6 shrink-0 items-center justify-center rounded-[var(--radius-badge)] text-muted-foreground transition hover:bg-card hover:text-foreground"
            onClick={() => setPasswordVisible((visible) => !visible)}
            disabled={disabled}
            aria-label={passwordVisible ? `隐藏${label}` : `显示${label}`}
            title={passwordVisible ? `隐藏${label}` : `显示${label}`}
          >
            {passwordVisible ? <EyeOff className="h-3.5 w-3.5" /> : <Eye className="h-3.5 w-3.5" />}
          </button>
        )}
      </div>
    </label>
  );
}

export function ReadOnlyField({ label, value }: { label: string; value: string }) {
  return (
    <label className="space-y-1 text-[11px] text-muted-foreground">
      <span>{label}</span>
      <div className="brevyn-control-surface flex h-9 items-center px-2.5 text-xs text-foreground">{value}</div>
    </label>
  );
}

export function AccountAuthStep({ icon, label }: { icon: ReactNode; label: string }) {
  return (
    <div className="flex items-center gap-2 rounded-[var(--radius-control)] bg-background px-2.5 py-2 text-[11px] text-muted-foreground shadow-[inset_0_0_0_1px_hsl(var(--border)/0.45)]">
      <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-[var(--radius-badge)] bg-muted text-muted-foreground">
        {icon}
      </span>
      <span className="font-medium text-foreground/80">{label}</span>
    </div>
  );
}

export function MiniMetric({ label, value }: { label: string; value: string }) {
  return (
    <div className="brevyn-control-surface min-w-0 px-2.5 py-2">
      <div className="text-[9px] text-muted-foreground">{label}</div>
      <div className="mt-0.5 truncate text-xs font-medium text-foreground" title={value}>{value}</div>
    </div>
  );
}

export function TogglePill({
  enabled,
  onClick,
  labelOn = "已启用",
  labelOff = "已停用",
  disabled,
}: {
  enabled: boolean;
  onClick: () => void;
  labelOn?: string;
  labelOff?: string;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      className={cx(
        "inline-flex h-8 shrink-0 items-center gap-1.5 rounded-[var(--radius-control)] px-2.5 text-[11px] font-medium shadow-sm ring-1 ring-black/[0.035] disabled:cursor-not-allowed disabled:opacity-45",
        enabled
          ? "bg-[hsl(var(--status-success)/0.14)] text-[hsl(var(--status-success))] ring-[hsl(var(--status-success)/0.2)]"
          : "bg-card text-muted-foreground hover:bg-accent hover:text-foreground",
      )}
      disabled={disabled}
      onClick={(event) => {
        event.stopPropagation();
        onClick();
      }}
    >
      {enabled ? <ToggleRight className="h-4 w-4" /> : <ToggleLeft className="h-4 w-4" />}
      {enabled ? labelOn : labelOff}
    </button>
  );
}

export function ActionButton({
  icon,
  label,
  onClick,
  primary,
  disabled,
  className,
}: {
  icon: ReactNode;
  label: string;
  onClick: () => void;
  primary?: boolean;
  disabled?: boolean;
  className?: string;
}) {
  return (
    <button
      type="button"
      className={cx(
        "inline-flex h-8 items-center gap-1.5 rounded-[var(--radius-control)] px-3 text-xs font-semibold shadow-sm transition active:scale-[0.98] disabled:cursor-not-allowed disabled:opacity-45",
        primary ? "bg-primary text-primary-foreground shadow-[0_10px_22px_rgba(37,99,235,0.16)]" : "bg-card text-muted-foreground ring-1 ring-black/[0.035] hover:bg-accent hover:text-foreground",
        className,
      )}
      disabled={disabled}
      onClick={onClick}
    >
      {icon}
      {label}
    </button>
  );
}

export function IconActionButton({
  icon,
  label,
  onClick,
  disabled,
  danger,
}: {
  icon: ReactNode;
  label: string;
  onClick: () => void;
  disabled?: boolean;
  danger?: boolean;
}) {
  return (
    <button
      type="button"
      className={cx(
        "inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-[var(--radius-control)] bg-card text-muted-foreground shadow-sm ring-1 ring-black/[0.035] transition active:scale-[0.98] disabled:cursor-not-allowed disabled:opacity-45",
        danger ? "hover:bg-red-50 hover:text-red-700 hover:ring-red-200/70" : "hover:bg-accent hover:text-foreground",
      )}
      disabled={disabled}
      onClick={onClick}
      title={label}
      aria-label={label}
    >
      {icon}
    </button>
  );
}
