import { z } from "zod";
import {
  assessmentChildHandle,
  mailImportOutcome,
  assessmentProducer,
} from "./assessment";
import { mailMessageRef } from "./mailbox-research";

export const mailImportOutcomesInput = mailMessageRef.extend({
  offset: z.number().int().nonnegative().default(0),
  limit: z.number().int().min(1).max(50).default(20),
});
export const mailImportOutcomesOut = z.object({
  items: z.array(
    z.object({
      assessmentId: assessmentChildHandle,
      judgment: mailImportOutcome,
      producer: assessmentProducer.nullable(),
      checksum: z.string(),
      createdAt: z.iso.datetime(),
    }),
  ),
  nextOffset: z.number().int().nullable(),
});
