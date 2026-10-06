import { type JSONType, z } from "zod";

import type { MutationContract, QueryContract } from "~/contracts/define";

/**
 * The MCP tool surface is declared as DATA: each tool is a named group of
 * actions, and each action is one `query()`/`mutation()` contract member or one
 * entity-kernel verb. `pnpm generate` binds every member to its
 * `implementOperationDomain` handler (`server/generated/mcp-tools.gen.ts`) and
 * emits the `${tool}.${action}` name unions (`@cubby/schemas/mcp-tools`).
 *
 * A tool's actions are either all queries or all mutations — generation fails
 * otherwise — because MCP clients approve per TOOL: a read-only tool must stay
 * auto-approvable, and one write action inside it would make every read ask.
 */

type OperationMember = QueryContract | MutationContract;
type Kind = "query" | "mutation";

/** Entity-kernel verbs; their schemas and executor live in `server/mcp/kernel-actions.ts`. */
export const kernelActionName = z.enum([
  "get",
  "list",
  "search",
  "preview",
  "resolve",
  "resolveOrCreate",
  "create",
  "update",
  "delete",
  "merge",
  "bulkUpdate",
  "link",
  "unlink",
  "commands",
]);
export type KernelActionName = z.infer<typeof kernelActionName>;

export interface KernelActionRef<K extends Kind = Kind> {
  readonly kernel: KernelActionName;
  readonly kind: K;
}

/**
 * The per-item form of an action: the contract member handles ONE item and the
 * tool accepts `{ items: [...] }`. Items succeed or fail independently and the
 * result is `{ summary, results }` (see `server/mcp/batch.ts`).
 */
interface McpBatchSpec<Output> {
  /** Default 50. */
  readonly maxItems?: number;
  /** Default `summary`: `{ index, status, reference }` per item. */
  readonly resultDetail?: "summary" | "full";
  /** The public identity reported for a succeeded item. */
  readonly reference: (item: Output) => string;
  /** Refuse two items addressing the same `id`. */
  readonly uniqueIds?: true;
}

/** A kernel verb's input: the command object an agent sends. */
type KernelInput = { readonly [field: string]: JSONType };

type MemberInput<Op> = Op extends OperationMember
  ? z.output<Op["input"]>
  : KernelInput;
type MemberOutput<Op> = Op extends OperationMember
  ? z.output<Op["output"]>
  : unknown;

export interface McpActionSpec<
  Op extends OperationMember | KernelActionRef =
    | OperationMember
    | KernelActionRef,
  Projected = unknown,
> {
  readonly op: Op;
  /** What the action does, as the agent reads it in the tool description. */
  readonly description: string;
  /**
   * Token-budget projection of the member's output (slim rows, envelopes).
   * Pure: runs in the MCP adapter after the handler and before `output` parses.
   */
  readonly project?: (
    output: MemberOutput<Op>,
    input: MemberInput<Op>,
  ) => Projected;
  /** The published output when `project` changes the member's shape. */
  readonly output?: z.ZodType<Projected>;
  readonly destructive?: true;
  readonly openWorld?: true;
  /**
   * Refuse unknown input keys instead of stripping them, naming the valid
   * ones — for filter inputs where a misspelled key would silently widen the
   * result (the member's own callers keep the lenient schema).
   */
  readonly strict?: true;
  /**
   * A query that must read the authoritative adapter. A function decides per
   * input (e.g. a snapshot computation versus a paged detail read).
   */
  readonly readPolicy?:
    | "strong"
    | ((input: MemberInput<Op>) => "strong" | "context");
  readonly batch?: McpBatchSpec<Projected>;
  /**
   * The entity a call acted on, for `McpToolCall.entityKind` (a batch passes
   * its first item). Absent, an input `entity` field is used.
   */
  readonly telemetryEntity?: (input: MemberInput<Op>) => string | undefined;
}

export interface McpToolDeclaration {
  /** What the tool is for; each action's own description follows it. */
  readonly description: string;
  readonly actions: Readonly<Record<string, McpActionSpec>>;
}

/** Declare one action; the helper exists only to infer `project`'s types. */
export const mcpAction = <
  const Op extends OperationMember | KernelActionRef,
  Projected = MemberOutput<Op>,
>(
  spec: McpActionSpec<Op, Projected>,
): McpActionSpec =>
  // SAFETY: erasing `Op`/`Projected` only widens what the hooks accept;
  // the adapter hands each hook exactly this action's parsed input and output.
  spec as McpActionSpec;

export const kernelAction = <const K extends Kind>(
  kernel: KernelActionName,
  kind: K,
): KernelActionRef<K> => ({ kernel, kind });

export const defineMcpTools = <
  const Tools extends Readonly<Record<string, McpToolDeclaration>>,
>(
  tools: Tools,
): Tools => tools;

export const isKernelActionRef = (
  op: OperationMember | KernelActionRef,
): op is KernelActionRef => "kernel" in op;
