import { z } from "zod";
import { timestampedFields } from "./base-entity";
import { publicImpactItemSchema } from "./entity-integrity";
import { id } from "./identifiers";

export const dbTimestampsOut = z
  .object(timestampedFields)
  .describe("db timestamps for an API response");

export function extractDbTimestampsFromDBRec<
  T extends { createdAt: Date; updatedAt: Date },
>(dbRec: T): z.infer<typeof dbTimestampsOut> {
  return {
    createdAt: dbRec.createdAt,
    updatedAt: dbRec.updatedAt,
  };
}

/**
 * A non-empty entity name for CREATE/UPDATE *input* schemas. Trims surrounding
 * whitespace and rejects empty / whitespace-only values.
 *
 * Apply this on input schemas only — never on the `*Base` / `*Out` schemas that
 * are reused for reads, so any pre-existing rows with empty names still parse on
 * read (the gap this guards against is *new* blank names, not historical ones).
 */
export const requiredName = (label = "Name") =>
  z.string().trim().min(1, `${label} is required`);

export const IDInput = z
  .object({
    id: id,
  })
  .describe("input for retrieving by ID");

export const deletedCountOut = z.object({
  deleted: z.number().int().nonnegative(),
});
export type DeletedCountOut = z.infer<typeof deletedCountOut>;

/**
 * Result of a list-attach/detach mutation on a many-to-many relation edge —
 * `ProductComponent`, `ProjectToolUsage`, `PurchaseProduct`, and any future
 * sibling. All three of today's relation families declared this exact same
 * shape independently (nine restatements total, counting the repo-layer
 * signatures); this is the one place it's said now.
 *
 * `changed` is the DB delta: rows the statement actually inserted (attach) or
 * soft-deleted (detach). It is NOT the size of the request — a call that only
 * re-asserts already-live pairs on attach, or targets already-gone pairs on
 * detach, is a no-op and reports `changed: 0` (see `alreadySatisfied` below
 * for why that no-op is worth counting explicitly).
 *
 * `attached` is the resulting LIVE count of the edge set after the mutation,
 * scoped to the one parent id the call named — regardless of direction, an
 * attach call's `attached` means "how many now" exactly the same way a
 * detach call's does.
 */
export const relationMutationOut = z.object({
  changed: z.number().int().nonnegative(),
  attached: z.number().int().nonnegative(),
  /**
   * How many of the requested ids needed no write because they already sat
   * in the state being asked for — already attached, on an attach call;
   * already absent (never linked, or linked and already removed), on a
   * detach call. Same reason `repointProjectUses` names its own no-op bucket
   * (`alreadyPresent`, see `./project`): without it, a caller that attaches 5
   * ids and gets `changed: 3` cannot tell "2 were rejected" from "2 were
   * already there" — and the MCP tool descriptions promise exactly that
   * distinction ("Repeating an already-live pair is idempotent and reports
   * nothing changed"), a promise the payload could not substantiate before
   * this field existed. Deliberately does NOT say *which* ids — that needs
   * the pre-validation step to carry the set forward, which is a wider change
   * than this one.
   */
  alreadySatisfied: z.number().int().nonnegative(),
});

/** Public relation item shared by id-only attach/detach families. */
export const entityRelationReferenceItemSchema = z
  .object({
    id: z.string().min(1),
  })
  .strict();

/** Product components default omitted quantities to one at the repository seam. */
export const productComponentRelationItemSchema =
  entityRelationReferenceItemSchema.extend({
    quantity: z.number().int().min(1).max(9999).optional(),
  });
export type RelationMutationOut = z.infer<typeof relationMutationOut>;

/**
 * Why an operation REFUSED, as a domain answer rather than a transport error.
 *
 * A blocked delete or merge is not a fault: the guard did its job and the
 * caller needs to know exactly what stood in the way. The Start transport keeps
 * that structure in its typed error envelope, but over MCP an `isError: true`
 * envelope carries text and
 * nothing a client may rely on — the reference SDK client rejects
 * `structuredContent` on an errored result, so the refusal has to live INSIDE
 * the declared output schema to survive the trip. Hence this shape: it is part
 * of what a delete or a merge RETURNS.
 *
 * The four fields are the same ones a refusal has always had, now said once:
 * `error` is the rendered sentence a human reads, `code`/`reason` are that same
 * failure decomposed so a caller can branch without substring-matching prose,
 * and `blockers` names WHICH rows blocked it and how many dependents each had —
 * the half that used to be flattened into the sentence and lost.
 *
 * Both generic tools speak it, in the embedding each one's result calls for:
 * `delete_entity` NESTS it (one result, so presence is its own discriminator),
 * while `merge_entity` FLATTENS it onto a per-cluster result that already
 * carries a `status`. Same field names, same meanings, one definition.
 */
export const operationRefusalOut = z.object({
  error: z.string().min(1),
  /** Stable application error code, when one was available. */
  code: z.string().optional(),
  /** The `AppErrorReason` behind the refusal, when there was one. */
  reason: z.string().optional(),
  /**
   * Which rows blocked, and how many dependents each had — keyed by public
   * shortcode, the same `PublicImpactItem` vocabulary a preview speaks.
   * EMPTY when the guard refused without attributing it to particular rows;
   * an empty list means "not attributed", never "nothing blocked".
   */
  blockers: z.array(publicImpactItemSchema).default([]),
});
export type OperationRefusal = z.infer<typeof operationRefusalOut>;

/**
 * The result of a delete, uniform across every entity.
 *
 * `deleted` is MEASURED (rows actually removed), not the caller's `ids.length` —
 * a delete can cascade, so deleting one task can remove several rows.
 *
 * `sideEffects` is what the delete changed BESIDES its targets. It exists so a
 * richer per-entity result never has to become a different output shape: an
 * expense delete can leave a Purchase empty, and that used to justify a whole
 * separate `delete_expenses` tool with its own schema. It is a consequence of
 * the delete, not a different kind of result.
 */
export const deleteEntityOut = z.object({
  deleted: z.number().int().nonnegative(),
  deletedIds: z.array(z.string()).optional(),
  sideEffects: z
    .array(
      z.object({
        code: z.string().min(1),
        description: z.string().min(1),
        ids: z.array(z.string()),
      }),
    )
    .default([]),
  /**
   * Present when the delete was REFUSED — nothing was deleted, and this says
   * what blocked it. A refusal is a domain answer, so it comes back as a
   * successful call carrying this branch rather than as a transport error that
   * an MCP client can only read as prose (see {@link operationRefusalOut}).
   * Absent on every delete that ran.
   */
  refusal: operationRefusalOut.optional(),
});
export type DeleteEntityOut = z.infer<typeof deleteEntityOut>;
