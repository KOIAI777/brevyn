import { useCallback, useEffect, useState } from "react";
import type { AgentPermissionMode } from "@/types/domain";

const AGENT_PERMISSION_STORAGE_PREFIX = "brevyn.agent.permissionMode.";

export interface AgentPanelPreferencesState {
  permissionMode: AgentPermissionMode;
  setPermissionMode: (mode: AgentPermissionMode) => void;
}

export function useAgentPanelPreferencesState(threadId: string): AgentPanelPreferencesState {
  const [permissionMode, setPermissionModeState] = useState<AgentPermissionMode>("auto");

  useEffect(() => {
    setPermissionModeState(readStoredPermissionMode(threadId));
  }, [threadId]);

  return {
    permissionMode,
    setPermissionMode: useCallback((mode: AgentPermissionMode) => {
      setPermissionModeState(mode);
      writeStoredPermissionMode(threadId, mode);
    }, [threadId]),
  };
}

function readStoredPermissionMode(threadId: string): AgentPermissionMode {
  try {
    const value = window.localStorage.getItem(`${AGENT_PERMISSION_STORAGE_PREFIX}${threadId}`);
    return value === "bypassPermissions" || value === "plan" || value === "auto" ? value : "auto";
  } catch {
    return "auto";
  }
}

function writeStoredPermissionMode(threadId: string, mode: AgentPermissionMode): void {
  try {
    window.localStorage.setItem(`${AGENT_PERMISSION_STORAGE_PREFIX}${threadId}`, mode);
  } catch {
    // Ignore storage failures; auto remains the safe fallback.
  }
}
