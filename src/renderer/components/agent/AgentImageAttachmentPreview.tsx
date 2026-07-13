import { useEffect, useMemo, useState } from "react";
import { ImageIcon, X } from "lucide-react";
import type { AgentAttachment } from "@/types/domain";
import { getPendingAttachmentData } from "@/components/agent/pendingAttachmentData";

type ImageAttachmentPreviewVariant = "composer" | "message";

export function isAgentImageAttachment(attachment: AgentAttachment): boolean {
  if (attachment.kind === "image") return true;
  if (attachment.mimeType?.startsWith("image/")) return true;
  return /\.(png|jpe?g|webp|gif|bmp|svg)$/i.test(attachment.name || attachment.path);
}

export function AgentImageAttachmentPreview({
  attachment,
  variant = "message",
  removable = false,
  onRemove,
  onOpen,
}: {
  attachment: AgentAttachment;
  variant?: ImageAttachmentPreviewVariant;
  removable?: boolean;
  onRemove?: () => void;
  onOpen?: () => void | Promise<void>;
}) {
  const [previewUrl, setPreviewUrl] = useState("");
  const [failed, setFailed] = useState(false);
  const label = attachment.name || "图片附件";
  const sizeClass = variant === "composer" ? "h-20 w-20" : "h-24 w-32 sm:h-28 sm:w-40";
  const roundedClass = variant === "composer" ? "rounded-[1.05rem]" : "rounded-[1rem]";
  const pendingDataUrl = useMemo(() => {
    const data = attachment.pending ? getPendingAttachmentData(attachment.id) : undefined;
    if (!data) return "";
    return `data:${attachment.mimeType || "image/png"};base64,${data}`;
  }, [attachment.id, attachment.mimeType, attachment.pending]);

  useEffect(() => {
    let cancelled = false;
    setFailed(false);
    setPreviewUrl("");

    if (pendingDataUrl) {
      setPreviewUrl(pendingDataUrl);
      return () => {
        cancelled = true;
      };
    }

    const sourcePath = attachment.sourcePath || attachment.path;
    if (!sourcePath) {
      setFailed(true);
      return () => {
        cancelled = true;
      };
    }

    void window.brevyn.vision.previewImage(sourcePath)
      .then((url) => {
        if (!cancelled) setPreviewUrl(url);
      })
      .catch((error) => {
        console.warn("[AgentImageAttachmentPreview] Failed to load image preview:", error);
        if (!cancelled) setFailed(true);
      });

    return () => {
      cancelled = true;
    };
  }, [attachment.path, attachment.sourcePath, pendingDataUrl]);

  async function handleOpen() {
    if (!onOpen) return;
    await onOpen();
  }

  return (
    <div className={`group/image relative ${sizeClass} shrink-0 overflow-hidden ${roundedClass} border border-border/70 bg-background/72 shadow-sm ring-1 ring-background/40`}>
      <button
        type="button"
        className={`block h-full w-full overflow-hidden bg-black/[0.03] text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50 ${onOpen ? "cursor-pointer" : "cursor-default"}`}
        title={attachment.path}
        onClick={() => void handleOpen()}
        aria-disabled={!onOpen}
      >
        {previewUrl && !failed ? (
          <img
            src={previewUrl}
            alt={label}
            className="h-full w-full object-contain"
            draggable={false}
            loading="lazy"
          />
        ) : (
          <div className="flex h-full w-full flex-col items-center justify-center gap-1.5 bg-muted/42 px-2 text-center text-muted-foreground">
            <ImageIcon className="h-5 w-5" />
            <span className="line-clamp-2 text-[10px] leading-3">{failed ? "无法预览" : "加载中"}</span>
          </div>
        )}
      </button>
      <div className="pointer-events-none absolute inset-x-0 bottom-0 bg-gradient-to-t from-black/55 via-black/18 to-transparent px-2 pb-1.5 pt-4 opacity-0 transition-opacity duration-150 group-hover/image:opacity-100">
        <p className="truncate text-[10px] font-medium leading-3 text-white" title={label}>{label}</p>
      </div>
      {removable && onRemove && (
        <button
          type="button"
          className="absolute right-1.5 top-1.5 inline-flex h-6 w-6 items-center justify-center rounded-full bg-background/92 text-foreground shadow-sm ring-1 ring-border/70 transition hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/45"
          onClick={onRemove}
          aria-label={`Remove ${label}`}
          title="移除图片"
        >
          <X className="h-3.5 w-3.5" />
        </button>
      )}
    </div>
  );
}
