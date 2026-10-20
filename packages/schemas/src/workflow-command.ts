import { z } from "zod";

export const workflowCommandInput = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("number"),
    key: z.string().min(1),
    label: z.string().min(1),
    /** Shown first (the current value, or a sensible default). */
    initial: z.number().nullable(),
    min: z.number(),
  }),
  z.object({
    kind: z.literal("record"),
    key: z.string().min(1),
    label: z.string().min(1),
    /** The entity whose records the client searches. */
    entity: z.string().min(1),
  }),
  z.object({
    kind: z.literal("choice"),
    key: z.string().min(1),
    label: z.string().min(1),
    options: z
      .array(z.object({ value: z.string().min(1), label: z.string().min(1) }))
      .min(1),
    initial: z.string().nullable(),
  }),
  z.object({
    kind: z.literal("text"),
    key: z.string().min(1),
    label: z.string().min(1),
    /** Required free text, e.g. why the member corrected a record. */
    initial: z.string().nullable(),
  }),
]);

/** Opt-in presentation for an ordinary mutation. Availability remains server-owned. */
export const workflowCommandMetadata = z.object({
  label: z.string().min(1),
  inputs: z.array(workflowCommandInput).optional(),
  affectedEntities: z.array(z.string().min(1)).optional(),
  resultFields: z
    .array(z.object({ label: z.string(), path: z.string() }))
    .optional(),
  confirmation: z.string().min(1).nullable(),
  /** Input keys whose choice values represent booleans on the operation wire. */
  booleanInputs: z.array(z.string()).optional(),
  /** Result fields containing created Runs or a successor to open. */
  runIdsPath: z.string().optional(),
  navigateRunPath: z.string().optional(),
  success: z.string().optional(),
});
export type WorkflowCommandMetadata = z.infer<typeof workflowCommandMetadata>;

/** A template may have empty operands; the operation's input schema validates the final body. */
export const workflowCommandRequest = z.object({
  kind: z.literal("operation"),
  operation: z.string().regex(/^[\w-]+\.\w+$/u),
  body: z.record(z.string(), z.json()),
  /** Form key to a dot path in body; numeric segments address array elements. */
  bindings: z.record(z.string(), z.string().min(1)).optional(),
});
export type WorkflowCommandRequest = z.infer<typeof workflowCommandRequest>;

/** Apply only declared form operands; evidence, approvals and fingerprints remain untouched. */
export function workflowCommandBody(
  request: WorkflowCommandRequest,
  values: Record<string, string | number>,
  booleanInputs: readonly string[] = [],
): WorkflowCommandRequest["body"] {
  const body = z
    .record(z.string(), z.json())
    .parse(structuredClone(request.body));
  for (const [key, value] of Object.entries(values)) {
    const path = (request.bindings?.[key] ?? key).split(".");
    let cursor: z.infer<ReturnType<typeof z.json>> = body;
    for (const segment of path.slice(0, -1)) {
      if (cursor === null || typeof cursor !== "object")
        throw new Error(`Invalid command operand path: ${key}`);
      cursor = Array.isArray(cursor)
        ? cursor[Number(segment)]!
        : cursor[segment]!;
    }
    if (cursor === null || typeof cursor !== "object")
      throw new Error(`Invalid command operand path: ${key}`);
    const operand = booleanInputs.includes(key) ? value === "true" : value;
    const last = path.at(-1)!;
    if (Array.isArray(cursor)) cursor[Number(last)] = operand;
    else cursor[last] = operand;
  }
  return body;
}
