/** Immutable decision metadata stored atomically beside a derived value (ADR 0021). */
import { z } from "zod";
import { fieldEmptyReason } from "./field-outcome";
import { fieldProvenance } from "./field-envelope";

/** Stored beside value in the same row, without duplicating its JSON payload. */
export const storedFieldDecision = z.object({
  outcome: z.discriminatedUnion("kind", [
    z.object({ kind: z.literal("value") }),
    z.object({ kind: z.literal("empty"), reason: fieldEmptyReason }),
  ]),
  provenance: fieldProvenance.nullable(),
});
export type StoredFieldDecision = z.output<typeof storedFieldDecision>;
