import type { ReportCommandRequest } from "@cubby/schemas/entity-report";
import {
  workflowCommandRequest,
  type WorkflowCommandMetadata,
} from "@cubby/schemas/workflow-command";
import { z } from "zod";

import type { QueryCachePolicy, RippleKey } from "~/contracts/cache-policy";

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
 * catalog (typed per-domain modules, which resolve the cache data and
 * defaults every query's tags to `[domain, member]`), the server implementers
 * (`implementOperationDomain` / `implementSubscriptionDomain`), the operation
 * registry generator, and the shared HTTP operation route. Modules under
 * `~/contracts` may import only `zod`, `@cubby/*`, other contracts, and
 * generated entity artifacts; the registry generator enforces that boundary.
 */

interface OperationObservability {
  readonly entities?: readonly string[];
  readonly productPhases?: readonly string[];
}

/** Which clients may invoke a query or mutation. Contracts own this decision. */
type OperationExposure = "capability" | "view" | "internal";

export interface OperationContractDefaults {
  /** Default audience for query and mutation members in this contract. */
  readonly exposure?: OperationExposure;
  /** MCP action group; defaults to the contract's domain converted to snake_case. */
  readonly mcpToolGroup?: string;
}

/** A client-facing wire projection for a type-only carrier operation. */
export interface OperationWire {
  readonly input: z.ZodTypeAny;
  readonly output: z.ZodTypeAny;
  /** Null is a successful output value. */
  readonly nullable?: true;
}

/**
 * `operationWire` projects an operation's input and output for generated clients.
 * Entity kernel operations use loose wire schemas while their handlers parse
 * the real per-entity input; a projection can narrow unused input surfaces.
 * The operation handler owns domain validation. Null remains a successful
 * output value.
 *
 * `exposure` determines which clients can invoke the operation. Capability
 * descriptions and behavior hints are consumed by the generated MCP catalog.
 *
 * Ordinary interactive queries and mutations use the authoritative adapter.
 * `readPolicy` remains declaration metadata for specialized read workflows.
 */
export interface QueryContract<
  Input extends z.ZodTypeAny = z.ZodTypeAny,
  Output extends z.ZodTypeAny = z.ZodTypeAny,
> {
  readonly kind: "query";
  readonly input: Input;
  readonly output: Output;
  readonly observability?: OperationObservability;
  readonly operationWire?: OperationWire;
  /** Dynamic consumers may carry JSON rather than per-operation models. */
  readonly nativeModels?: { readonly input?: "json"; readonly output?: "json" };
  readonly exposure?: OperationExposure;
  readonly note?: string;
  readonly description?: string;
  readonly destructive?: true;
  readonly openWorld?: true;
  readonly modelBacked?: true;
  readonly readPolicy?: "strong";
  /** Browser cache tags and freshness profile; see `QueryCachePolicy`. */
  readonly cache?: QueryCachePolicy;
  /**
   * Top-level input keys that attribute a call (a page-mount `runKey`) without
   * changing its answer. They still ride the request but stay out of the
   * browser query key, so a remount reuses the cached answer.
   */
  readonly queryKeyOmit?: readonly string[];
}

export interface MutationContract<
  Input extends z.ZodTypeAny = z.ZodTypeAny,
  Output extends z.ZodTypeAny = z.ZodTypeAny,
> {
  readonly kind: "mutation";
  /** Explicit whitelist for shared user command invocation; never inferred from mutation kind. */
  readonly command?: WorkflowCommandMetadata;
  readonly input: Input;
  readonly output: Output;
  readonly observability?: OperationObservability;
  readonly operationWire?: OperationWire;
  readonly nativeModels?: { readonly input?: "json"; readonly output?: "json" };
  readonly exposure?: OperationExposure;
  readonly note?: string;
  readonly description?: string;
  readonly destructive?: true;
  readonly openWorld?: true;
  readonly modelBacked?: true;
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
  readonly exposure?: OperationExposure;
  readonly mcpToolGroup?: string;
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
  defaults: OperationContractDefaults = {},
): OperationContract<Domain, Ops> => ({ domain, ops, ...defaults });

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

type Template<T> = T extends readonly (infer Item)[]
  ? Template<Item>[]
  : T extends object
    ? { [K in keyof T]: Template<T[K]> }
    : T | null;
type MutationName<C extends OperationContract> = {
  [K in keyof C["ops"]]: C["ops"][K] extends MutationContract ? K : never;
}[keyof C["ops"]] &
  string;

/** The existing operation validates the completed body; construction pins its exact field names. */
export function operationCommandRequest<
  C extends OperationContract,
  K extends MutationName<C>,
>(
  contract: C,
  member: K,
  body: Template<z.input<C["ops"][K]["input"]>>,
  bindings?: Record<string, string>,
): Extract<ReportCommandRequest, { kind: "operation" }> {
  const definition = contract.ops[member];
  if (definition?.kind !== "mutation" || !definition.command)
    throw new Error(
      `${contract.domain}.${member} is not a declared user command`,
    );
  return workflowCommandRequest.parse({
    kind: "operation",
    operation: `${contract.domain}.${member}`,
    // Match the operation's JSON transport: omit absent optional fields, preserving nulls.
    body: JSON.parse(JSON.stringify(body)),
    bindings,
  });
}
