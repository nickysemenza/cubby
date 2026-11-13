import { entitySchema } from "@cubby/schemas/entity";
import { shortcodeEntities } from "@cubby/schemas/entity-manifest";
import { anyShortcodeSchema } from "@cubby/schemas/identifiers";
import { machinery } from "@cubby/schemas/kernel/machinery";
import { decisionChannel, decisionKind } from "@cubby/schemas/kernel/stage";
import { z } from "zod";

import { ENTITY_ROOT_TAGS } from "~/contracts/cache-policy";
import { defineContract, mutation, query } from "~/contracts/define";

const machineryRecord = z.strictObject({
  entity: entitySchema,
  /** The record's public shortcode. */
  id: anyShortcodeSchema(shortcodeEntities),
});

const machineryDecision = z.strictObject({
  channel: decisionChannel,
  kind: decisionKind,
  /** A gap action's subject; omitted for a decision on this record. */
  subject: z.string().min(1).optional(),
  /** assignment and veto: the field; identity: the other subject. */
  field: z.string().min(1).nullable().optional(),
  value: z.json().optional(),
});

/** Every root a decision or an approval can change: the scopes it dirties reconcile any record. */
const DECISION_INVALIDATES = [
  "product",
  "expense",
  "purchase",
  "vendor",
  "email",
  "image",
  "task",
  "project",
  "inventory",
  "location",
  "meal",
  "planting",
  "gardenEntry",
  "productCategory",
  "spendingCategory",
  "cookbook",
  "financialAccount",
  "financialTransaction",
  "sourceTransactionRecord",
  "suggestions",
  "ledgerTransfer",
  "shipment",
  "runOnly",
  "problems",
] as const;

export const machineryContract = defineContract(
  "machinery",
  {
    read: query({
      description:
        "A record's machinery: its stage, every gap with its actions, every input in the order its reconciler used it, and drift when present. Null when the record's entity has no machinery capability. With `field`, the field scope of the same read.",
      input: machineryRecord.extend({
        field: z.string().min(1).optional(),
      }),
      output: z.object({ machinery: machinery.nullable() }),
      cache: { tags: ENTITY_ROOT_TAGS, profile: "live-status" },
    }),
    decide: mutation({
      description:
        "Record decisions a record's machinery offers: same, distinct, reject, an assignment, a veto, or a release. Each decision must be one of the record's gap actions or a field decision on the record itself.",
      input: machineryRecord.extend({
        decisions: z.array(machineryDecision).min(1).max(20),
      }),
      output: z.object({
        decisions: z.array(z.object({ id: z.string(), subject: z.string() })),
      }),
      invalidates: DECISION_INVALIDATES,
    }),
    approveDrift: mutation({
      description:
        "Approve a record's drift proposal by its hash, or every current proposal of the same scope kind. Approval applies the exact difference and files the asks it counted.",
      input: machineryRecord.extend({
        proposalHash: z.string().min(1),
        scope: z.enum(["item", "class"]),
      }),
      output: z.object({
        applied: z.number().int().nonnegative(),
        stale: z.number().int().nonnegative(),
        busy: z.number().int().nonnegative(),
        missing: z.number().int().nonnegative(),
      }),
      invalidates: DECISION_INVALIDATES,
    }),
  },
  { exposure: "capability" },
);
