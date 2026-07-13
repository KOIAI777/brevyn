import { AlertCircle, AlertTriangle, CheckCircle2, X } from "lucide-react";
import { createPortal } from "react-dom";
import { useCallback, useEffect, useId, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type ReactNode } from "react";
import { cx } from "@/lib/cn";

export type ConfirmRequest = {
  title: string;
  message?: ReactNode;
  confirmLabel?: string;
  cancelLabel?: string;
  tone?: "default" | "danger" | "success";
};

export function useConfirmDialog() {
  const resolveRef = useRef<((value: boolean) => void) | null>(null);
  const [request, setRequest] = useState<ConfirmRequest | null>(null);

  const settle = useCallback((value: boolean) => {
    resolveRef.current?.(value);
    resolveRef.current = null;
    setRequest(null);
  }, []);

  const confirm = useCallback((options: ConfirmRequest) => {
    if (resolveRef.current) {
      resolveRef.current(false);
      resolveRef.current = null;
    }
    return new Promise<boolean>((resolve) => {
      resolveRef.current = resolve;
      setRequest(options);
    });
  }, []);

  useEffect(
    () => () => {
      resolveRef.current?.(false);
      resolveRef.current = null;
    },
    [],
  );

  return {
    confirm,
    confirmDialog: request ? <ConfirmDialog request={request} onResolve={settle} /> : null,
  };
}

function ConfirmDialog({ request, onResolve }: { request: ConfirmRequest; onResolve: (value: boolean) => void }) {
  const dialogRef = useRef<HTMLDivElement>(null);
  const confirmButtonRef = useRef<HTMLButtonElement>(null);
  const cancelButtonRef = useRef<HTMLButtonElement>(null);
  const [mounted, setMounted] = useState(false);
  const titleId = useId();
  const messageId = useId();

  useEffect(() => {
    setMounted(true);
    const frame = window.requestAnimationFrame(() => {
      if (request.tone === "danger") {
        cancelButtonRef.current?.focus();
      } else {
        confirmButtonRef.current?.focus();
      }
    });
    return () => window.cancelAnimationFrame(frame);
  }, [request]);

  useEffect(() => {
    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") {
        event.preventDefault();
        onResolve(false);
      }
    }
    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [onResolve]);

  const isDanger = request.tone === "danger";
  const isSuccess = request.tone === "success";
  const Icon = isDanger ? AlertTriangle : isSuccess ? CheckCircle2 : AlertCircle;

  function handleDialogKeyDown(event: ReactKeyboardEvent<HTMLDivElement>) {
    if (event.key !== "Tab") return;
    const focusable = focusableElements(dialogRef.current);
    if (focusable.length === 0) return;
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    const active = document.activeElement;
    if (event.shiftKey && active === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && active === last) {
      event.preventDefault();
      first.focus();
    }
  }

  return createPortal(
    <div
      className="fixed inset-0 z-[90] flex items-center justify-center bg-foreground/[0.18] p-6 backdrop-blur-sm"
      onMouseDown={() => onResolve(false)}
      role="presentation"
    >
      <div
        ref={dialogRef}
        role={isDanger ? "alertdialog" : "dialog"}
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={request.message ? messageId : undefined}
        className={cx(
          "brevyn-floating-surface w-full max-w-[28rem] overflow-hidden rounded-3xl text-foreground transition duration-150 ease-out",
          mounted ? "translate-y-0 scale-100 opacity-100" : "translate-y-2 scale-[0.98] opacity-0",
        )}
        onMouseDown={(event) => event.stopPropagation()}
        onKeyDown={handleDialogKeyDown}
      >
        <div className="flex items-start justify-between gap-4 px-5 pb-3 pt-5">
          <div className="flex min-w-0 items-start gap-3">
            <span
              className={cx(
                "mt-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-xl border",
                isDanger
                  ? "border-red-200 bg-red-50 text-red-600"
                  : isSuccess
                    ? "border-emerald-200/80 bg-emerald-50 text-emerald-700 dark:border-emerald-500/25 dark:bg-emerald-400/10 dark:text-emerald-300"
                    : "border-border bg-muted text-muted-foreground",
              )}
            >
              <Icon className="h-4 w-4" />
            </span>
            <div className="min-w-0">
              <div id={titleId} className="text-sm font-semibold leading-6">
                {request.title}
              </div>
              {request.message && (
                <div id={messageId} className="mt-1.5 text-[12px] leading-5 text-muted-foreground">
                  {request.message}
                </div>
              )}
            </div>
          </div>
          <button
            type="button"
            className="brevyn-soft-button flex h-8 w-8 shrink-0 items-center justify-center rounded-xl text-muted-foreground transition hover:text-foreground"
            onClick={() => onResolve(false)}
            title="关闭"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        {isDanger && (
          <div className="mx-5 rounded-xl border border-red-100 bg-red-50/70 px-3 py-2 text-[11px] leading-5 text-red-700">
            这个操作可能无法撤销，请确认目标无误后再继续。
          </div>
        )}

        <div className="px-5 py-4">
          <div className="flex items-center justify-end gap-2.5">
            <button
              type="button"
              ref={cancelButtonRef}
              className="brevyn-soft-button inline-flex h-8 items-center rounded-xl px-3 text-xs font-medium text-muted-foreground transition hover:text-foreground"
              onClick={() => onResolve(false)}
            >
              {request.cancelLabel || "取消"}
            </button>
            <button
              type="button"
              ref={confirmButtonRef}
              className={cx(
                "inline-flex h-8 items-center rounded-xl px-3 text-xs font-medium transition",
                isDanger ? "bg-red-600 text-white shadow-sm hover:bg-red-700 focus-visible:ring-red-500/30" : "brevyn-primary-button",
              )}
              onClick={() => onResolve(true)}
            >
              {request.confirmLabel || "确认"}
            </button>
          </div>
        </div>
      </div>
    </div>,
    document.body,
  );
}

function focusableElements(root: HTMLElement | null): HTMLElement[] {
  if (!root) return [];
  return Array.from(
    root.querySelectorAll<HTMLElement>(
      'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
    ),
  ).filter((element) => !element.hasAttribute("disabled") && element.tabIndex !== -1);
}
