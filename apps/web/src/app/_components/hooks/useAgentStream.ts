import type { AgentResult } from "@cubby/schemas/agent";
import { useCallback, useEffect, useRef, useState } from "react";

import { askAgentStream } from "~/lib/agent.functions";
import { getErrorMessage } from "~/lib/error-utils";

interface AgentStreamState {
  /** Live answer text, updated as deltas arrive and finalized on done. */
  answer: string;
  /** Name of the tool currently being called, if any (for a "looking up…" hint). */
  toolStatus: string | null;
  /** Cited sources + tool-call telemetry, available once the run completes. */
  result: Pick<AgentResult, "sources" | "toolCalls"> | null;
  isStreaming: boolean;
  error: string | null;
}

const EMPTY: AgentStreamState = {
  answer: "",
  toolStatus: null,
  result: null,
  isStreaming: false,
  error: null,
};

/**
 * Streams the agent workflow for a progressive "typing" reveal. Accumulates
 * answer deltas and resets on each `tool` event (text before a tool call was
 * narration), mirroring the server's segment logic.
 */
export function useAgentStream() {
  const [state, setState] = useState<AgentStreamState>(EMPTY);
  // Monotonic id so a reset / new ask supersedes any in-flight stream.
  const runIdRef = useRef(0);
  const abortRef = useRef<AbortController | null>(null);
  useEffect(() => () => abortRef.current?.abort(), []);

  const reset = useCallback(() => {
    abortRef.current?.abort();
    abortRef.current = null;
    runIdRef.current++;
    setState(EMPTY);
  }, []);

  const ask = useCallback(async (query: string) => {
    const trimmed = query.trim();
    if (trimmed.length === 0) return;

    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;
    const runId = ++runIdRef.current;
    setState({ ...EMPTY, isStreaming: true });

    let acc = "";
    try {
      const iterable = await askAgentStream(
        { query: trimmed },
        controller.signal,
      );
      for await (const event of iterable) {
        if (runIdRef.current !== runId) return; // superseded

        if (event.type === "delta") {
          acc += event.text;
          setState((s) => ({ ...s, answer: acc }));
        } else if (event.type === "tool") {
          acc = "";
          setState((s) => ({ ...s, answer: "", toolStatus: event.tool }));
        } else {
          setState((s) => ({
            ...s,
            answer: acc.trim(),
            toolStatus: null,
            isStreaming: false,
            result: { sources: event.sources, toolCalls: event.toolCalls },
          }));
        }
      }
    } catch (error) {
      if (runIdRef.current === runId && !controller.signal.aborted) {
        setState((s) => ({
          ...s,
          isStreaming: false,
          toolStatus: null,
          error: getErrorMessage(error),
        }));
      }
    } finally {
      if (abortRef.current === controller) abortRef.current = null;
    }
  }, []);

  return { ...state, ask, reset };
}
