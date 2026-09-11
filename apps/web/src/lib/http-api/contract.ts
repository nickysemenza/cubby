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

type Json<T> = T extends string | number | boolean | null | undefined
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
  const response = z.object({ ok: z.literal(true), data: output });
  return {
    method: "POST" as const,
    path: `/api/v1/${id.replace(".", "/")}`,
    body: wireSchema<
      undefined extends z.input<I>
        ? { input?: Json<z.input<I>> }
        : { input: Json<z.input<I>> }
    >(body, "input"),
    responses: {
      200: wireSchema<{ ok: true; data: Json<z.output<O>> }>(
        response,
        "output",
      ),
      400: failure,
      401: failure,
      403: failure,
      404: failure,
      409: failure,
      412: failure,
      500: failure,
    },
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
