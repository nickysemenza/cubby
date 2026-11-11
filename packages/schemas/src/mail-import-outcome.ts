import { z } from "zod";
import {
  suggestionChildHandle,
  mailImportOutcome,
  suggestionProducer,
} from "./suggestion";
import { mailMessageRef } from "./mailbox-research";
import { runShortcode } from "./identifier-fields";
import { mailImportWaitingOnOut } from "./email-fields";

export const mailImportOutcomesInput = mailMessageRef.extend({
  offset: z.number().int().nonnegative().default(0),
  limit: z.number().int().min(1).max(50).default(20),
});
/**
 * A mail import's frozen result, stored on the Email's `target_outcome` receipt:
 * the writer's judgment, not a current state.
 */
export const mailOutcomeSnapshot = z.object({
  /** Reviews cite this handle; a carried outcome keeps its Suggestion id. */
  id: z.uuid(),
  judgment: mailImportOutcome,
  producer: suggestionProducer.nullable(),
  checksum: z.string(),
  fingerprint: z.string().nullable(),
  createdAt: z.iso.datetime(),
});
export type MailOutcomeSnapshot = z.infer<typeof mailOutcomeSnapshot>;

/** A stored judgment as public reads expose it: `waitingOn` names public codes. */
const [importedOutcome, linkedOutcome, unrelatedOutcome, unresolvedOutcome] =
  mailImportOutcome.options;
const mailImportOutcomeOut = z.discriminatedUnion("kind", [
  importedOutcome,
  linkedOutcome,
  unrelatedOutcome,
  unresolvedOutcome.extend({ waitingOn: mailImportWaitingOnOut.nullable() }),
]);
export const mailImportOutcomesOut = z.object({
  items: z.array(
    z.object({
      suggestionId: suggestionChildHandle,
      judgment: mailImportOutcomeOut,
      producer: suggestionProducer
        .extend({ runId: runShortcode.nullable() })
        .nullable(),
      checksum: z.string(),
      createdAt: z.iso.datetime(),
    }),
  ),
  nextOffset: z.number().int().nullable(),
});
