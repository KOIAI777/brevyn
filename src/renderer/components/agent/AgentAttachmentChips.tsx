import { X } from "lucide-react";
import type { AgentAttachment } from "@/types/domain";
import { FileTypeBadge, FileTypeIcon } from "@/components/files/FileTypeIcon";

export function AttachmentChip({
  attachment,
  removable,
  onRemove,
}: {
  attachment: AgentAttachment;
  removable: boolean;
  onRemove: () => void;
}) {
  return (
    <span
      className="inline-flex max-w-full items-center gap-1.5 rounded-xl bg-[hsl(var(--foreground)/0.06)] py-1 pl-2 pr-1 text-[11px] font-medium text-foreground"
      title={attachment.path}
    >
      <FileTypeIcon name={attachment.name} size={15} />
      <span className="max-w-44 truncate">{attachment.name}</span>
      <FileTypeBadge name={attachment.name} kind={attachment.kind} />
      {attachment.sizeLabel && <span className="text-[10px] text-muted-foreground">{attachment.sizeLabel}</span>}
      {removable && (
        <button
          type="button"
          className="ml-0.5 inline-flex h-5 w-5 items-center justify-center rounded-full text-muted-foreground transition hover:bg-accent hover:text-foreground"
          onClick={onRemove}
          aria-label={`Remove ${attachment.name}`}
        >
          <X className="h-3 w-3" />
        </button>
      )}
    </span>
  );
}
