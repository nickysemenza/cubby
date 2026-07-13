import type { AgentResult } from "@cubby/schemas/agent";
import { useCallback, useRef, useState } from "react";
import { useTRPCClient } from "~/integrations/trpc/react";
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
 * Streams `agent.askStream` for a progressive "typing" reveal. Accumulates
 * answer deltas and resets on each `tool` event (text before a tool call was
 * narration), mirroring the server's segment logic. Uses the vanilla tRPC
 * client (httpBatchStreamLink) since React Query hooks don't expose the
 * incremental generator.
 */
export function useAgentStream() {
  const client = useTRPCClient();
  const [state, setState] = useState<AgentStreamState>(EMPTY);
  // Monotonic id so a reset / new ask supersedes any in-flight stream.
  const runIdRef = useRef(0);

  const reset = useCallback(() => {
    runIdRef.current++;
    setState(EMPTY);
  }, []);

  const ask = useCallback(
    async (query: string) => {
      const trimmed = query.trim();
      if (trimmed.length === 0) return;

      const runId = ++runIdRef.current;
      setState({ ...EMPTY, isStreaming: true });

      let acc = "";
      try {
        const iterable = await client.agent.askStream.query({ query: trimmed });
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
        if (runIdRef.current === runId) {
          setState((s) => ({
            ...s,
            isStreaming: false,
            toolStatus: null,
            error: getErrorMessage(error),
          }));
        }
      }
    },
    [client],
  );

  return { ...state, ask, reset };
}
