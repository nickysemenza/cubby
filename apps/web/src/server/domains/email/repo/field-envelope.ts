import { emailImportOutcome } from "@cubby/schemas/email-fields";
import { emailRawOut as rawEmailOut } from "@cubby/schemas/entity-contracts/email";
import { fieldEnvelopeFor } from "@cubby/schemas/field-envelope";

import type { FieldEnvelopeProjector } from "~/server/generic/derived/repo/envelope";
import { currentReadFacts } from "~/server/generic/derived/repo/read-context";

/**
 * Accepted-source completion keeps its published facts. Without them, the
 * holding Run and retained import outcomes still decide the outcome live.
 */
export function projectEmailFieldEnvelopes({
  row,
  built,
}: Parameters<FieldEnvelopeProjector>[0]): ReturnType<FieldEnvelopeProjector> {
  const original = fieldEnvelopeFor(built, "importOutcome");
  if (!original) return built;
  const facts = rawEmailOut
    .pick({ importOutcome: true, storedProjectionVersions: true })
    .parse(row);
  // A witnessed projection must keep the constructor's publication consistency check.
  // Only a read made without accepted-source facts may supply independent live outcomes.
  if (facts.storedProjectionVersions?.importOutcome !== null) return built;
  const outcome = facts.importOutcome;
  if (outcome === null || outcome === emailImportOutcome.enum.not_imported)
    return built;
  const fields = currentReadFacts.parse(built.fields);
  fields.importOutcome = {
    ...original,
    result: {
      kind: "live",
      decision: {
        outcome: { kind: "value", value: outcome },
        provenance: { kind: "computed" },
      },
    },
  };
  return { ...built, fields };
}
