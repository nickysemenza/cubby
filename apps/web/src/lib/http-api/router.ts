import {
  ContractNoBody,
  initContract,
  type RouterOptions,
} from "@ts-rest/core";
import { z } from "zod";

import type { MutationContract, QueryContract } from "~/contracts/define";
import {
  type DetailEntity,
  getEntityDetailOutputSchema,
} from "~/entities/generated/entity-details.gen";
import {
  getEntityListOutputSchema,
  type ListEntity,
} from "~/entities/generated/entity-lists.gen";
import { entityDeleteResultSchema } from "~/server/entity-kernel/contracts";
import {
  ENTITY_SCHEMA_BINDINGS,
  generatedEntityMutationCreateResultSchema,
  generatedEntityMutationUpdateResultSchema,
} from "~/server/generated/entity-bindings.gen";
import { publicStartOperationErrorSchema } from "~/server/start-operation.contract";

import { resourceListQuery } from "./resource-query";
import { isFlatQueryInput, type Json, toWire } from "./wire";

/**
 * Route metadata the server handler dispatches on. `input` describes how an
 * RPC route carries its operation input (object inputs are the query/body
 * itself; anything else travels under `input`; `none` and `null` routes
 * accept `{}` and dispatch `undefined` or `null`); `transport` says whether a
 * query travels as GET parameters or as a POST body; `resource` marks the
 * REST routes derived from entity capabilities.
 */
export const httpMetadataSchema = z.object({
  operation: z.string(),
  input: z.enum(["object", "wrapped", "none", "null"]).optional(),
  transport: z.enum(["get", "post"]).optional(),
  entity: z.string().optional(),
  resource: z.enum(["list", "get", "create", "update", "delete"]).optional(),
});
export type HttpMetadata = z.output<typeof httpMetadataSchema>;

/**
 * The one error body every failure status shares: the public operation error
 * itself, named `ApiError` in the document. Registered with `add` rather than
 * `.meta()`, which would clone the schema and break the wire memo.
 */
const apiError = toWire(publicStartOperationErrorSchema, "output");
z.globalRegistry.add(apiError, { id: "ApiError" });
const commonResponses = {
  400: apiError,
  401: apiError,
  403: apiError,
  404: apiError,
  409: apiError,
  412: apiError,
  500: apiError,
};

type IsObjectInput<T> = T extends readonly unknown[]
  ? false
  : T extends object
    ? true
    : false;
/** What a route's query (GET) or body (POST) carries for an operation input. */
type RpcInput<I extends z.ZodTypeAny> =
  z.input<I> extends undefined | null
    ? Record<string, never>
    : IsObjectInput<z.input<I>> extends true
      ? Json<z.input<I>>
      : { input: Json<z.input<I>> };

/**
 * Objects and unions of objects (recursively) are carried as fields; anything
 * else is wrapped in `{ input }`.
 */
const isObjectLike = (wire: z.core.$ZodType): boolean =>
  wire instanceof z.ZodObject ||
  (wire instanceof z.ZodUnion && wire.options.every(isObjectLike));

/**
 * How an RPC route carries its input, decided on the wire projection for the
 * transport: the query projection for GET parameters, the input projection
 * for a JSON body.
 */
const rpcInput = <I extends z.ZodTypeAny>(input: I, io: "query" | "input") => {
  if (input instanceof z.ZodUndefined || input instanceof z.ZodNull) {
    const empty: z.ZodType = z.strictObject({});
    // SAFETY: `RpcInput` maps an undefined or null input to the empty object.
    return {
      carrier:
        input instanceof z.ZodNull ? ("null" as const) : ("none" as const),
      wire: empty as z.ZodType<RpcInput<I>, RpcInput<I>>,
    };
  }
  const wire = toWire(input, io);
  const carrier = isObjectLike(wire)
    ? ("object" as const)
    : ("wrapped" as const);
  const carried = carrier === "object" ? wire : z.strictObject({ input: wire });
  // SAFETY: `carried` is built from `carrier`, which is the runtime twin of
  // the `RpcInput` conditional type over the same input schema; the query
  // projection also accepts the JSON form that type spells.
  return { carrier, wire: carried as z.ZodType<RpcInput<I>, RpcInput<I>> };
};

const rpcPath = (domain: string, member: string) => `/${domain}/${member}`;

/**
 * A flat-input `query` contract member as `GET /<domain>/<member>` with one
 * query parameter per field. The registry generator picks this helper with
 * `isFlatQueryInput`; the assertion keeps a hand-written route honest.
 */
export const rpcQuery = <I extends z.ZodTypeAny, O extends z.ZodTypeAny>(
  domain: string,
  member: string,
  operation: QueryContract<I, O>,
) => {
  if (
    !(operation.input instanceof z.ZodUndefined) &&
    !isFlatQueryInput(toWire(operation.input, "input"))
  )
    throw new Error(`${domain}.${member} needs a POST body: use rpcQueryPost`);
  const { carrier, wire } = rpcInput(operation.input, "query");
  return {
    method: "GET" as const,
    path: rpcPath(domain, member),
    query: wire,
    responses: { 200: toWire(operation.output, "output") },
    metadata: {
      operation: `${domain}.${member}`,
      input: carrier,
      transport: "get",
    } satisfies HttpMetadata,
  };
};

/**
 * A structured-input `query` contract member as `POST /<domain>/<member>`
 * with the input as the JSON body. Still a read for the browser transport;
 * `transport: "post"` is the only difference from a flat query.
 */
export const rpcQueryPost = <I extends z.ZodTypeAny, O extends z.ZodTypeAny>(
  domain: string,
  member: string,
  operation: QueryContract<I, O>,
) => {
  const { carrier, wire } = rpcInput(operation.input, "input");
  return {
    method: "POST" as const,
    path: rpcPath(domain, member),
    body: wire,
    responses: { 200: toWire(operation.output, "output") },
    metadata: {
      operation: `${domain}.${member}`,
      input: carrier,
      transport: "post",
    } satisfies HttpMetadata,
  };
};

/** A `mutation` contract member as `POST /<domain>/<member>`. */
export const rpcMutation = <I extends z.ZodTypeAny, O extends z.ZodTypeAny>(
  domain: string,
  member: string,
  operation: MutationContract<I, O>,
) => {
  const { carrier, wire } = rpcInput(operation.input, "input");
  return {
    method: "POST" as const,
    path: rpcPath(domain, member),
    body: wire,
    responses: { 200: toWire(operation.output, "output") },
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
  responses: { 200: toWire(getEntityListOutputSchema(entity), "output") },
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
  responses: { 200: toWire(getEntityDetailOutputSchema(entity), "output") },
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
    201: toWire(
      mutationResultFor(
        generatedEntityMutationCreateResultSchema,
        entity,
      ) as z.ZodType<Extract<CreateResult, { entity: E }>>,
      "output",
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
    200: toWire(
      mutationResultFor(
        generatedEntityMutationUpdateResultSchema,
        entity,
      ) as z.ZodType<Extract<UpdateResult, { entity: E }>>,
      "output",
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
  responses: { 200: toWire(entityDeleteResultSchema, "output") },
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
