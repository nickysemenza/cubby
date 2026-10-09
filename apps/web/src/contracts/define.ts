import { z } from "zod";

import type { QueryCachePolicy, RippleKey } from "~/contracts/cache-policy";
import { kernelActionName } from "~/contracts/mcp-define";

/**
 * Transport-neutral operation contracts.
 *
 * A contract names a domain and its operations with their Zod input/output
 * (or event) schemas, plus browser cache policy expressed purely as DATA: a
 * query's `cache` (tags, freshness profile) and a mutation's `invalidates`
 * (named fan-out rows). No React, no query client, no server code, and no
 * function of the input — a policy that must read the input at runtime lives in
 * `integrations/tanstack-query/operation-overrides.ts`. The one server-facing
 * hint is a query's `readPolicy: "strong"` (see `QueryContract`), a
 * data-freshness requirement. That is what lets ONE declaration feed the browser
 * catalog (the generated `integrations/tanstack-query/generated/<module>.gen.ts`, which resolves the cache data and
 * defaults every query's tags to `[domain, member]`), the server implementers
 * (`implementOperationDomain` / `implementSubscriptionDomain`), the operation
 * registry generator (which imports these modules at build time), and the
 * ts-rest HTTP router. Modules under `~/contracts` may import only `zod`,
 * `@cubby/*`, other contracts, and generated entity artifacts; the registry
 * generator enforces that boundary.
 */

interface OperationObservability {
  readonly entities?: readonly string[];
  readonly productPhases?: readonly string[];
}

/**
 * Why a query or mutation is not an MCP tool action. `pnpm generate` fails
 * unless every query and mutation is either named by an action in
 * `contracts/mcp-tools.ts` or declares one of these (never both), so a new
 * operation cannot silently stay off the agent surface. There is no
 * contract-level default: each member declares its own. A `note` says why
 * when the reason alone is not obvious.
 */
const note = z.string().min(1);
export const mcpOmission = z.discriminatedUnion("omit", [
  z.strictObject({
    omit: z.enum([
      /** A web or Apple UI read model, form helper, or UI-only state. */
      "client_view",
      /** A person-triggered Cubby model call; an agent makes that judgment itself. */
      "model_assist",
      /** A person reviews or decides; agents only propose. */
      "human_approval",
      /** Byte or URL plumbing behind an upload. */
      "upload_transport",
      /** Apple app, companion, or in-browser driver protocol. */
      "device_protocol",
      /** Credentials, sign-in, OAuth grants, and login linkage. */
      "auth_connection",
      /** Admin, backfill, repair, and telemetry. */
      "operator_maintenance",
    ]),
    note: note.optional(),
  }),
  /** An exposed, agent-shaped operation serves the same need. */
  z.strictObject({
    omit: z.literal("agent_twin"),
    /** The exposed operation id (`domain.member`); generation checks it. */
    twin: z.string().regex(/^[\w-]+\.\w+$/u),
    note: note.optional(),
  }),
  /**
   * An MCP entity-kernel verb can do it. Recorded as an omission, not as
   * proven parity: `note` says how the verb stands in.
   */
  z.strictObject({
    omit: z.literal("kernel_alternative"),
    kernel: z.tuple([kernelActionName], kernelActionName).readonly(),
    note,
  }),
  /** A real agent capability not yet exposed. */
  z.strictObject({
    omit: z.literal("deferred_capability"),
    /** The bold title of the docs/todos.md entry that lists this operation. */
    todo: z.string().min(1),
    note: note.optional(),
  }),
]);
type McpOmission = z.input<typeof mcpOmission>;

/**
 * `http: false` keeps an operation off the HTTP API while the Start transport
 * and MCP still expose it. Used for operations whose input and output are
 * type-only carriers over a per-entity union, which HTTP serves better as
 * the per-entity resource routes.
 *
 * `native` names the reason the Apple app calls this operation; the generator
 * adds every flagged operation to the swift-openapi-generator filter, so a
 * flagged member is also the only way an RPC id reaches CubbyKit. Resource
 * verbs are flagged on the entity declaration (`native.create/update/delete`)
 * instead.
 *
 * `mcp` records why an operation is not an MCP tool action (`McpOmission`).
 *
 * Ordinary interactive queries and mutations use the authoritative adapter.
 * `readPolicy` remains declaration metadata for specialized read workflows.
 */
export interface QueryContract<
  Input extends z.ZodTypeAny = z.ZodTypeAny,
  Output extends z.ZodTypeAny = z.ZodTypeAny,
> {
  readonly kind: "query";
  /** Large batched reads use a JSON body rather than a bounded URL. */
  readonly transport?: "post";
  readonly input: Input;
  readonly output: Output;
  readonly observability?: OperationObservability;
  readonly http?: false;
  readonly native?: string;
  readonly mcp?: McpOmission;
  readonly readPolicy?: "strong";
  /** Browser cache tags and freshness profile; see `QueryCachePolicy`. */
  readonly cache?: QueryCachePolicy;
}

export interface MutationContract<
  Input extends z.ZodTypeAny = z.ZodTypeAny,
  Output extends z.ZodTypeAny = z.ZodTypeAny,
> {
  readonly kind: "mutation";
  readonly input: Input;
  readonly output: Output;
  readonly observability?: OperationObservability;
  readonly http?: false;
  readonly native?: string;
  readonly mcp?: McpOmission;
  /**
   * The browser fan-out rows a successful call invalidates. Absent or empty
   * invalidates nothing (a mutation that writes no cache-backed state, or whose
   * effect a readiness poll observes).
   */
  readonly invalidates?: readonly RippleKey[];
}

/**
 * A server-pushed NDJSON workflow stream: one request, many events. The event
 * schema is keyed `event` rather than `output` ON PURPOSE — that is what keeps
 * a subscription structurally outside the operation implementer, so the two
 * server tables stay separate without either one having to widen its wall.
 */
export interface SubscriptionContract<
  Input extends z.ZodTypeAny = z.ZodTypeAny,
  Event extends z.ZodTypeAny = z.ZodTypeAny,
> {
  readonly kind: "subscription";
  readonly input: Input;
  readonly event: Event;
}

export type OperationContractMember =
  | QueryContract
  | MutationContract
  | SubscriptionContract;

export interface OperationContract<
  Domain extends string = string,
  Ops extends Record<string, OperationContractMember> = Record<
    string,
    OperationContractMember
  >,
> {
  readonly domain: Domain;
  readonly ops: Ops;
}

/** Member names whose kind is `query` or `mutation`. */
export type OperationMemberName<Ops> = {
  [K in keyof Ops]: Ops[K] extends { kind: "query" | "mutation" } ? K : never;
}[keyof Ops];

/** Member names whose kind is `subscription`. */
export type SubscriptionMemberName<Ops> = {
  [K in keyof Ops]: Ops[K] extends { kind: "subscription" } ? K : never;
}[keyof Ops];

export const defineContract = <
  const Domain extends string,
  const Ops extends Record<string, OperationContractMember>,
>(
  domain: Domain,
  ops: Ops,
): OperationContract<Domain, Ops> => ({ domain, ops });

export const query = <Input extends z.ZodTypeAny, Output extends z.ZodTypeAny>(
  member: Omit<QueryContract<Input, Output>, "kind">,
): QueryContract<Input, Output> => ({ ...member, kind: "query" });

export const mutation = <
  Input extends z.ZodTypeAny,
  Output extends z.ZodTypeAny,
>(
  member: Omit<MutationContract<Input, Output>, "kind">,
): MutationContract<Input, Output> => ({ ...member, kind: "mutation" });

export const subscription = <
  Input extends z.ZodTypeAny,
  Event extends z.ZodTypeAny,
>(
  member: Omit<SubscriptionContract<Input, Event>, "kind">,
): SubscriptionContract<Input, Event> => ({ ...member, kind: "subscription" });
