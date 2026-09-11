import {
  ContractNoBody,
  initContract,
  type RouterOptions,
} from "@ts-rest/core";
import { z } from "zod";

import type { MutationContract, QueryContract } from "~/contracts/define";
import * as contracts from "~/contracts/index";
import {
  type DetailEntity,
  detailEntities,
  entityDetailInputSchema,
  getEntityDetailOutputSchema,
} from "~/entities/generated/entity-details.gen";
import {
  entityListInputSchema,
  getEntityListOutputSchema,
  type ListEntity,
  listEntities,
} from "~/entities/generated/entity-lists.gen";
import {
  entityBrowserMutationCommandSchema,
  entityBrowserMutationResultSchema,
  entityDeleteResultSchema,
} from "~/server/entity-kernel/contracts";
import {
  ENTITY_SCHEMA_BINDINGS,
  generatedEntityMutationCreateResultSchema,
  generatedEntityMutationUpdateResultSchema,
} from "~/server/generated/entity-bindings.gen";
import { publicStartOperationErrorSchema } from "~/server/start-operation.contract";

import { resourceListQuery } from "./resource-query";
import { type Json, toWire, type WireOptions } from "./wire";

/**
 * Route metadata the server handler dispatches on. `input` describes how an
 * RPC route carries its operation input (object inputs are the query/body
 * itself; anything else travels under `input`; no-input routes accept `{}`);
 * `resource` marks the REST routes derived from entity capabilities.
 */
export const httpMetadataSchema = z.object({
  operation: z.string(),
  input: z.enum(["object", "wrapped", "none"]).optional(),
  entity: z.string().optional(),
  resource: z.enum(["list", "get", "create", "update", "delete"]).optional(),
});
export type HttpMetadata = z.output<typeof httpMetadataSchema>;

/** The one failure envelope every error status shares. */
const failureEnvelope = z
  .object({ ok: z.literal(false), error: publicStartOperationErrorSchema })
  .meta({ id: "ErrorEnvelope" });

const commonResponses = {
  400: failureEnvelope,
  401: failureEnvelope,
  403: failureEnvelope,
  404: failureEnvelope,
  409: failureEnvelope,
  412: failureEnvelope,
  500: failureEnvelope,
};

/**
 * Entity operations declare type-only carriers in their contracts because the
 * per-entity runtime schemas live in generated bindings; on the wire they are
 * the real discriminated unions.
 */
const entityWire = new Map<z.ZodType, z.ZodType>([
  [
    contracts.entityListContract.ops.list.input,
    toWire(entityListInputSchema, "input"),
  ],
  [
    contracts.entityListContract.ops.list.output,
    toWire(z.union(listEntities.map(getEntityListOutputSchema)), "output"),
  ],
  [
    contracts.entityDetailContract.ops.detail.input,
    toWire(entityDetailInputSchema, "input"),
  ],
  [
    contracts.entityDetailContract.ops.detail.output,
    toWire(
      z.union(detailEntities.map(getEntityDetailOutputSchema)).nullable(),
      "output",
    ),
  ],
  [
    contracts.entityMutationContract.ops.mutate.input,
    toWire(entityBrowserMutationCommandSchema, "input"),
  ],
  [
    contracts.entityMutationContract.ops.mutate.output,
    toWire(entityBrowserMutationResultSchema, "output"),
  ],
]);
const wireOptions: WireOptions = { overrides: entityWire };

type Ok<O extends z.ZodTypeAny> = { ok: true; data: Json<z.output<O>> };
const ok = <O extends z.ZodTypeAny>(output: O): z.ZodType<Ok<O>> =>
  z.object({
    ok: z.literal(true),
    data: toWire(output, "output", wireOptions),
  });

type IsObjectInput<T> = T extends readonly unknown[]
  ? false
  : T extends object
    ? true
    : false;
/** What a route's query (GET) or body (POST) carries for an operation input. */
type RpcInput<I extends z.ZodTypeAny> =
  z.input<I> extends undefined
    ? Record<string, never>
    : IsObjectInput<z.input<I>> extends true
      ? Json<z.input<I>>
      : { input: Json<z.input<I>> };

/**
 * Objects and unions of objects (recursively — the entity mutation command is
 * a union of per-entity unions) are carried as fields; anything else is
 * wrapped in `{ input }`.
 */
const isObjectLike = (wire: z.core.$ZodType): boolean =>
  wire instanceof z.ZodObject ||
  (wire instanceof z.ZodUnion && wire.options.every(isObjectLike));

/**
 * How an RPC route carries its input, decided on the WIRE schema so that a
 * type-only carrier whose real schema is an object union (the entity
 * operations) is still carried as fields.
 */
const rpcInput = <I extends z.ZodTypeAny>(input: I) => {
  if (input instanceof z.ZodUndefined) {
    const empty: z.ZodType = z.strictObject({});
    // SAFETY: `RpcInput` maps an undefined input to the empty object.
    return {
      carrier: "none" as const,
      wire: empty as z.ZodType<RpcInput<I>, RpcInput<I>>,
    };
  }
  const wire = toWire(input, "input", wireOptions);
  const carrier = isObjectLike(wire)
    ? ("object" as const)
    : ("wrapped" as const);
  const carried = carrier === "object" ? wire : z.strictObject({ input: wire });
  // SAFETY: `carried` is built from `carrier`, which is the runtime twin of
  // the `RpcInput` conditional type over the same input schema.
  return { carrier, wire: carried as z.ZodType<RpcInput<I>, RpcInput<I>> };
};

const rpcPath = (domain: string, member: string) => `/${domain}/${member}`;

/** A `query` contract member as `GET /<domain>/<member>`. */
export const rpcQuery = <I extends z.ZodTypeAny, O extends z.ZodTypeAny>(
  domain: string,
  member: string,
  operation: QueryContract<I, O>,
) => {
  const { carrier, wire } = rpcInput(operation.input);
  return {
    method: "GET" as const,
    path: rpcPath(domain, member),
    query: wire,
    responses: { 200: ok(operation.output) },
    metadata: {
      operation: `${domain}.${member}`,
      input: carrier,
    } satisfies HttpMetadata,
  };
};

/** A `mutation` contract member as `POST /<domain>/<member>`. */
export const rpcMutation = <I extends z.ZodTypeAny, O extends z.ZodTypeAny>(
  domain: string,
  member: string,
  operation: MutationContract<I, O>,
) => {
  const { carrier, wire } = rpcInput(operation.input);
  return {
    method: "POST" as const,
    path: rpcPath(domain, member),
    body: wire,
    responses: { 200: ok(operation.output) },
    metadata: {
      operation: `${domain}.${member}`,
      input: carrier,
    } satisfies HttpMetadata,
  };
};

type Bindings = typeof ENTITY_SCHEMA_BINDINGS;
type BoundEntity = keyof Bindings;
type ResourceEntity<E extends BoundEntity> = E;

const pathParamsFor = <E extends BoundEntity>(entity: E) =>
  z.object({ id: ENTITY_SCHEMA_BINDINGS[entity].id });

const requiredSchema = <E extends BoundEntity>(
  entity: E,
  purpose: "createInput" | "updateInput",
): NonNullable<Bindings[E][typeof purpose]> => {
  const schema = ENTITY_SCHEMA_BINDINGS[entity][purpose];
  if (schema === null)
    throw new Error(`${entity} declares no ${purpose} for its HTTP resource`);
  // SAFETY: the null branch was just excluded; the binding's declared type is
  // the non-null member of the union.
  return schema as NonNullable<Bindings[E][typeof purpose]>;
};

type CreateResult = z.output<typeof generatedEntityMutationCreateResultSchema>;
type UpdateResult = z.output<typeof generatedEntityMutationUpdateResultSchema>;

const mutationResultFor = <
  Union extends z.ZodDiscriminatedUnion,
  E extends string,
>(
  union: Union,
  entity: E,
) => {
  const option = union.options.find(
    (candidate) =>
      candidate instanceof z.ZodObject &&
      candidate.shape.entity instanceof z.ZodLiteral &&
      candidate.shape.entity.value === entity,
  );
  if (!option)
    throw new Error(`${entity} has no generated mutation result schema`);
  return option;
};

/** `GET /<plural>`: the entity list with flat query parameters. */
export const resourceList = <E extends ListEntity & BoundEntity>(
  entity: ResourceEntity<E>,
  basePath: string,
) => ({
  method: "GET" as const,
  path: `/${basePath}`,
  query: resourceListQuery(ENTITY_SCHEMA_BINDINGS[entity].filters),
  responses: { 200: ok(getEntityListOutputSchema(entity)) },
  metadata: {
    operation: "entity.list",
    entity,
    resource: "list",
  } satisfies HttpMetadata,
});

/** `GET /<plural>/:id`: the entity detail, 404 when absent. */
export const resourceGet = <E extends DetailEntity & BoundEntity>(
  entity: ResourceEntity<E>,
  basePath: string,
) => ({
  method: "GET" as const,
  path: `/${basePath}/:id`,
  pathParams: pathParamsFor(entity),
  responses: { 200: ok(getEntityDetailOutputSchema(entity)) },
  metadata: {
    operation: "entity.detail",
    entity,
    resource: "get",
  } satisfies HttpMetadata,
});

/** `POST /<plural>`: create; 201 with a Location header. */
export const resourceCreate = <E extends BoundEntity>(
  entity: ResourceEntity<E>,
  basePath: string,
) => ({
  method: "POST" as const,
  path: `/${basePath}`,
  body: toWire(requiredSchema(entity, "createInput"), "input"),
  responses: {
    // SAFETY: the option is selected by its `entity` literal, which is the
    // discriminant the `Extract` narrows on.
    201: ok(
      mutationResultFor(
        generatedEntityMutationCreateResultSchema,
        entity,
      ) as z.ZodType<Extract<CreateResult, { entity: E }>>,
    ),
  },
  metadata: {
    operation: "entity.mutate",
    entity,
    resource: "create",
  } satisfies HttpMetadata,
});

/** `PATCH /<plural>/:id`: partial update. */
export const resourceUpdate = <E extends BoundEntity>(
  entity: ResourceEntity<E>,
  basePath: string,
) => ({
  method: "PATCH" as const,
  path: `/${basePath}/:id`,
  pathParams: pathParamsFor(entity),
  body: toWire(requiredSchema(entity, "updateInput"), "input"),
  responses: {
    // SAFETY: as for create — selected by the `entity` discriminant.
    200: ok(
      mutationResultFor(
        generatedEntityMutationUpdateResultSchema,
        entity,
      ) as z.ZodType<Extract<UpdateResult, { entity: E }>>,
    ),
  },
  metadata: {
    operation: "entity.mutate",
    entity,
    resource: "update",
  } satisfies HttpMetadata,
});

/** `DELETE /<plural>/:id`: no body; the kernel's normalized delete result. */
export const resourceDelete = <E extends BoundEntity>(
  entity: ResourceEntity<E>,
  basePath: string,
) => ({
  method: "DELETE" as const,
  path: `/${basePath}/:id`,
  pathParams: pathParamsFor(entity),
  body: ContractNoBody,
  responses: { 200: ok(entityDeleteResultSchema) },
  metadata: {
    operation: "entity.mutate",
    entity,
    resource: "delete",
  } satisfies HttpMetadata,
});

/**
 * The generated contract calls `httpContractBuilder.router(routes,
 * httpRouterOptions)` directly: ts-rest infers the router's static shape from
 * the literal it is handed, and that inference does not survive a generic
 * wrapper, which is what keeps `createCubbyClient` fully typed.
 */
export const httpContractBuilder = initContract();
export const httpRouterOptions = {
  pathPrefix: "/api/v1",
  strictStatusCodes: true,
  commonResponses,
} as const satisfies RouterOptions<"/api/v1">;
