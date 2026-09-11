import { ContractNoBody } from "@ts-rest/core";
import { z } from "zod";

import {
  detailEntities,
  entityDetailInputSchema,
  getEntityDetailOutputSchema,
} from "~/entities/generated/entity-details.gen";
import {
  listEntities,
  entityListInputSchema,
  getEntityListOutputSchema,
} from "~/entities/generated/entity-lists.gen";
import {
  entityBrowserMutationCommandSchema,
  entityBrowserMutationResultSchema,
} from "~/server/entity-kernel/contracts";
import { publicStartOperationErrorSchema } from "~/server/start-operation.contract";

export type Json<T> = T extends string | number | boolean | null | undefined
  ? T
  : T extends Date
    ? string
    : T extends readonly (infer V)[]
      ? Json<V>[]
      : T extends object
        ? { [K in keyof T]: Json<T[K]> }
        : T;
export const httpSchemaSources = new WeakMap<
  z.ZodType,
  { schema: z.ZodType; io: "input" | "output" }
>();
function wireSchema<T>(schema: z.ZodType, io: "input" | "output") {
  const wire = z.custom<T>();
  httpSchemaSources.set(wire, { schema, io });
  return wire;
}
const failure = z.object({
  ok: z.literal(false),
  error: publicStartOperationErrorSchema,
});
export function httpOperation<I extends z.ZodType, O extends z.ZodType>(
  id: string,
  input: I,
  output: O,
) {
  const body =
    input instanceof z.ZodUndefined
      ? z.strictObject({})
      : z.strictObject({ input });
  return {
    metadata: { http: { operation: id, mode: "legacy" } },
    method: "POST" as const,
    path: `/api/v1/${id.replace(".", "/")}`,
    body: wireSchema<
      undefined extends z.input<I>
        ? { input?: Json<z.input<I>> }
        : { input: Json<z.input<I>> }
    >(body, "input"),
    responses: httpResponses(output),
  };
}
export const entityHttpSchemas = {
  "entity.list": {
    input: entityListInputSchema,
    output: z.union(listEntities.map(getEntityListOutputSchema)),
  },
  "entity.detail": {
    input: entityDetailInputSchema,
    output: z.union(detailEntities.map(getEntityDetailOutputSchema)).nullable(),
  },
  "entity.mutate": {
    input: entityBrowserMutationCommandSchema,
    output: entityBrowserMutationResultSchema,
  },
};

function httpResponses<O extends z.ZodType>(output: O) {
  return {
    200: wireSchema<{ ok: true; data: Json<z.output<O>> }>(
      z.object({ ok: z.literal(true), data: output }),
      "output",
    ),
    400: failure,
    401: failure,
    403: failure,
    404: failure,
    409: failure,
    412: failure,
    500: failure,
  };
}
export const httpMetadataSchema = z.object({
  operation: z.string(),
  mode: z.enum([
    "legacy",
    "object",
    "wrapped",
    "undefined",
    "null",
    "list",
    "detail",
    "create",
    "update",
    "delete",
  ]),
  entity: z.string().optional(),
});
export type HttpMetadata = z.output<typeof httpMetadataSchema>;

export function httpGet<I extends z.ZodType, O extends z.ZodType>(
  path: string,
  input: I,
  output: O,
  metadata: HttpMetadata,
) {
  return {
    method: "GET" as const,
    path,
    query: wireSchema<Json<z.input<I>>>(input, "input"),
    responses: httpResponses(output),
    metadata: { http: metadata },
  };
}
export function httpWrite<
  const M extends "POST" | "PATCH",
  I extends z.ZodType,
  O extends z.ZodType,
>(method: M, path: string, input: I, output: O, metadata: HttpMetadata) {
  return {
    method,
    path,
    body: wireSchema<Json<z.input<I>>>(input, "input"),
    responses: httpResponses(output),
    metadata: { http: metadata },
  };
}
export function httpItem<R extends { path: string }, I extends z.ZodType>(
  route: R,
  id: I,
) {
  return {
    ...route,
    pathParams: wireSchema<{ id: Json<z.input<I>> }>(z.object({ id }), "input"),
  };
}
export function httpQuery<I extends z.ZodType, O extends z.ZodType>(
  id: string,
  input: I,
  output: O,
) {
  const mode =
    input instanceof z.ZodUndefined
      ? "undefined"
      : input instanceof z.ZodNull
        ? "null"
        : input instanceof z.ZodObject ||
            (input instanceof z.ZodUnion &&
              input.options.every((option) => option instanceof z.ZodObject))
          ? "object"
          : "wrapped";
  const query =
    mode === "undefined" || mode === "null"
      ? z.strictObject({})
      : mode === "object"
        ? input
        : z.object({ input });
  return {
    ...httpGet(`/api/v1/${id.replace(".", "/")}`, query, output, {
      operation: id,
      mode,
    }),
    query: wireSchema<
      z.input<I> extends undefined | null
        ? Record<string, never>
        : z.input<I> extends readonly unknown[]
          ? { input: Json<z.input<I>> }
          : z.input<I> extends object
            ? Json<z.input<I>>
            : { input: Json<z.input<I>> }
    >(query, "input"),
  };
}

export function httpDelete<O extends z.ZodType>(
  path: string,
  output: O,
  metadata: HttpMetadata,
) {
  return {
    method: "DELETE" as const,
    path,
    body: ContractNoBody,
    responses: httpResponses(output),
    metadata: { http: metadata },
  } as const;
}

export function httpCreate<I extends z.ZodType, O extends z.ZodType>(
  path: string,
  input: I,
  output: O,
  metadata: HttpMetadata,
) {
  const route = httpWrite("POST", path, input, output, metadata);
  const { 200: created, ...errors } = route.responses;
  return { ...route, responses: { 201: created, ...errors } };
}
