import type { AgentTimelineRecord, ProcessEvent, RunSummary } from "@/components/agent/agentTimelineModel";
import type { AnswerEvidenceSource } from "@/components/agent/ragEvidence";

export interface AgentTimelineViewItem {
  record: AgentTimelineRecord;
  displayKind: AgentTimelineDisplayKind;
  assistantContent?: string;
  assistantStreaming?: boolean;
  contentBlockIndex?: number;
  contentBlockKey?: string;
  stoppedByUser: boolean;
  approvalDecision?: "allow" | "deny";
  questionAnswers?: Record<string, string>;
  exitPlanDecision?: "approve" | "deny";
  processSummary: RunSummary | null;
  processEvents: ProcessEvent[];
  processExpanded: boolean;
  processLockedOpen: boolean;
  processCollapsible: boolean;
  processKey: string;
  defaultCollapsed: boolean;
  answerEvidence?: AnswerEvidenceSource[];
}

export type AgentTimelineViewGroup =
  | { type: "user"; key: string; item: AgentTimelineViewItem }
  | { type: "assistant-turn"; key: string; items: AgentTimelineViewItem[]; entries: AgentTimelineTurnEntry[]; collapsedVisibleEntryKeys: string[]; processItem?: AgentTimelineViewItem; model?: string; providerId?: string; createdAt?: number }
  | { type: "system"; key: string; item: AgentTimelineViewItem }
  | { type: "runtime"; key: string; item: AgentTimelineViewItem };

export type AgentTimelineTurnEntry =
  | { type: "item"; key: string; item: AgentTimelineViewItem }
  | { type: "tool-group"; key: string; items: AgentTimelineViewItem[]; toolEvents: Extract<ProcessEvent, { kind: "tool_use" }>[]; summary: AgentTimelineToolGroupSummary };

export interface AgentTimelineToolGroupSummary {
  iconToolName: string;
  parts: string[];
  running: boolean;
}

export type AgentTimelineDisplayKind =
  | "hidden"
  | "process"
  | "compact-compacting"
  | "compact-complete"
  | "compact-failed"
  | "thinking"
  | "tool-use"
  | "approval-request"
  | "question-request"
  | "question-resolved"
  | "exit-plan-request"
  | "exit-plan-resolved"
  | "user-message"
  | "prompt-too-long"
  | "provider-error"
  | "permission-denied"
  | "run-retrying"
  | "assistant-final";
