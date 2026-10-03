/**
 * The scenario script the workerd harness's deterministic model plays
 * (`tests/e2e/harness-services/purchase-agent-test-model.ts`). Only the model
 * is scripted: Flue, its tools, the MCP server, queue events, and the web
 * Worker's writers are production code.
 */
export type ScriptValue =
  | string
  | number
  | boolean
  | null
  | ScriptValue[]
  | { $from: string; path: string }
  | { [key: string]: ScriptValue };

export type ScriptStep =
  /** Emit one tool call; skipped once its call id is in the conversation. */
  | { call: string; tool: string; args: Record<string, ScriptValue> }
  /**
   * End the submission with text until one marker reaches the conversation.
   * A marker may name a prior output value: the browser result for one
   * command arrives as the signal event `browser-result:<commandId>`.
   */
  | { await: AwaitMarker[]; text?: string }
  /** Record a violation when a prior tool output lacks a substring. */
  | { check: string; includes: string };

/** Read a value from a prior tool call's output: `from("claim", "kind")`. */
export const from = (callId: string, path: string) => ({
  $from: callId,
  path,
});

export const call = (
  id: string,
  tool: string,
  args: Record<string, ScriptValue> = {},
): ScriptStep => ({ call: id, tool, args: { operationId: id, ...args } });

/** An MCP mutation: Cubby's stable run envelope plus the tool's own fields. */
export const mcp = (
  id: string,
  tool: string,
  runId: string,
  args: Record<string, ScriptValue>,
  envelope: Record<string, ScriptValue> = {},
): ScriptStep => ({
  call: id,
  tool: `mcp__cubby__${tool}`,
  args: { ...args, _runExecution: { runId, operationId: id, ...envelope } },
});

/** A read-only MCP call carries no run envelope. */
export const mcpRead = (
  id: string,
  tool: string,
  args: Record<string, ScriptValue>,
): ScriptStep => ({ call: id, tool: `mcp__cubby__${tool}`, args });

export type AwaitMarker =
  | string
  | { $from: string; path: string; prefix: string };

export const awaitEvent = (...markers: string[]): ScriptStep => ({
  await: markers.map((marker) => `purchase-import.${marker}`),
});

/** Wait for the browser result of one specific command step. */
export const awaitBrowserResult = (browserCallId: string): ScriptStep => ({
  await: [
    { $from: browserCallId, path: "commandId", prefix: "browser-result:" },
  ],
});
