import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import type { RefCallback } from "react";
import { useStickToBottom } from "use-stick-to-bottom";

export interface AgentScrollState {
  scrollRef: RefCallback<HTMLDivElement>;
  contentRef: RefCallback<HTMLDivElement>;
  isFollowingOutput: boolean;
  scrollToBottom: (behavior: ScrollBehavior) => void;
}

interface UseAgentScrollStateOptions {
  ready?: boolean;
  transitioning?: boolean;
}

const scrollPositionByThread = new Map<string, number>();

export function useAgentScrollState(threadId: string, options: UseAgentScrollStateOptions = {}): AgentScrollState {
  const ready = options.ready ?? true;
  const transitioning = options.transitioning ?? false;
  const sticky = useStickToBottom({
    initial: "instant",
    resize: ready && !transitioning ? "smooth" : "instant",
  });
  const scrollToBottomRef = useRef(sticky.scrollToBottom);
  const stopScrollRef = useRef(sticky.stopScroll);
  const restoredThreadRef = useRef("");
  const restoredRef = useRef(false);

  scrollToBottomRef.current = sticky.scrollToBottom;
  stopScrollRef.current = sticky.stopScroll;

  useLayoutEffect(() => {
    if (!ready) return;
    const node = sticky.scrollRef.current as HTMLDivElement | null;
    if (!node) return;
    if (restoredThreadRef.current !== threadId) {
      restoredThreadRef.current = "";
      restoredRef.current = false;
    }
    if (restoredRef.current) return;
    restoredThreadRef.current = threadId;
    restoredRef.current = true;

    const savedDistance = scrollPositionByThread.get(threadId);
    if (typeof savedDistance === "number" && savedDistance > 16) {
      stopScrollRef.current();
      const restore = () => {
        const nextTop = node.scrollHeight - node.clientHeight - savedDistance;
        node.scrollTop = Math.max(0, nextTop);
      };
      restore();
      const frame = window.requestAnimationFrame(restore);
      return () => window.cancelAnimationFrame(frame);
    }

    void scrollToBottomRef.current({ animation: "instant", ignoreEscapes: true });
  }, [ready, sticky.scrollRef, threadId]);

  useEffect(() => {
    if (!ready || !restoredRef.current) return;
    const node = sticky.scrollRef.current as HTMLDivElement | null;
    if (!node) return;
    let frame = 0;
    const savePosition = () => {
      if (frame) return;
      frame = window.requestAnimationFrame(() => {
        frame = 0;
        const distance = node.scrollHeight - node.scrollTop - node.clientHeight;
        scrollPositionByThread.set(threadId, Math.max(0, distance));
      });
    };

    node.addEventListener("scroll", savePosition, { passive: true });
    return () => {
      node.removeEventListener("scroll", savePosition);
      if (frame) window.cancelAnimationFrame(frame);
    };
  }, [ready, sticky.scrollRef, threadId]);

  const scrollToBottom = useCallback((behavior: ScrollBehavior) => {
    void scrollToBottomRef.current({
      animation: behavior === "smooth" ? "smooth" : "instant",
      ignoreEscapes: true,
    });
  }, []);

  return {
    scrollRef: sticky.scrollRef as RefCallback<HTMLDivElement>,
    contentRef: sticky.contentRef as RefCallback<HTMLDivElement>,
    isFollowingOutput: sticky.isAtBottom || sticky.isNearBottom,
    scrollToBottom,
  };
}
