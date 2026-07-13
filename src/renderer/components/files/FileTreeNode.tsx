import { type MouseEvent } from "react";
import { ChevronRight } from "lucide-react";
import type { WorkspaceFileNode } from "@/types/domain";
import { cx } from "@/lib/cn";
import { fileDisplayName } from "./FileContextMenu";
import { FileTypeBadge, FileTypeIcon } from "./FileTypeIcon";

type FileTreeNodeProps = {
  node: WorkspaceFileNode;
  level: number;
  selectedFileId: string;
  collapsedFolderIds: Set<string>;
  expandedEmptyFolderIds?: Set<string>;
  onSelect: (file: WorkspaceFileNode) => void;
  onToggleFolder: (folderId: string) => void;
  onToggleEmptyFolder?: (folderId: string) => void;
  onContextMenu: (event: MouseEvent, file: WorkspaceFileNode) => void;
  selectFolders?: boolean;
};

export function FileTreeNode({
  node,
  level,
  selectedFileId,
  collapsedFolderIds,
  expandedEmptyFolderIds,
  onSelect,
  onToggleFolder,
  onToggleEmptyFolder,
  onContextMenu,
  selectFolders = false,
}: FileTreeNodeProps) {
  const isFolder = node.kind === "folder";
  const hasChildren = isFolder && Boolean(node.children?.length);
  const open = isFolder && (hasChildren ? !collapsedFolderIds.has(node.id) : Boolean(expandedEmptyFolderIds?.has(node.id)));
  const active = selectedFileId === node.id;
  const displayName = fileDisplayName(node);
  const toggleFolder = () => {
    if (!isFolder) return;
    if (hasChildren) onToggleFolder(node.id);
    else onToggleEmptyFolder?.(node.id);
  };

  return (
    <div>
      <button
        type="button"
        className={cx(
          "flex w-full min-w-0 items-center gap-1.5 rounded-md px-2 py-1.5 text-left text-[12px] transition",
          active ? "bg-muted text-foreground ring-1 ring-border/70" : "text-muted-foreground hover:bg-accent hover:text-foreground",
        )}
        style={{ paddingLeft: 8 + level * 14 }}
        onClick={() => {
          if (isFolder && !selectFolders) {
            toggleFolder();
            return;
          }
          onSelect(node);
        }}
        onContextMenu={(event) => onContextMenu(event, node)}
        title={node.path}
      >
        {isFolder ? (
          <span
            className="-ml-1 flex h-5 w-5 shrink-0 items-center justify-center rounded-sm text-muted-foreground transition hover:bg-accent hover:text-foreground"
            onClick={(event) => {
              event.stopPropagation();
              toggleFolder();
            }}
          >
            <ChevronRight className={cx("h-3.5 w-3.5 transition-transform", open && "rotate-90")} />
          </span>
        ) : (
          <span className="w-3.5 shrink-0" />
        )}
        <FileTypeIcon name={node.name || displayName} isDirectory={isFolder} size={16} />
        <span className="min-w-0 flex-1 truncate">{displayName}</span>
        <FileTypeBadge name={node.name || displayName} kind={node.kind} isDirectory={isFolder} />
        {node.sizeLabel && <span className="shrink-0 text-[10px] text-muted-foreground/70">{node.sizeLabel}</span>}
      </button>

      {isFolder && open && (
        <div className="mt-0.5 space-y-0.5">
          {hasChildren && node.children ? (
            node.children.map((child) => (
              <FileTreeNode
                key={child.id}
                node={child}
                level={level + 1}
                selectedFileId={selectedFileId}
                collapsedFolderIds={collapsedFolderIds}
                expandedEmptyFolderIds={expandedEmptyFolderIds}
                onSelect={onSelect}
                onToggleFolder={onToggleFolder}
                onToggleEmptyFolder={onToggleEmptyFolder}
                onContextMenu={onContextMenu}
                selectFolders={selectFolders}
              />
            ))
          ) : (
            <div
              className="px-2 py-1 text-[11px] text-muted-foreground/60"
              style={{ paddingLeft: 8 + (level + 1) * 14 }}
            >
              空文件夹
            </div>
          )}
        </div>
      )}
    </div>
  );
}
