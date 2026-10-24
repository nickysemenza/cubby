import {
  enrollSuggestionCorrectionsInput,
  enrollSuggestionCorrectionsOut,
} from "@cubby/schemas/suggestion-correction";
import type { z } from "zod";

import type { Database } from "~/server/db";
import { withTransactionDatabase } from "~/server/db/helpers";

import { retainedCorrectionEnrollmentPage } from "./correction-sources";
import { enrollRetainedCorrection } from "./correction-work";

/** Enrollment is explicit; ordinary reads never initiate historical repair. */
export async function enrollSuggestionCorrections(
  db: Database,
  input: z.infer<typeof enrollSuggestionCorrectionsInput>,
) {
  const enroll = async (transactionDb: Database) => {
    const page = await retainedCorrectionEnrollmentPage(transactionDb, input);
    if (!input.dryRun)
      for (const source of page.sources)
        await enrollRetainedCorrection(
          transactionDb,
          source.feedbackId,
          input.family,
        );
    return enrollSuggestionCorrectionsOut.parse({
      family: input.family,
      dryRun: input.dryRun,
      scanned: page.scanned,
      receiptBackedRoots: page.sources.length,
      enrolledRoots: input.dryRun ? 0 : page.sources.length,
      after: page.after,
      done: page.done,
    });
  };
  return input.dryRun ? enroll(db) : withTransactionDatabase(db, enroll);
}
