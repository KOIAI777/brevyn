import { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Copy, ExternalLink, FileText, FolderOpen, Pencil, RefreshCw, Trash2 } from "lucide-react";
import type { WorkspaceFileNode } from "@/types/domain";
import { cx } from "@/lib/cn";

export type FileContextMenuState = {
  file: WorkspaceFileNode;
  anchor: {
    left: number;
    right: number;
    top: number;
    bottom: number;
  };
};

export type FileContextMenuAction = "open" | "reveal" | "copyPath" | "copyName" | "previewParsed" | "retryIndex" | "rename" | "delete";

export function FileContextMenu({
  state,
  onAction,
  onClose,
}: {
  state: FileContextMenuState | null;
  onAction: (action: FileContextMenuAction, file: WorkspaceFileNode) => void;
  onClose: () => void;
}) {
  const menuRef = useRef<HTMLDivElement>(null);
  const [position, setPosition] = useState({ left: state?.anchor.right || 0, top: state?.anchor.top || 0 });

  useEffect(() => {
    if (!state) return;
    const frame = window.requestAnimationFrame(() => {
      const rect = menuRef.current?.getBoundingClientRect();
      const width = rect?.width || 190;
      const height = rect?.height || 220;
      const preferredLeft = state.anchor.left + 2;
      const fallbackLeft = state.anchor.left - width - 6;
      const preferredTop = state.anchor.top + 2;
      const left = preferredLeft + width <= window.innerWidth - 8 ? preferredLeft : fallbackLeft;
      setPosition({
        left: Math.max(8, Math.min(left, window.innerWidth - width - 8)),
        top: Math.max(8, Math.min(preferredTop, window.innerHeight - height - 8)),
      });
    });
    return () => window.cancelAnimationFrame(frame);
  }, [state]);

  useEffect(() => {
    if (!state) return;
    function close() {
      onClose();
    }
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") onClose();
    }
    window.addEventListener("pointerdown", close);
    window.addEventListener("resize", close);
    window.addEventListener("keydown", onKeyDown);
    return () => {
      window.removeEventListener("pointerdown", close);
      window.removeEventListener("resize", close);
      window.removeEventListener("keydown", onKeyDown);
    };
  }, [onClose, state]);

  const items = useMemo(() => {
    if (!state) return [];
    const mutable = Boolean(state.file.sourcePath);
    const canOpenOrReveal = Boolean(state.file.sourcePath || state.file.kind === "folder");
    const canRetryIndex = mutable && state.file.kind !== "folder" && shouldOfferIndexRetry(state.file);
    return [
      { action: "open" as const, label: "打开", icon: ExternalLink, disabled: !canOpenOrReveal },
      { action: "reveal" as const, label: "在访达中显示", icon: FolderOpen, disabled: !canOpenOrReveal },
      { action: "copyPath" as const, label: "复制路径", icon: Copy, disabled: false },
      { action: "copyName" as const, label: "复制名称", icon: Copy, disabled: false },
      { action: "previewParsed" as const, label: "查看解析文本", icon: FileText, disabled: !mutable || state.file.kind === "folder" },
      ...(canRetryIndex ? [{ action: "retryIndex" as const, label: "重新索引此文件", icon: RefreshCw, disabled: false }] : []),
      { action: "rename" as const, label: "重命名", icon: Pencil, disabled: !mutable },
      { action: "delete" as const, label: "删除", icon: Trash2, disabled: !mutable, danger: true },
    ];
  }, [state]);

  if (!state) return null;

  return createPortal(
    <div
      ref={menuRef}
      className="fixed z-[80] w-52 overflow-hidden rounded-xl border border-border/70 bg-card/95 p-1.5 text-xs shadow-xl ring-1 ring-border/60 backdrop-blur-xl"
      style={{ left: position.left, top: position.top }}
      onPointerDown={(event) => event.stopPropagation()}
      onContextMenu={(event) => event.preventDefault()}
    >
      <div className="border-b border-border/60 px-2 py-1.5">
        <div className="truncate text-[11px] font-medium text-foreground" title={state.file.name}>
          {fileDisplayName(state.file)}
        </div>
        <div className="truncate text-[10px] text-muted-foreground" title={state.file.sourcePath || state.file.path}>
          {state.file.kind === "folder" ? "文件夹" : "文件"}
        </div>
      </div>
      <div className="py-1">
        {items.map((item) => {
          const Icon = item.icon;
          return (
            <button
              key={item.action}
              type="button"
              className={cx(
                "flex h-8 w-full items-center gap-2 rounded-lg px-2 text-left transition",
                item.disabled
                  ? "cursor-not-allowed text-muted-foreground/45"
                  : item.danger
                    ? "text-red-600 hover:bg-red-50"
                    : "text-muted-foreground hover:bg-accent hover:text-foreground",
              )}
              disabled={item.disabled}
              onClick={() => {
                onAction(item.action, state.file);
                onClose();
              }}
            >
              <Icon className="h-3.5 w-3.5 shrink-0" />
              <span className="min-w-0 flex-1 truncate">{item.label}</span>
            </button>
          );
        })}
      </div>
    </div>,
    document.body,
  );
}

export function fileDisplayName(node: WorkspaceFileNode): string {
  if (node.displayName) return node.displayName;
  const managedName = managedFolderDisplayName(node.name);
  if (managedName) return managedName;
  if (node.kind === "folder" && node.sectionKind === "task" && node.taskId) {
    const prefix = `${node.taskId}__`;
    if (node.name.startsWith(prefix)) return node.name.slice(prefix.length) || node.name;
  }
  return node.name;
}

function managedFolderDisplayName(name: string): string {
  if (name === "Semester shared") return "学期资料";
  if (name === "Course shared") return "课程共享";
  if (name === "Lecture") return "课件";
  if (name === "Task") return "任务";
  if (name === "Materials") return "材料";
  if (name === "Drafts") return "草稿";
  if (name === "Submitted") return "已提交";
  return "";
}

function shouldOfferIndexRetry(file: WorkspaceFileNode): boolean {
  if (!isRagEligibleFile(file)) return false;
  const status = file.indexingStatus || "idle";
  return status === "failed" || status === "partial" || status === "warning" || status === "skipped" || status === "cancelled" || status === "idle";
}

function isRagEligibleFile(file: WorkspaceFileNode): boolean {
  if (file.ragEligible === true) return true;
  if (file.ragEligible === false) return false;
  return Boolean(file.indexedAt || (file.indexingStatus && file.indexingStatus !== "idle"));
}
