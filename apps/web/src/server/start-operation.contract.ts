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

/** Runtime mirror of TanStack Start's recursive serializable carrier. */
export const unparsedStartOperationDataSchema: z.ZodType<UnparsedStartOperationData> =
  z.lazy(() =>
    z.union([
      tanStackSerializableLeafSchema,
      z.array(unparsedStartOperationDataSchema),
      z.record(z.string(), unparsedStartOperationDataSchema),
      z.set(unparsedStartOperationDataSchema),
      z.map(unparsedStartOperationDataSchema, unparsedStartOperationDataSchema),
    ]),
  );

export type PublicStartValidationIssue = z.infer<
  typeof publicStartValidationIssueSchema
>;
export type PublicStartOperationError = z.infer<
  typeof publicStartOperationErrorSchema
>;
export type StartOperationResult<T> =
  | { ok: true; data: T }
  | { ok: false; error: PublicStartOperationError };
