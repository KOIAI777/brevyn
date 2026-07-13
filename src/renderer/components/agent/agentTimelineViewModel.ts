import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import {
  agentErrorMessage,
  approvalDecision,
  assistantBlocks,
  assistantText,
  exitPlanDecision,
  groupIntoTurns,
  isCompactCommandMessage,
  isPromptTooLongMessage,
  isRuntimeRecord,
  isStreamEventRecord,
  messageContent,
  questionAnswers,
  recordKey,
  streamTextDeltaBlock,
  streamThinkingDeltaBlock,
  streamToolInputDelta,
  streamToolUseStart,
  toolResultBlocks,
  type AgentTimelineRecord,
  type ProcessEvent,
  type RunSummary,
  type WebCitationLink,
} from "@/components/agent/agentTimelineModel";
import { completePartialToolInputHints, isCompleteToolInputJson, parsePartialToolInput } from "@/components/agent/agentTimelinePartialInput";
import { processStateKey } from "@/components/agent/agentTimelineRunState";
import { getToolInputPath, recordObject, stringValue, type ToolResultBlock, type ToolUseBlock } from "@/components/agent/tool-cards/toolModel";
import { buildAnswerEvidenceSources, parseRagEvidenceOutput, type AnswerEvidenceSource, type RagEvidence } from "@/components/agent/ragEvidence";
import { formatAgentUserError } from "../../../shared/agent-error-format";
import type {
  AgentTimelineDisplayKind,
  AgentTimelineToolGroupSummary,
  AgentTimelineTurnEntry,
  AgentTimelineViewGroup,
  AgentTimelineViewItem,
} from "@/components/agent/agentTimelineViewTypes";

const HEAVY_PARTIAL_INPUT_HINT_LIMIT = 4096;

export function buildTimelineViewItems(
  records: AgentTimelineRecord[],
  options: {
    forceProcessOpen: boolean;
    ownerUserIndexByRecordIndex: number[];
    processCollapsedByKey: Record<string, boolean>;
    resolvedApprovals: Map<string, "allow" | "deny">;
    resolvedExitPlans: Map<string, "approve" | "deny">;
    resolvedQuestions: Map<string, Record<string, string>>;
    runSummary: RunSummary | null;
    runSummaryByUserIndex: Map<number, RunSummary | null>;
    stoppedAssistantIndex?: number;
  },
): AgentTimelineViewItem[] {
  return records.map((record, index) => {
    const ownerUserIndex = options.ownerUserIndexByRecordIndex[index] ?? -1;
    const itemSummary = ownerUserIndex >= 0
      ? options.runSummaryByUserIndex.get(ownerUserIndex) ?? null
      : options.runSummary;
    const processKey = processStateKey(itemSummary, ownerUserIndex >= 0 ? ownerUserIndex : undefined, records, index);
    const defaultCollapsed = !itemSummary?.running;
    const processLockedOpen = Boolean(options.forceProcessOpen && itemSummary?.running);
    const processExpanded = processLockedOpen || !(options.processCollapsedByKey[processKey] ?? defaultCollapsed);
    const display = timelineItemDisplay(record, {
      processSummary: itemSummary,
      approvalDecision: approvalDecision(record, options.resolvedApprovals),
      questionAnswers: questionAnswers(record, options.resolvedQuestions),
      exitPlanDecision: exitPlanDecision(record, options.resolvedExitPlans),
    });
    return {
      record,
      displayKind: display.kind,
      assistantContent: display.assistantContent,
      stoppedByUser: index === options.stoppedAssistantIndex,
      approvalDecision: display.approvalDecision,
      questionAnswers: display.questionAnswers,
      exitPlanDecision: display.exitPlanDecision,
      processSummary: itemSummary,
      processEvents: [],
      processExpanded,
      processLockedOpen,
      processCollapsible: false,
      processKey,
      defaultCollapsed,
    };
  });
}

export function buildTimelineViewGroups(
  records: AgentTimelineRecord[],
  items: AgentTimelineViewItem[],
  options?: {
    activeModelId?: string;
    effectiveRunning?: boolean;
    forceProcessOpen?: boolean;
    runSummary?: RunSummary | null;
    processCollapsedByKey?: Record<string, boolean>;
  },
): AgentTimelineViewGroup[] {
  const groups = groupIntoTurns(records);
  const viewGroups: AgentTimelineViewGroup[] = [];

  for (const group of groups) {
    if (group.type === "user") {
      const item = items[group.index];
      if (!item) continue;
      viewGroups.push({ type: "user", key: `user-${recordKey(item.record, group.index)}`, item });
      continue;
    }

    if (group.type === "assistant-turn") {
      const turnItems = assistantTurnViewItems(group.turnRecords, items);
      const entries = assistantTurnRenderEntries(turnItems);
      const processItem = turnProcessSummaryItem(turnItems, {
        forceProcessOpen: options?.forceProcessOpen,
        runSummary: options?.runSummary,
        processCollapsedByKey: options?.processCollapsedByKey,
      });
      if (turnItems.length === 0 && !processItem) continue;
      viewGroups.push({
        type: "assistant-turn",
        key: groupKey("assistant", turnItems, processItem),
        items: turnItems,
        entries,
        collapsedVisibleEntryKeys: collapsedAssistantTextKeys(entries),
        processItem,
        model: group.model,
        providerId: group.providerId,
        createdAt: group.createdAt,
      });
      continue;
    }

    const item = items[group.index];
    if (!item) continue;
    const key = `${group.type}-${recordKey(item.record, group.index)}`;
    viewGroups.push({ type: group.type, key, item } as AgentTimelineViewGroup);
  }

  const filtered = viewGroups.filter((group) => {
    if (group.type === "assistant-turn") return Boolean(group.processItem) || group.items.some((item) => item.displayKind !== "hidden");
    return group.item.displayKind !== "hidden";
  });
  return appendRunningProcessViewGroup(collapseCompactSystemGroups(filtered), items, records, options);
}

export function stabilizeTimelineViewGroups(
  previous: AgentTimelineViewGroup[],
  next: AgentTimelineViewGroup[],
): AgentTimelineViewGroup[] {
  if (previous.length === 0 || next.length === 0) return next;
  const previousByKey = new Map(previous.map((group) => [group.key, group]));
  const stabilized = next.map((group) => {
    const previousGroup = previousByKey.get(group.key);
    return previousGroup && canReuseTimelineGroup(previousGroup, group) ? previousGroup : group;
  });
  return stabilized.length === previous.length && stabilized.every((group, index) => group === previous[index])
    ? previous
    : stabilized;
}

function canReuseTimelineGroup(previous: AgentTimelineViewGroup, next: AgentTimelineViewGroup): boolean {
  if (previous.type !== next.type || previous.key !== next.key) return false;
  if (next.type === "user" && previous.type === "user") {
    return sameStaticViewItem(previous.item, next.item);
  }
  if (next.type !== "assistant-turn" || previous.type !== "assistant-turn") return false;
  if (!isStaticTextTurn(previous) || !isStaticTextTurn(next)) return false;
  return previous.model === next.model
    && previous.providerId === next.providerId
    && previous.createdAt === next.createdAt
    && sameStringList(previous.collapsedVisibleEntryKeys, next.collapsedVisibleEntryKeys)
    && sameOptionalStaticViewItem(previous.processItem, next.processItem)
    && sameStaticViewItems(previous.items, next.items)
    && previous.entries.length === next.entries.length
    && previous.entries.every((entry, index) => {
      const nextEntry = next.entries[index];
      return entry.type === "item"
        && nextEntry?.type === "item"
        && entry.key === nextEntry.key
        && sameStaticViewItem(entry.item, nextEntry.item);
    });
}

function isStaticTextTurn(group: Extract<AgentTimelineViewGroup, { type: "assistant-turn" }>): boolean {
  if (group.processItem?.processSummary?.running) return false;
  return group.entries.every((entry) => entry.type === "item")
    && group.items.every((item) => (
      item.assistantStreaming !== true
      && item.processEvents.length === 0
      && (item.displayKind === "assistant-final" || item.displayKind === "thinking" || item.displayKind === "prompt-too-long" || item.displayKind === "provider-error")
    ));
}

function sameStaticViewItems(previous: AgentTimelineViewItem[], next: AgentTimelineViewItem[]): boolean {
  return previous.length === next.length && previous.every((item, index) => {
    const nextItem = next[index];
    return Boolean(nextItem) && sameStaticViewItem(item, nextItem);
  });
}

function sameOptionalStaticViewItem(previous: AgentTimelineViewItem | undefined, next: AgentTimelineViewItem | undefined): boolean {
  if (!previous || !next) return previous === next;
  return sameStaticViewItem(previous, next);
}

function sameStaticViewItem(previous: AgentTimelineViewItem, next: AgentTimelineViewItem): boolean {
  return recordKey(previous.record) === recordKey(next.record)
    && previous.displayKind === next.displayKind
    && previous.assistantContent === next.assistantContent
    && previous.assistantStreaming === next.assistantStreaming
    && previous.contentBlockIndex === next.contentBlockIndex
    && previous.contentBlockKey === next.contentBlockKey
    && previous.stoppedByUser === next.stoppedByUser
    && previous.processExpanded === next.processExpanded
    && previous.processLockedOpen === next.processLockedOpen
    && previous.processCollapsible === next.processCollapsible
    && previous.processKey === next.processKey
    && previous.defaultCollapsed === next.defaultCollapsed
    && sameRunSummary(previous.processSummary, next.processSummary);
}

function sameRunSummary(previous: RunSummary | null, next: RunSummary | null): boolean {
  if (!previous || !next) return previous === next;
  return previous.runId === next.runId
    && previous.label === next.label
    && previous.running === next.running
    && previous.status === next.status
    && previous.permissionMode === next.permissionMode
    && previous.detail === next.detail
    && previous.startedAtMs === next.startedAtMs
    && previous.finishedAtMs === next.finishedAtMs
    && previous.hasActivity === next.hasActivity
    && previous.retryAttempt === next.retryAttempt
    && previous.retryMaxRetries === next.retryMaxRetries
    && previous.retryUntilMs === next.retryUntilMs;
}

function sameStringList(previous: string[], next: string[]): boolean {
  return previous.length === next.length && previous.every((value, index) => value === next[index]);
}

function collapseCompactSystemGroups(groups: AgentTimelineViewGroup[]): AgentTimelineViewGroup[] {
  const collapsed: AgentTimelineViewGroup[] = [];
  let compactGroupIndex = 0;

  for (const group of groups) {
    if (!isCompactSystemGroup(group)) {
      collapsed.push(group);
      continue;
    }

    const previous = collapsed.at(-1);
    if (isCompactSystemGroup(previous)) {
      collapsed[collapsed.length - 1] = { ...group, key: previous.key };
      continue;
    }

    collapsed.push({ ...group, key: `system-compact-${compactGroupIndex}` });
    compactGroupIndex += 1;
  }

  return collapsed;
}

function isCompactSystemGroup(group: AgentTimelineViewGroup | undefined): group is Extract<AgentTimelineViewGroup, { type: "system" }> {
  return group?.type === "system"
    && (group.item.displayKind === "compact-compacting" || group.item.displayKind === "compact-complete" || group.item.displayKind === "compact-failed");
}

function assistantTurnViewItems(
  turnRecords: Array<{ record: AgentTimelineRecord; index: number }>,
  items: AgentTimelineViewItem[],
): AgentTimelineViewItem[] {
  const slots = new Map<string, AgentTimelineViewItem>();
  const slotOrder = new Map<string, number>();
  const toolResults = toolResultsById(turnRecords);
  const approvalByToolUseId = approvalDecisionByToolUseId(turnRecords);
  const hostedLinks = webCitationLinksFromTurn(turnRecords);

  let streamSegment = 0;
  let assistantSegment = 0;
  const streamContentBySlotKey = new Map<string, string>();
  const streamToolInputBySlotKey = new Map<string, string>();

  function setSlot(slotKey: string, order: number, item: AgentTimelineViewItem): void {
    if (!slotOrder.has(slotKey)) {
      slotOrder.set(slotKey, order);
    }
    slots.set(slotKey, item);
  }

  function toolSlotKeyById(toolUseId: string): string | undefined {
    if (!toolUseId) return undefined;
    for (const [key, slot] of slots) {
      if (slot.displayKind !== "tool-use") continue;
      const event = slot.processEvents.find((candidate): candidate is Extract<ProcessEvent, { kind: "tool_use" }> => candidate.kind === "tool_use");
      if (event?.tool.id === toolUseId) return key;
    }
    return undefined;
  }

  function slotKey(segment: number, blockIndex: number, kind: "thinking" | "text" | "tool"): string {
    return `${segment}:${blockIndex}:${kind}`;
  }

  function slotOrderValue(segment: number, blockIndex: number, kind: "thinking" | "text" | "tool"): number {
    const kindOrder = kind === "thinking" ? 0 : kind === "tool" ? 1 : 2;
    return (segment * 10000) + (blockIndex * 10) + kindOrder;
  }

  function streamTargetSegment(blockIndex: number, kind: "thinking" | "text" | "tool"): number {
    const finalizedSegment = assistantSegment - 1;
    return finalizedSegment >= 0 && slots.has(slotKey(finalizedSegment, blockIndex, kind))
      ? finalizedSegment
      : streamSegment;
  }

  function matchingFinalizedContent(displayKind: "assistant-final" | "thinking", text: string): AgentTimelineViewItem | undefined {
    const signature = contentSignature(text);
    if (!signature) return undefined;
    return [...slots.values()].find((slot) => (
      slot.displayKind === displayKind
        && slot.assistantStreaming === false
        && contentSignature(slot.assistantContent || "") === signature
    ));
  }

  function finalizedContentStartsWith(displayKind: "assistant-final" | "thinking", text: string): boolean {
    const signature = contentSignature(text);
    if (!signature) return false;
    return [...slots.values()].some((slot) => {
      if (slot.displayKind !== displayKind || slot.assistantStreaming !== false) return false;
      const slotSignature = contentSignature(slot.assistantContent || "");
      return Boolean(slotSignature && slotSignature.startsWith(signature));
    });
  }

  function removeMatchingStreamingContent(displayKind: "assistant-final" | "thinking", text: string): void {
    const signature = contentSignature(text);
    if (!signature) return;
    for (const [key, slot] of slots) {
      if (
        slot.displayKind === displayKind
        && slot.assistantStreaming === true
        && contentSignature(slot.assistantContent || "") === signature
      ) {
        slots.delete(key);
        slotOrder.delete(key);
      }
    }
  }

  for (const { record, index } of turnRecords) {
    const item = items[index];
    if (!item) continue;
    if (isStreamEventRecord(record)) {
      const thinkingDelta = streamThinkingDeltaBlock(record);
      if (thinkingDelta?.text) {
        const segment = streamTargetSegment(thinkingDelta.index, "thinking");
        const key = slotKey(segment, thinkingDelta.index, "thinking");
        const previous = streamContentBySlotKey.get(key) || slots.get(key)?.assistantContent || "";
        const nextContent = `${previous}${thinkingDelta.text}`;
        streamContentBySlotKey.set(key, nextContent);
        if (finalizedContentStartsWith("thinking", nextContent)) continue;
        const existing = slots.get(key);
        if (existing?.assistantStreaming === false) continue;
        setSlot(key, slotOrderValue(segment, thinkingDelta.index, "thinking"), {
          ...(existing ?? orderedContentItem(item)),
          record: existing?.record ?? item.record,
          displayKind: "thinking",
          assistantContent: nextContent,
          assistantStreaming: true,
          contentBlockIndex: thinkingDelta.index,
          contentBlockKey: key,
        });
      }
      const textDelta = streamTextDeltaBlock(record);
      if (textDelta?.text) {
        const segment = streamTargetSegment(textDelta.index, "text");
        const key = slotKey(segment, textDelta.index, "text");
        const previous = streamContentBySlotKey.get(key) || slots.get(key)?.assistantContent || "";
        const nextContent = `${previous}${textDelta.text}`;
        streamContentBySlotKey.set(key, nextContent);
        if (finalizedContentStartsWith("assistant-final", nextContent)) continue;
        const existing = slots.get(key);
        if (existing?.assistantStreaming === false) continue;
        setSlot(key, slotOrderValue(segment, textDelta.index, "text"), {
          ...(existing ?? orderedContentItem(item)),
          record: existing?.record ?? item.record,
          displayKind: "assistant-final",
          assistantContent: nextContent,
          assistantStreaming: true,
          contentBlockIndex: textDelta.index,
          contentBlockKey: key,
        });
      }
      const toolUse = streamToolUseStart(record);
      if (toolUse && toolUse.tool.name !== "TodoWrite") {
        const segment = streamTargetSegment(toolUse.index, "tool");
        const key = toolSlotKeyById(toolUse.tool.id) ?? slotKey(segment, toolUse.index, "tool");
        const existing = slots.get(key);
        if (existing?.assistantStreaming === false) continue;
        setSlot(key, slotOrderValue(segment, toolUse.index, "tool"), {
          ...(existing ?? orderedContentItem(item)),
          record: existing?.record ?? item.record,
          displayKind: "tool-use",
          assistantStreaming: true,
          contentBlockIndex: existing?.contentBlockIndex ?? toolUse.index,
          contentBlockKey: existing?.contentBlockKey ?? key,
          processEvents: [{
            kind: "tool_use",
            id: `tool-use-${toolUse.tool.id}`,
            tool: {
              ...toolUse.tool,
              input: existing?.processEvents[0]?.kind === "tool_use"
                ? existing.processEvents[0].tool.input
                : toolUse.tool.input,
            },
            result: existing?.processEvents[0]?.kind === "tool_use"
              ? existing.processEvents[0].result ?? hostedToolResult(toolUse.tool, hostedLinks)
              : hostedToolResult(toolUse.tool, hostedLinks),
            approvalDecision: approvalByToolUseId.get(toolUse.tool.id),
            sourceIndex: index,
          }],
        });
      }
      const inputDelta = streamToolInputDelta(record);
      if (inputDelta) {
        const segment = streamTargetSegment(inputDelta.index, "tool");
        const key = slotKey(segment, inputDelta.index, "tool");
        const existing = slots.get(key);
        if (existing?.displayKind === "tool-use") {
          const event = existing.processEvents.find((candidate): candidate is Extract<ProcessEvent, { kind: "tool_use" }> => candidate.kind === "tool_use");
          if (event) {
            const heavyPartialInput = isHeavyPartialInputTool(event.tool.name);
            if (heavyPartialInput && hasToolTargetHint(event.tool.input)) continue;

            const previous = streamToolInputBySlotKey.get(key) || "";
            const nextInput = heavyPartialInput
              ? `${previous}${inputDelta.partialJson}`.slice(0, HEAVY_PARTIAL_INPUT_HINT_LIMIT)
              : `${previous}${inputDelta.partialJson}`;
            streamToolInputBySlotKey.set(key, nextInput);
            const parsedInput = parsePartialToolInput(nextInput, {
              hintsOnly: heavyPartialInput,
              maxLength: heavyPartialInput ? HEAVY_PARTIAL_INPUT_HINT_LIMIT : undefined,
            });
            if (!parsedInput) continue;
            const parsedInputObject = recordObject(parsedInput);
            const partialInput = !isCompleteToolInputJson(nextInput);
            const nextVisibleInput = visibleStreamToolInput(event.tool.name, parsedInputObject, partialInput, nextInput);
            if (!nextVisibleInput) continue;
            setSlot(key, slotOrderValue(segment, inputDelta.index, "tool"), {
              ...existing,
              processEvents: [{
                ...event,
                tool: {
                  ...event.tool,
                  input: heavyPartialInput
                    ? { ...recordObject(event.tool.input), ...nextVisibleInput }
                    : nextVisibleInput,
                },
              }],
            });
          }
        }
      }
      continue;
    }

    if (!isRuntimeRecord(record) && (record as SDKMessage).type === "user") {
      if (toolResultBlocks(record as SDKMessage).length > 0) streamSegment = Math.max(streamSegment, assistantSegment);
      continue;
    }

    if (!isRuntimeRecord(record) && (record as SDKMessage).type === "assistant") {
      const message = record as SDKMessage;
      const errorItem = promptOrProviderErrorItem(item);
      if (errorItem) {
        setSlot(`error:${index}`, slotOrderValue(assistantSegment, 0, "text"), errorItem);
        assistantSegment += 1;
        streamSegment = assistantSegment;
        continue;
      }

      for (const [blockIndex, block] of orderedAssistantContentBlocks(message).entries()) {
        if (block.type === "thinking") {
          if (!block.thinking.trim()) continue;
          const duplicate = matchingFinalizedContent("thinking", block.thinking);
          if (duplicate) continue;
          removeMatchingStreamingContent("thinking", block.thinking);
          const key = slotKey(assistantSegment, blockIndex, "thinking");
          setSlot(key, slotOrderValue(assistantSegment, blockIndex, "thinking"), {
            ...orderedContentItem(item),
            displayKind: "thinking",
            assistantContent: block.thinking,
            assistantStreaming: false,
            contentBlockIndex: blockIndex,
            contentBlockKey: key,
          });
          continue;
        }

        if (block.type === "text") {
          if (!block.text.trim()) continue;
          const duplicate = matchingFinalizedContent("assistant-final", block.text);
          if (duplicate) continue;
          removeMatchingStreamingContent("assistant-final", block.text);
          const key = slotKey(assistantSegment, blockIndex, "text");
          setSlot(key, slotOrderValue(assistantSegment, blockIndex, "text"), {
            ...orderedContentItem(item),
            displayKind: "assistant-final",
            assistantContent: block.text,
            assistantStreaming: false,
            contentBlockIndex: blockIndex,
            contentBlockKey: key,
          });
          continue;
        }

        if (block.type === "tool_use") {
          if (block.tool.name === "TodoWrite") continue;
          const key = toolSlotKeyById(block.tool.id) ?? slotKey(assistantSegment, blockIndex, "tool");
          const existing = slots.get(key);
          setSlot(key, slotOrderValue(assistantSegment, blockIndex, "tool"), {
            ...orderedContentItem(item),
            displayKind: "tool-use",
            assistantStreaming: false,
            contentBlockIndex: existing?.contentBlockIndex ?? blockIndex,
            contentBlockKey: existing?.contentBlockKey ?? key,
            processEvents: [{
              kind: "tool_use",
              id: `tool-use-${block.tool.id}`,
              tool: block.tool,
              result: toolResults.get(block.tool.id)
                ?? (existing?.processEvents[0]?.kind === "tool_use" ? existing.processEvents[0].result : undefined)
                ?? hostedToolResult(block.tool, hostedLinks),
              approvalDecision: approvalByToolUseId.get(block.tool.id),
              sourceIndex: index,
            }],
          });
        }
      }
      assistantSegment += 1;
      streamSegment = assistantSegment;
      continue;
    }

    if (!isRuntimeRecord(record) && (record as SDKMessage).type === "system") {
      const message = record as SDKMessage;
      const subtype = stringValue((message as { subtype?: unknown }).subtype, "");
      if (subtype === "permission_denied") {
        setSlot(`permission-denied:${index}`, (assistantSegment * 10000) - 1 + (index / 100000), item);
      }
      continue;
    }

    if (isRuntimeRecord(record)) setSlot(`runtime:${index}`, slotOrderValue(assistantSegment, 900 + index, "tool"), item);
  }

  for (const [key, slot] of slots) {
    if (
      slot.assistantStreaming === true
      && (slot.displayKind === "assistant-final" || slot.displayKind === "thinking")
      && slot.processSummary?.status
      && slot.processSummary.status !== "running"
    ) {
      slots.set(key, {
        ...slot,
        assistantStreaming: false,
        stoppedByUser: slot.processSummary.status === "stopped" && slot.displayKind === "assistant-final",
      });
      continue;
    }
    if (slot.displayKind !== "tool-use") continue;
    let changed = false;
    const nextEvents = slot.processEvents.map((event) => {
      if (event.kind !== "tool_use" || event.result) return event;
      const result = toolResults.get(event.tool.id) ?? hostedToolResult(event.tool, hostedLinks);
      if (result) changed = true;
      return result ? { ...event, result } : event;
    });
    if (changed) {
      slots.set(key, {
        ...slot,
        assistantStreaming: nextEvents.some((event) => event.kind === "tool_use" && !event.result),
        processEvents: nextEvents,
      });
    }
  }

  return attachAnswerEvidence(
    [...slots.entries()]
    .sort((left, right) => (slotOrder.get(left[0]) ?? 0) - (slotOrder.get(right[0]) ?? 0))
    .map(([, item]) => item)
    .filter((item) => item.displayKind !== "hidden"),
  );
}

function attachAnswerEvidence(items: AgentTimelineViewItem[]): AgentTimelineViewItem[] {
  const evidence = buildAnswerEvidenceSources(ragEvidenceFromItems(items));
  if (evidence.length === 0) return items;
  const lastRagToolIndex = findLastIndex(items, isRagSearchToolItem);
  if (lastRagToolIndex < 0) return items;
  const targetIndex = findLastIndex(items, (item, index) => (
    index > lastRagToolIndex
    &&
    item.displayKind === "assistant-final"
    && Boolean(item.assistantContent?.trim())
  ));
  if (targetIndex < 0) return items;
  return items.map((item, index) => index === targetIndex ? { ...item, answerEvidence: evidence } : item);
}

function isRagSearchToolItem(item: AgentTimelineViewItem): boolean {
  return item.displayKind === "tool-use" && item.processEvents.some((event) => (
    event.kind === "tool_use"
    && event.tool.name === "mcp__brevyn__rag_search"
    && Boolean(event.result)
    && event.result?.isError !== true
  ));
}

function ragEvidenceFromItems(items: AgentTimelineViewItem[]): RagEvidence[] {
  return items.flatMap((item) => item.processEvents.flatMap((event) => {
    if (event.kind !== "tool_use" || event.tool.name !== "mcp__brevyn__rag_search" || !event.result || event.result.isError) return [];
    return parseRagEvidenceOutput(event.result).results;
  }));
}

function findLastIndex<T>(items: T[], predicate: (item: T, index: number) => boolean): number {
  for (let index = items.length - 1; index >= 0; index -= 1) {
    if (predicate(items[index]!, index)) return index;
  }
  return -1;
}

function isHeavyPartialInputTool(toolName: string): boolean {
  return toolName === "Write" || toolName === "Edit" || toolName === "MultiEdit";
}

function visibleStreamToolInput(toolName: string, input: Record<string, unknown>, partialInput: boolean, rawInput: string): Record<string, unknown> | null {
  if (isFileTool(toolName)) {
    if (partialInput) return completePartialToolInputHints(rawInput);
    if (toolName === "Read") return input;
    return fileToolTargetInput(input);
  }
  return partialInput ? { ...input, _partialInput: true } : input;
}

function isFileTool(toolName: string): boolean {
  return toolName === "Read" || toolName === "Write" || toolName === "Edit" || toolName === "MultiEdit";
}

function fileToolTargetInput(input: Record<string, unknown>): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const key of ["file_path", "filePath", "path", "notebook_path"]) {
    const value = input[key];
    if (typeof value === "string" && value.trim()) result[key] = value;
  }
  return result;
}

function hasToolTargetHint(input: unknown): boolean {
  return Boolean(getToolInputPath(input));
}

function turnProcessSummaryItem(
  items: AgentTimelineViewItem[],
  options?: {
    forceProcessOpen?: boolean;
    runSummary?: RunSummary | null;
    processCollapsedByKey?: Record<string, boolean>;
  },
): AgentTimelineViewItem | undefined {
  if (items.some((item) => item.displayKind === "process")) return undefined;
  const summarySource = [...items].reverse().find((item) => item.processSummary);
  const itemSource = summarySource ?? items[items.length - 1];
  const summary = summarySource?.processSummary ?? options?.runSummary ?? null;
  if (!itemSource || !summary) return undefined;
  const hasTimelineItems = items.some(isTurnTimelineItem);
  const defaultCollapsed = !summary.running;
  const processLockedOpen = Boolean(options?.forceProcessOpen && summary.running);
  const processExpanded = processLockedOpen || !(options?.processCollapsedByKey?.[itemSource.processKey] ?? defaultCollapsed);
  return {
    ...itemSource,
    displayKind: "process",
    processSummary: summary,
    processEvents: [],
    processExpanded,
    processLockedOpen,
    processCollapsible: hasTimelineItems,
    defaultCollapsed,
  };
}

function isTurnTimelineItem(item: AgentTimelineViewItem): boolean {
  return item.displayKind === "thinking"
    || item.displayKind === "tool-use"
    || item.displayKind === "approval-request"
    || item.displayKind === "question-request"
    || item.displayKind === "question-resolved"
    || item.displayKind === "exit-plan-request"
    || item.displayKind === "exit-plan-resolved";
}

function assistantTurnRenderEntries(items: AgentTimelineViewItem[]): AgentTimelineTurnEntry[] {
  const entries: AgentTimelineTurnEntry[] = [];
  let pendingTools: AgentTimelineViewItem[] = [];

  function flushTools() {
    if (pendingTools.length === 0) return;
    const toolEvents = toolEventsFromItems(pendingTools);
    entries.push({
      type: "tool-group",
      key: assistantTurnItemKey(pendingTools[0]!),
      items: pendingTools,
      toolEvents,
      summary: summarizeToolGroup(toolEvents),
    });
    pendingTools = [];
  }

  for (const item of items) {
    if (item.displayKind === "tool-use") {
      pendingTools.push(item);
      continue;
    }
    flushTools();
    entries.push({ type: "item", key: assistantTurnItemKey(item), item });
  }

  flushTools();
  return entries;
}

function collapsedAssistantTextKeys(entries: AgentTimelineTurnEntry[]): string[] {
  const keys = new Set<string>();
  let lastTimelineIndex = -1;
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index];
    const firstItem = entry?.type === "tool-group" ? entry.items[0] : entry?.item;
    if (firstItem && (entry?.type === "tool-group" || isTurnTimelineItem(firstItem))) {
      lastTimelineIndex = index;
      break;
    }
  }
  for (const [index, entry] of entries.entries()) {
    if (entry.type !== "item" || entry.item.displayKind !== "assistant-final") continue;
    if (index > lastTimelineIndex) keys.add(entry.key);
  }
  if (keys.size > 0) return [...keys];
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index];
    if (entry?.type === "item" && entry.item.displayKind === "assistant-final") {
      keys.add(entry.key);
      break;
    }
  }
  return [...keys];
}

function assistantTurnItemKey(item: AgentTimelineViewItem): string {
  if (item.displayKind === "process") return `process-${item.processKey}`;
  if (item.contentBlockKey && (item.displayKind === "assistant-final" || item.displayKind === "thinking")) {
    return `${item.displayKind}-block-${item.contentBlockKey}`;
  }
  const tool = item.processEvents.find((event): event is Extract<ProcessEvent, { kind: "tool_use" }> => event.kind === "tool_use");
  if (tool) return `tool-${tool.tool.id || tool.id}`;
  const blockKey = item.contentBlockIndex === undefined ? "" : `-block-${item.contentBlockIndex}`;
  return `${item.displayKind}-${recordKey(item.record)}${blockKey}`;
}

function toolEventsFromItems(items: AgentTimelineViewItem[]): Extract<ProcessEvent, { kind: "tool_use" }>[] {
  return items.flatMap((item) => item.processEvents.filter((event): event is Extract<ProcessEvent, { kind: "tool_use" }> => event.kind === "tool_use"));
}

function summarizeToolGroup(events: Extract<ProcessEvent, { kind: "tool_use" }>[]): AgentTimelineToolGroupSummary {
  const runningSummary = summarizeRunningToolGroup(events);
  if (runningSummary) return runningSummary;

  return summarizeCompletedToolGroup(events);
}

function summarizeRunningToolGroup(events: Extract<ProcessEvent, { kind: "tool_use" }>[]): AgentTimelineToolGroupSummary | null {
  if (!events.some((event) => !event.result)) return null;
  const runningEvent = toolGroupRunningDisplayEvent(events);
  if (runningEvent) {
    return {
      iconToolName: runningEvent.tool.name,
      parts: [runningToolLabel(runningEvent)],
      running: true,
    };
  }
  const fallbackEvent = [...events].reverse().find((event) => toolEventHasTarget(event));
  if (fallbackEvent) {
    return {
      iconToolName: fallbackEvent.tool.name,
      parts: [runningToolLabel(fallbackEvent)],
      running: true,
    };
  }
  return null;
}

function summarizeCompletedToolGroup(events: Extract<ProcessEvent, { kind: "tool_use" }>[]): AgentTimelineToolGroupSummary {
  if (events.length === 1) return summarizeSingleCompletedTool(events[0]!);
  const stats = toolGroupStats(events);
  const parts = completedToolGroupSummaryParts(stats);
  return {
    iconToolName: toolGroupIconName(stats, events),
    parts: parts.length > 0 ? parts : [`已使用 ${events.length} 个工具`],
    running: false,
  };
}

function summarizeSingleCompletedTool(event: Extract<ProcessEvent, { kind: "tool_use" }>): AgentTimelineToolGroupSummary {
  if (event.result?.isError) {
    return {
      iconToolName: event.tool.name,
      parts: ["1 个失败"],
      running: false,
    };
  }
  return {
    iconToolName: event.tool.name,
    parts: [completedSingleToolLabel(event)],
    running: false,
  };
}

function toolGroupStats(events: Extract<ProcessEvent, { kind: "tool_use" }>[]): {
  editedFiles: Set<string>;
  exploredFiles: Set<string>;
  exploredCount: number;
  searches: number;
  commands: number;
  skills: number;
  others: number;
  failed: number;
} {
  const stats = {
    editedFiles: new Set<string>(),
    exploredFiles: new Set<string>(),
    exploredCount: 0,
    searches: 0,
    commands: 0,
    skills: 0,
    others: 0,
    failed: 0,
  };

  for (const event of events) {
    const toolName = event.tool.name;
    const input = recordObject(event.tool.input);
    if (event.result?.isError) {
      stats.failed += 1;
      continue;
    }

    if (isEditTool(toolName)) {
      const path = getToolInputPath(input);
      if (path) stats.editedFiles.add(path);
      else stats.others += 1;
      continue;
    }

    if (toolName === "Read") {
      const path = getToolInputPath(input);
      if (path) stats.exploredFiles.add(path);
      else if (event.result) stats.exploredCount += 1;
      else stats.others += 1;
      continue;
    }

    if (toolName === "Glob" || toolName === "Grep") {
      stats.exploredCount += countResultLines(event.result?.content) || 1;
      continue;
    }

    if (toolName === "WebSearch" || toolName === "WebFetch" || toolName === "mcp__brevyn__rag_search") {
      stats.searches += 1;
      continue;
    }

    if (toolName === "Bash") {
      stats.commands += 1;
      continue;
    }

    if (toolName === "Skill") {
      stats.skills += 1;
      continue;
    }

    stats.others += 1;
  }
  return stats;
}

function completedToolGroupSummaryParts(stats: ReturnType<typeof toolGroupStats>): string[] {
  const exploredTotal = stats.exploredFiles.size + stats.exploredCount;
  const parts: string[] = [];
  if (stats.editedFiles.size > 0) parts.push(`已编辑 ${stats.editedFiles.size} 个文件`);
  if (exploredTotal > 0) parts.push(`已探索 ${exploredTotal} 个文件`);
  if (stats.searches > 0) parts.push(`已搜索 ${stats.searches} 次`);
  if (stats.commands > 0) parts.push(`已运行 ${stats.commands} 条命令`);
  if (stats.skills > 0) parts.push(`已使用 ${stats.skills} 个技能`);
  if (stats.others > 0) parts.push(`已使用 ${stats.others} 个工具`);
  if (stats.failed > 0) parts.push(`${stats.failed} 个失败`);
  return parts;
}

function completedSingleToolLabel(event: Extract<ProcessEvent, { kind: "tool_use" }>): string {
  const toolName = event.tool.name;
  const input = recordObject(event.tool.input);
  if (toolName === "Read") {
    const path = shortPathLabel(getToolInputPath(input));
    return path ? `已读取 ${path}` : "已读取文件";
  }
  if (toolName === "Glob" || toolName === "Grep") {
    return `已搜索 ${stringValue(input.pattern, "内容")}`;
  }
  if (toolName === "Write") {
    const path = shortPathLabel(getToolInputPath(input));
    return path ? `已创建 ${path}` : "已创建文件";
  }
  if (toolName === "Edit" || toolName === "MultiEdit") {
    const path = shortPathLabel(getToolInputPath(input));
    return path ? `已编辑 ${path}` : "已编辑文件";
  }
  if (toolName === "Bash") return "已运行命令";
  if (toolName === "WebSearch") return `已搜索 ${webSearchLabel(input)}`;
  if (toolName === "WebFetch") return `已打开 ${stringValue(input.url, "网页")}`;
  if (toolName === "mcp__brevyn__rag_search") return `已检索 ${stringValue(input.query, "课程材料")}`;
  if (toolName === "Skill") return `已使用技能 ${stringValue(input.skill ?? input.name ?? input.skillName, "skill")}`;
  return `已使用 ${toolName}`;
}

function isEditTool(toolName: string): boolean {
  return toolName === "Write" || toolName === "Edit" || toolName === "MultiEdit";
}

function toolGroupIconName(stats: ReturnType<typeof toolGroupStats>, events: Extract<ProcessEvent, { kind: "tool_use" }>[]): string {
  return {
    name: stats.editedFiles.size > 0
      ? "Edit"
      : stats.exploredFiles.size + stats.exploredCount > 0
        ? "Read"
        : stats.searches > 0
          ? "WebSearch"
          : stats.commands > 0
            ? "Bash"
            : stats.skills > 0
              ? "Skill"
              : events[0]?.tool.name || "Tool",
  }.name;
}

function toolGroupRunningDisplayEvent(events: Extract<ProcessEvent, { kind: "tool_use" }>[]): Extract<ProcessEvent, { kind: "tool_use" }> | undefined {
  const pendingEvents = events.filter((event) => !event.result);
  if (pendingEvents.length === 0) return undefined;
  const latestPending = pendingEvents.at(-1);
  const targetedPending = [...pendingEvents].reverse().find(toolEventHasTarget);
  if (targetedPending) return targetedPending;
  const latestEvent = events.at(-1);
  if (latestPending && toolEventHasTarget(latestPending)) return latestPending;
  if (latestEvent && latestEvent !== latestPending && toolEventHasTarget(latestEvent)) return latestEvent;
  return [...events].reverse().find(toolEventHasTarget) ?? latestPending;
}

function toolEventHasTarget(event: Extract<ProcessEvent, { kind: "tool_use" }>): boolean {
  const toolName = event.tool.name;
  const input = recordObject(event.tool.input);
  if (input._partialInput === true && toolName === "Read") return false;
  if (toolName === "Read" || toolName === "Write" || toolName === "Edit" || toolName === "MultiEdit") {
    return Boolean(getToolInputPath(input).trim());
  }
  if (toolName === "Glob" || toolName === "Grep") return Boolean(stringValue(input.pattern, "").trim());
  if (toolName === "Bash") return Boolean(stringValue(input.command, "").trim());
  if (toolName === "WebSearch") return Boolean(webSearchLabel(input).trim() && webSearchLabel(input) !== "网页");
  if (toolName === "WebFetch") return Boolean(stringValue(input.url, "").trim());
  if (toolName === "mcp__brevyn__rag_search") return Boolean(stringValue(input.query, "").trim());
  return true;
}

function runningToolLabel(event: Extract<ProcessEvent, { kind: "tool_use" }>): string {
  const toolName = event.tool.name;
  const input = recordObject(event.tool.input);
  if (toolName === "Read") {
    if (input._partialInput === true) return "正在读取文件";
    const path = shortPathLabel(getToolInputPath(input));
    if (!path) return "正在读取文件";
    return `正在读取 ${path}`;
  }
  if (toolName === "Glob") return `正在搜索 ${stringValue(input.pattern, "文件")}`;
  if (toolName === "Grep") return `正在搜索 ${stringValue(input.pattern, "内容")}`;
  if (toolName === "Write" || toolName === "Edit" || toolName === "MultiEdit") {
    const path = shortPathLabel(getToolInputPath(input));
    if (!path) return "正在编辑文件";
    return `正在编辑 ${path}`;
  }
  if (toolName === "Bash") return `正在运行 ${stringValue(input.command, "命令")}`;
  if (toolName === "WebSearch") return `正在搜索 ${webSearchLabel(input)}`;
  if (toolName === "WebFetch") return `正在打开 ${stringValue(input.url, "网页")}`;
  if (toolName === "mcp__brevyn__rag_search") return `正在检索 ${stringValue(input.query, "课程材料")}`;
  if (toolName === "Skill") return `正在使用技能 ${stringValue(input.skill ?? input.name ?? input.skillName, "skill")}`;
  return `正在调用 ${toolName}`;
}

function shortPathLabel(value: string): string {
  const parts = value.split(/[\\/]/g).filter(Boolean);
  return parts.at(-1) || value;
}

function webSearchLabel(input: Record<string, unknown>): string {
  const query = stringValue(input.query, "");
  if (query) return query;
  const queries = Array.isArray(input.queries) ? input.queries : [];
  const first = queries[0];
  if (typeof first === "string" && first.trim()) return first.trim();
  const object = recordObject(first);
  return stringValue(object.query ?? object.search_query ?? object.text, "网页");
}

function countResultLines(content: unknown): number {
  if (typeof content === "string") return content.split("\n").filter((line) => line.trim()).length;
  const data = recordObject(content);
  const text = stringValue(data.stdout ?? data.text ?? data.content, "");
  return text ? text.split("\n").filter((line) => line.trim()).length : 0;
}

function orderedContentItem(item: AgentTimelineViewItem): AgentTimelineViewItem {
  return {
    ...item,
    processEvents: [],
  };
}

function contentSignature(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function orderedAssistantContentBlocks(record: SDKMessage): Array<
  | { type: "thinking"; thinking: string }
  | { type: "text"; text: string; citations?: unknown[] }
  | { type: "tool_use"; tool: ToolUseBlock }
> {
  const content = messageContent(record);
  if (!Array.isArray(content)) return [];
  const blocks: Array<
    | { type: "thinking"; thinking: string }
    | { type: "text"; text: string; citations?: unknown[] }
    | { type: "tool_use"; tool: ToolUseBlock }
  > = [];
  for (const block of content) {
    const item = recordObject(block);
    if (item.type === "thinking") {
      const thinking = stringValue(item.thinking ?? item.text ?? item.content, "");
      if (thinking) blocks.push({ type: "thinking", thinking });
      continue;
    }
    if (item.type === "text") {
      const text = typeof item.text === "string" ? item.text : "";
      const citations = Array.isArray(item.citations) ? item.citations : Array.isArray(item.annotations) ? item.annotations : undefined;
      if (text) blocks.push(citations ? { type: "text", text, citations } : { type: "text", text });
      continue;
    }
    if (item.type === "tool_use" || item.type === "server_tool_use") {
      const hosted = item.type === "server_tool_use";
      const tool: ToolUseBlock = {
        type: "tool_use",
        id: stringValue(item.id, hosted ? "server-tool" : "tool"),
        name: hosted ? "WebSearch" : stringValue(item.name, "tool"),
        input: hosted ? { ...recordObject(item.input), hosted: true } : item.input,
      };
      blocks.push({ type: "tool_use", tool });
    }
  }
  return blocks;
}

function toolResultsById(turnRecords: Array<{ record: AgentTimelineRecord; index: number }>): Map<string, ReturnType<typeof toolResultBlocks>[number]> {
  const results = new Map<string, ReturnType<typeof toolResultBlocks>[number]>();
  for (const { record } of turnRecords) {
    if (!record || isRuntimeRecord(record) || (record as SDKMessage).type !== "user") continue;
    for (const result of toolResultBlocks(record as SDKMessage)) {
      results.set(result.toolUseId, result);
    }
  }
  return results;
}

function approvalDecisionByToolUseId(turnRecords: Array<{ record: AgentTimelineRecord; index: number }>): Map<string, "allow" | "deny"> {
  const requestToolUseIds = new Map<string, string>();
  const decisions = new Map<string, "allow" | "deny">();
  for (const { record } of turnRecords) {
    if (!isRuntimeRecord(record)) continue;
    if (record.event.type === "approval_requested") {
      requestToolUseIds.set(record.event.request.requestId, record.event.request.toolUseId);
    } else if (record.event.type === "approval_resolved") {
      decisions.set(record.event.requestId, record.event.decision);
    }
  }

  const approvalByToolUseId = new Map<string, "allow" | "deny">();
  for (const [requestId, decision] of decisions) {
    const toolUseId = requestToolUseIds.get(requestId);
    if (toolUseId) approvalByToolUseId.set(toolUseId, decision);
  }
  return approvalByToolUseId;
}

function hostedToolResult(block: ToolUseBlock, links: WebCitationLink[] = []): ToolResultBlock | undefined {
  const input = recordObject(block.input);
  if (input.hosted !== true) return undefined;
  return {
    type: "tool_result",
    toolUseId: block.id,
    content: {
      status: stringValue(input.status, "completed"),
      providerStatus: stringValue(input.providerStatus, ""),
      query: webSearchQueryFromInput(input),
      hosted: true,
      links,
    },
    isError: false,
  };
}

function webSearchQueryFromInput(input: Record<string, unknown>): string {
  const query = stringValue(input.query, "");
  if (query) return query;
  const rawInput = recordObject(input.input);
  return stringValue(rawInput.query, "");
}

function webCitationLinksFromTurn(turnRecords: Array<{ record: AgentTimelineRecord; index: number }>): WebCitationLink[] {
  const byUrl = new Map<string, WebCitationLink>();
  for (const { record } of turnRecords) {
    if (!record || isRuntimeRecord(record) || isStreamEventRecord(record)) continue;
    if ((record as SDKMessage).type !== "assistant") continue;
    for (const block of assistantBlocks(record as SDKMessage)) {
      if (block.type !== "text" || !Array.isArray(block.citations)) continue;
      for (const citation of block.citations) {
        const link = webCitationLinkFromCitation(citation);
        if (!link || byUrl.has(link.url)) continue;
        byUrl.set(link.url, link);
      }
    }
  }
  return [...byUrl.values()];
}

function webCitationLinkFromCitation(citation: unknown): WebCitationLink | undefined {
  const object = recordObject(citation);
  const citationType = stringValue(object.type, "");
  if (citationType && citationType !== "web_search_result_location" && citationType !== "url_citation") return undefined;
  const url = stringValue(object.url, "");
  if (!url) return undefined;
  return {
    title: stringValue(object.title, url),
    url,
  };
}

function promptOrProviderErrorItem(item: AgentTimelineViewItem): AgentTimelineViewItem | undefined {
  if (item.displayKind === "prompt-too-long" || item.displayKind === "provider-error") return item;
  return undefined;
}

function appendRunningProcessViewGroup(
  groups: AgentTimelineViewGroup[],
  items: AgentTimelineViewItem[],
  records: AgentTimelineRecord[],
  options?: {
    effectiveRunning?: boolean;
    forceProcessOpen?: boolean;
    runSummary?: RunSummary | null;
    processCollapsedByKey?: Record<string, boolean>;
  },
): AgentTimelineViewGroup[] {
  const summary = options?.runSummary;
  if (!options?.effectiveRunning || !summary?.running) return groups;
  const lastGroup = groups.at(-1);
  if (lastGroup?.type !== "user") return groups;
  const userIndex = records.findIndex((record) => record === lastGroup.item.record);
  const processKey = processStateKey(summary, userIndex >= 0 ? userIndex : undefined, records, userIndex);
  const defaultCollapsed = false;
  const processLockedOpen = Boolean(options.forceProcessOpen);
  const processExpanded = processLockedOpen || !(options.processCollapsedByKey?.[processKey] ?? defaultCollapsed);
  const processItem: AgentTimelineViewItem = {
    ...lastGroup.item,
    displayKind: "process",
    processSummary: summary,
    processEvents: [],
    processExpanded,
    processLockedOpen,
    processCollapsible: false,
    processKey,
    defaultCollapsed,
  };
  return [
    ...groups,
    {
      type: "assistant-turn",
      key: `assistant-running-${processKey}`,
      items: [],
      entries: [],
      collapsedVisibleEntryKeys: [],
      processItem,
    },
  ];
}

function groupKey(prefix: string, items: AgentTimelineViewItem[], processItem?: AgentTimelineViewItem): string {
  if (processItem?.processKey) return `${prefix}-${processItem.processKey}`;
  const first = items[0] ?? processItem;
  if (!first) return prefix;
  return `${prefix}-${recordKey(first.record) || first.processKey}`;
}

function timelineItemDisplay(
  record: AgentTimelineRecord,
  state: {
    processSummary: RunSummary | null;
    approvalDecision?: "allow" | "deny";
    questionAnswers?: Record<string, string>;
    exitPlanDecision?: "approve" | "deny";
  },
): {
  kind: AgentTimelineDisplayKind;
  assistantContent?: string;
  approvalDecision?: "allow" | "deny";
  questionAnswers?: Record<string, string>;
  exitPlanDecision?: "approve" | "deny";
} {
  if (isStreamEventRecord(record)) return { kind: "hidden" };

  if (isRuntimeRecord(record)) {
    if (record.event.type === "run_retrying") return { kind: "run-retrying" };
    if (record.event.type === "approval_requested") {
      return state.approvalDecision
        ? { kind: "hidden", approvalDecision: state.approvalDecision }
        : { kind: "approval-request", approvalDecision: state.approvalDecision };
    }
    if (record.event.type === "ask_user_requested") {
      return state.questionAnswers
        ? { kind: "question-resolved", questionAnswers: state.questionAnswers }
        : { kind: "question-request", questionAnswers: state.questionAnswers };
    }
    if (record.event.type === "exit_plan_requested") {
      return state.exitPlanDecision
        ? { kind: "exit-plan-resolved", exitPlanDecision: state.exitPlanDecision }
        : { kind: "exit-plan-request", exitPlanDecision: state.exitPlanDecision };
    }
    return { kind: "hidden" };
  }

  const message = record as SDKMessage;
  if (message.type === "user") {
    if (isCompactCommandMessage(message) || toolResultBlocks(message).length) return { kind: "hidden" };
    return { kind: "user-message" };
  }

  if (message.type === "assistant") {
    if (isPromptTooLongMessage(message)) {
      return { kind: "prompt-too-long", assistantContent: formatAgentUserError(assistantText(message) || agentErrorMessage(message)) };
    }
    const errorMessage = agentErrorMessage(message);
    if (errorMessage) {
      return { kind: "provider-error", assistantContent: formatAgentUserError(assistantText(message) || errorMessage) };
    }
    const content = assistantBlocks(message).flatMap((block) => block.type === "text" ? [block.text] : []).join("\n\n");
    if (!content.trim()) return { kind: "hidden" };
    return { kind: "assistant-final", assistantContent: content };
  }

  if (message.type === "result") return { kind: "hidden" };

  if (message.type === "system") {
    const subtype = stringValue((message as { subtype?: unknown }).subtype, "");
    if (subtype === "compacting") return { kind: "compact-compacting" };
    if (subtype === "compact_boundary") return { kind: "compact-complete" };
    if (subtype === "compact_failed") return { kind: "compact-failed", assistantContent: stringValue((message as { message?: unknown }).message, "上下文压缩失败") };
    if (subtype === "permission_denied") return { kind: "permission-denied" };
  }

  return { kind: "hidden" };
}
