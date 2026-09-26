import type { z } from "zod";

/**
 * Transport-neutral operation contracts.
 *
 * A contract names a domain and its operations with their Zod input/output
 * (or event) schemas and nothing else: no cache policy, no invalidation, no
 * React, no server code. That is what lets ONE declaration feed the browser
 * catalog (`defineOperationDomain`), the server implementers
 * (`implementOperationDomain` / `implementSubscriptionDomain`), the operation
 * registry generator (which imports these modules at build time), and the
 * ts-rest HTTP router. Modules under `~/contracts` may import only `zod`,
 * `@cubby/*`, other contracts, and generated entity artifacts; the registry
 * generator enforces that boundary.
 */

/**
 * Publishes the operation as an MCP tool that calls its
 * `implementOperationDomain` handler directly and validates against this
 * member's own object-rooted `input`/`output` schemas. The name, description,
 * and schemas are an outward contract for MCP clients. Annotations follow
 * `kind`; `destructive` and `openWorld` mark the exceptions. `readPolicy:
 * "strong"` keeps an MCP read on the authoritative adapter where the shared
 * operation read policy would accept the request-selected one.
 */
export interface McpToolSpec {
  readonly name: string;
  readonly description: string;
  readonly destructive?: true;
  readonly openWorld?: true;
  readonly readPolicy?: "strong";
}

interface OperationObservability {
  readonly entities?: readonly string[];
  readonly productPhases?: readonly string[];
}

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
 */
export interface QueryContract<
  Input extends z.ZodTypeAny = z.ZodTypeAny,
  Output extends z.ZodTypeAny = z.ZodTypeAny,
> {
  readonly kind: "query";
  readonly input: Input;
  readonly output: Output;
  readonly observability?: OperationObservability;
  readonly http?: false;
  readonly native?: string;
  readonly mcp?: McpToolSpec;
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
  readonly mcp?: McpToolSpec;
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
