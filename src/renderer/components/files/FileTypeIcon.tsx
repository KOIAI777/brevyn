import { memo } from "react";
import { FileIcon, FolderIcon } from "@react-symbols/icons/utils";
import type { WorkspaceFileKind } from "@/types/domain";
import { cx } from "@/lib/cn";

interface FileTypeIconProps {
  name: string;
  isDirectory?: boolean;
  size?: number;
  className?: string;
}

export const FileTypeIcon = memo(function FileTypeIcon({
  name,
  isDirectory = false,
  size = 16,
  className,
}: FileTypeIconProps) {
  return (
    <span
      className={className}
      style={{
        width: size,
        height: size,
        display: "inline-flex",
        alignItems: "center",
        justifyContent: "center",
        flexShrink: 0,
        lineHeight: 0,
        verticalAlign: "middle",
      }}
    >
      {isDirectory ? (
        <FolderIcon folderName={name} width={size} height={size} />
      ) : (
        <FileIcon fileName={name} autoAssign width={size} height={size} />
      )}
    </span>
  );
});

export function FileTypeBadge({
  name,
  kind,
  isDirectory = false,
  className,
}: {
  name: string;
  kind?: WorkspaceFileKind;
  isDirectory?: boolean;
  className?: string;
}) {
  if (isDirectory || kind === "folder") return null;
  const label = fileTypeLabel(name, kind, isDirectory);
  if (!label) return null;
  return (
    <span
      className={cx(
        "inline-flex h-4 shrink-0 items-center rounded border border-border/60 bg-background/70 px-1.5 text-[9px] font-semibold uppercase leading-none text-muted-foreground/85",
        className,
      )}
    >
      {label}
    </span>
  );
}

export function fileTypeLabel(name: string, kind?: WorkspaceFileKind, isDirectory = false): string {
  if (isDirectory || kind === "folder") return "文件夹";
  if (kind === "pdf") return "PDF";
  if (kind === "docx") return "DOCX";
  if (kind === "pptx") return "PPTX";
  if (kind === "spreadsheet") return "表格";
  if (kind === "image") return "图片";
  if (kind === "markdown") return "MD";
  if (kind === "code") return "代码";
  if (kind === "text") return "TXT";

  const extension = name.trim().toLowerCase().match(/\.([a-z0-9]+)(?:\?.*)?$/)?.[1];
  if (!extension) return "";
  if (extension === "pdf") return "PDF";
  if (["doc", "docx"].includes(extension)) return extension.toUpperCase();
  if (["ppt", "pptx", "key"].includes(extension)) return extension.toUpperCase();
  if (["xls", "xlsx", "csv", "tsv"].includes(extension)) return extension.toUpperCase();
  if (["png", "jpg", "jpeg", "webp", "gif", "svg", "heic"].includes(extension)) return extension.toUpperCase();
  if (["md", "markdown"].includes(extension)) return "MD";
  if (["txt", "rtf"].includes(extension)) return extension.toUpperCase();
  if (["py", "js", "ts", "tsx", "jsx", "json", "html", "css", "r"].includes(extension)) return extension.toUpperCase();
  return extension.length <= 5 ? extension.toUpperCase() : "";
}
