import { publicImpactItemSchema } from "@cubby/schemas/entity-integrity";
import { z } from "zod";

import { errorDiagnosticsSchema } from "~/lib/error-diagnostics";

/**
 * The wire contract every Start operation shares, owned by neither side.
 *
 * `start-operation.server.ts` produces these shapes and the browser transport
 * consumes them, so this module must stay client-safe: types only, no server
 * bindings, no Query-integration imports. The server previously imported the
 * contract *from* the Query integration layer, which pointed the dependency
 * backwards — server code must never depend on a browser transport module.
 */

const publicStartValidationIssueSchema = z.object({
  code: z.string(),
  path: z.array(z.union([z.string(), z.number()])),
  message: z.string(),
});

export const publicStartOperationErrorSchema = z.object({
  message: z.string(),
  code: z.string(),
  reason: z.string().optional(),
  /** Correlates this failed request with server-side traces and Sentry. */
  requestId: z.string().optional(),
  diagnostics: errorDiagnosticsSchema.optional().catch(undefined),
  blockers: z.array(publicImpactItemSchema).optional(),
  validationIssues: z.array(publicStartValidationIssueSchema).optional(),
});

const tanStackSerializableLeafSchema = z.union([
  z.string(),
  z.number(),
  z.boolean(),
  z.null(),
  z.undefined(),
  z.bigint(),
  z.date(),
  z.instanceof(Uint8Array),
]);

type TanStackSerializableLeaf = z.output<typeof tanStackSerializableLeafSchema>;

/** Plain-object branch of the recursive Start transport value. */
interface StartOperationProperties {
  readonly [key: string]: UnparsedStartOperationData;
}

export type UnparsedStartOperationData =
  | TanStackSerializableLeaf
  | readonly UnparsedStartOperationData[]
  | StartOperationProperties
  | ReadonlySet<UnparsedStartOperationData>
  | ReadonlyMap<UnparsedStartOperationData, UnparsedStartOperationData>;

/** Validate containers once without allocating failed union branches or cloning DTOs. */
const isStartOperationData = (input: unknown): boolean => {
  const ancestors = new WeakSet<object>();
  const checked = new WeakSet<object>();
  const visit = (value: unknown): boolean => {
    if (value === null) return true;
    switch (typeof value) {
      case "undefined":
      case "string":
      case "boolean":
      case "bigint":
        return true;
      case "number":
        return Number.isFinite(value);
      case "object":
        break;
      default:
        return false;
    }
    if (value instanceof Date) return Number.isFinite(value.getTime());
    if (value instanceof Uint8Array) return true;
    if (checked.has(value)) return true;
    if (ancestors.has(value)) return false;
    const array = Array.isArray(value);
    const set = value instanceof Set;
    const map = value instanceof Map;
    const prototype = Object.getPrototypeOf(value);
    if (
      !array &&
      !set &&
      !map &&
      prototype !== Object.prototype &&
      prototype !== null
    )
      return false;
    ancestors.add(value);
    let valid = true;
    if (map) {
      const entries: Iterable<[unknown, unknown]> = value;
      for (const [key, entry] of entries)
        if (!visit(key) || !visit(entry)) {
          valid = false;
          break;
        }
    } else {
      const children: Iterable<unknown> =
        array || set ? value : Object.values(value);
      for (const child of children)
        if (!visit(child)) {
          valid = false;
          break;
        }
    }
    ancestors.delete(value);
    if (valid) checked.add(value);
    return valid;
  };
  return visit(input);
};

/** Operation schemas validate domain data; this boundary checks carrier support.
 * A recursive union generated an error for every rejected branch at every valid
 * object, dominating 100-row SSR responses. Keep this walk type-directed. */
export const unparsedStartOperationDataSchema: z.ZodType<UnparsedStartOperationData> =
  z.custom<UnparsedStartOperationData>(isStartOperationData);

export type PublicStartValidationIssue = z.infer<
  typeof publicStartValidationIssueSchema
>;
export type PublicStartOperationError = z.infer<
  typeof publicStartOperationErrorSchema
>;
export type StartOperationResult<T> =
  | { ok: true; data: T; readMarker?: string }
  | { ok: false; error: PublicStartOperationError; readMarker?: string };

export const unparsedStartOperationResultSchema = z.discriminatedUnion("ok", [
  z.object({
    ok: z.literal(true),
    data: unparsedStartOperationDataSchema,
    readMarker: z.string().max(4096).optional(),
  }),
  z.object({
    ok: z.literal(false),
    error: publicStartOperationErrorSchema,
    readMarker: z.string().max(4096).optional(),
  }),
]);
