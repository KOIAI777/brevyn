import { useEffect, useMemo, useRef } from "react";
import { clearAgentLiveRecords, useAgentLiveRecords, useAgentLiveRunning } from "@/lib/agent-live-store";
import type { BrevynAgentTimelineRecord } from "@/types/domain";
import { splitTimelineRecords, type AgentTimelineRecord } from "@/components/agent/agentTimelineModel";

export interface AgentTimelineRecordsState {
  liveRecords: BrevynAgentTimelineRecord[];
  liveRunning: boolean;
  effectiveRunning: boolean;
  historyRecords: AgentTimelineRecord[];
  liveTailRecords: AgentTimelineRecord[];
  timelineRecords: AgentTimelineRecord[];
}

export function useAgentTimelineRecords({
  threadId,
  records,
  running,
}: {
  threadId: string;
  records: BrevynAgentTimelineRecord[];
  running: boolean;
}): AgentTimelineRecordsState {
  const liveRecords = useAgentLiveRecords(threadId);
  const liveRunning = useAgentLiveRunning(threadId);
  const effectiveRunning = running || liveRunning;
  const previousRecordsRef = useRef(records);
  const awaitingRecordsRefreshRef = useRef(false);
  const splitRecords = useMemo(
    () => splitTimelineRecords(records, liveRecords),
    [liveRecords, records],
  );

  useEffect(() => {
    if (liveRunning) {
      awaitingRecordsRefreshRef.current = false;
      return;
    }
    if (liveRecords.length > 0) awaitingRecordsRefreshRef.current = true;
  }, [liveRecords.length, liveRunning]);

  useEffect(() => {
    if (liveRunning || liveRecords.length === 0 || splitRecords.liveTailRecords.length > 0) return;
    awaitingRecordsRefreshRef.current = false;
    clearAgentLiveRecords(threadId);
  }, [liveRecords.length, liveRunning, splitRecords.liveTailRecords.length, threadId]);

  useEffect(() => {
    const recordsChanged = previousRecordsRef.current !== records;
    previousRecordsRef.current = records;
    if (!recordsChanged) return;
    if (!awaitingRecordsRefreshRef.current || liveRunning || liveRecords.length === 0) return;
    awaitingRecordsRefreshRef.current = false;
    clearAgentLiveRecords(threadId);
  }, [liveRecords.length, liveRunning, records, threadId]);

  return {
    liveRecords,
    liveRunning,
    effectiveRunning,
    historyRecords: splitRecords.historyRecords,
    liveTailRecords: splitRecords.liveTailRecords,
    timelineRecords: splitRecords.timelineRecords,
  };
}
