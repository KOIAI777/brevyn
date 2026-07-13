import type { AgentPermissionMode, ContextAnchor } from "@/types/domain";

export interface QueuedAgentMessage {
  id: string;
  prompt: string;
  permissionMode?: AgentPermissionMode;
  providerSelection?: { providerId?: string; modelId?: string };
  mentionedSkills?: string[];
  quotedSelection?: ContextAnchor;
  quotedSelections?: ContextAnchor[];
  createdAt: number;
}
