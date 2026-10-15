import { initContract, type RouterOptions } from "@ts-rest/core";
import { z } from "zod";

import type { MutationContract, QueryContract } from "~/contracts/define";
import { publicStartOperationErrorSchema } from "~/server/operation-runtime/start-operation.contract";

import { isFlatQueryInput, type Json, toWire } from "./wire";

/**
 * Route metadata the server handler dispatches on. `input` describes how an
 * RPC route carries its operation input (object inputs are the query/body
 * itself; anything else travels under `input`; `none` and `null` routes
 * accept `{}` and dispatch `undefined` or `null`); `transport` says whether a
 * query travels as GET parameters or as a POST body.
 */
export const httpMetadataSchema = z.object({
  operation: z.string(),
  input: z.enum(["object", "wrapped", "none", "null"]).optional(),
  transport: z.enum(["get", "post"]).optional(),
  /** The operation answers `null` for "no such thing"; HTTP answers 404. */
  nullableOutput: z.boolean().optional(),
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
 * A query whose output is `X | null` documents `X` and turns null into a 404:
 * a response body that may be `null` is
 * something generated clients cannot express.
 */
const rpcOutput = <O extends z.ZodTypeAny>(output: O) => {
  const inner = output instanceof z.ZodNullable ? output.unwrap() : undefined;
  const concrete = inner instanceof z.ZodType ? inner : output;
  // SAFETY: the response is the output with null removed; the handler maps a
  // null result to 404 before any body is written.
  const response = toWire(concrete, "output") as z.ZodType<
    Json<NonNullable<z.output<O>>>
  >;
  return { nullable: inner !== undefined, response };
};

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
  const { nullable, response } = rpcOutput(operation.output);
  return {
    method: "GET" as const,
    path: rpcPath(domain, member),
    query: wire,
    responses: { 200: response },
    metadata: {
      operation: `${domain}.${member}`,
      input: carrier,
      transport: "get",
      nullableOutput: nullable,
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
  const { carrier, wire } = rpcInput(
    operation.httpWire?.input ?? operation.input,
    "input",
  );
  const { nullable, response } =
    operation.httpWire === undefined
      ? rpcOutput(operation.output)
      : {
          nullable: operation.httpWire.nullable === true,
          response: toWire(operation.httpWire.output, "output"),
        };
  return {
    method: "POST" as const,
    path: rpcPath(domain, member),
    body: wire,
    responses: { 200: response },
    metadata: {
      operation: `${domain}.${member}`,
      input: carrier,
      transport: "post",
      nullableOutput: nullable,
    } satisfies HttpMetadata,
  };
};

/** A `mutation` contract member as `POST /<domain>/<member>`. */
export const rpcMutation = <I extends z.ZodTypeAny, O extends z.ZodTypeAny>(
  domain: string,
  member: string,
  operation: MutationContract<I, O>,
) => {
  const { carrier, wire } = rpcInput(
    operation.httpWire?.input ?? operation.input,
    "input",
  );
  return {
    method: "POST" as const,
    path: rpcPath(domain, member),
    body: wire,
    responses: {
      200: toWire(operation.httpWire?.output ?? operation.output, "output"),
    },
    metadata: {
      operation: `${domain}.${member}`,
      input: carrier,
    } satisfies HttpMetadata,
  };
};

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
