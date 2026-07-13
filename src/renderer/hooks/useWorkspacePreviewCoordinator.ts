import type { FileRailViewMode } from "@/components/files/FileBrowserRail";
import { useCallback } from "react";

interface UseWorkspacePreviewCoordinatorArgs {
  onRevealMaterials: () => void;
  setFileRailActiveTab: (value: FileRailViewMode) => void;
}

export function useWorkspacePreviewCoordinator({
  onRevealMaterials,
  setFileRailActiveTab,
}: UseWorkspacePreviewCoordinatorArgs) {
  const revealSelectedFile = useCallback((kind: "folder" | "file") => {
    onRevealMaterials();
    if (kind === "folder") setFileRailActiveTab("tree");
  }, [onRevealMaterials, setFileRailActiveTab]);

  return {
    revealSelectedFile,
  };
}
