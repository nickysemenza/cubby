import { z } from "zod";
import { timestampedFields } from "./base-entity";
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
export type RelationMutationOut = z.infer<typeof relationMutationOut>;
