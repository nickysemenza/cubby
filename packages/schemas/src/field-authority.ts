import { z } from "zod";

import { fieldSuggestionsInput } from "./ai";
import { anyShortcodeSchema, nonEmptyTuple } from "./identifier-fields";
import { suggestionChildHandle } from "./suggestion-reference";

/** A suggested field's record, by any suggestable entity's shortcode. */
const suggestableRecordId = anyShortcodeSchema(
  nonEmptyTuple(fieldSuggestionsInput.shape.entity.options),
);

/** Who holds a field: nobody, Cubby (it may revise), or a person (never overwritten). */
const fieldHolder = z.enum(["open", "cubby", "person"]);

export const fieldAuthorityActionInput = z.object({
  entity: fieldSuggestionsInput.shape.entity,
  id: suggestableRecordId,
  field: z.string().min(1),
  /**
   * `keep`: a member confirms Cubby's value, which then counts as theirs.
   * `clear`: Cubby's value is wrong and nobody knows the right one; the field
   * empties, that value is ruled out, and Cubby may try again.
   * `release`: hand a person's value back to Cubby, which may replace it.
   */
  action: z.enum(["keep", "clear", "release"]),
  /** The Suggestion a Changes by Cubby row shows; refused once Cubby revised it. */
  suggestionId: suggestionChildHandle.optional(),
});
export const fieldAuthorityActionOut = z.object({ holder: fieldHolder });

/** Cubby's current answer for an empty or offered field, shown first in its picker. */
const fieldGuess = z.object({
  suggestionId: z.string(),
  value: z.json(),
  confidence: z.number().min(0).max(1),
  runnerUp: z
    .object({ value: z.json(), confidence: z.number().min(0).max(1) })
    .nullable(),
});
export type FieldGuess = z.infer<typeof fieldGuess>;

export const fieldGuessInput = z.object({
  entity: fieldAuthorityActionInput.shape.entity,
  id: suggestableRecordId,
  field: z.string().min(1),
});
export const fieldGuessOut = z.object({ guess: fieldGuess.nullable() });

/** Who set a field's value, for Why this value. */
export const fieldOrigin = z.object({
  holder: fieldHolder,
  at: z.iso.datetime().nullable(),
  /** Cubby's confidence when it set the value. */
  confidence: z.number().min(0).max(1).nullable(),
  keptAt: z.iso.datetime().nullable(),
  writer: z
    .object({
      kind: z.enum(["member", "agent", "import", "cubby"]),
      name: z.string().nullable(),
    })
    .nullable(),
  /** A member handed this value to Cubby; Keep takes it back. */
  released: z.boolean(),
  /** Who decides once Cubby is confident: Cubby, the queue, or the picker. */
  apply: z.enum(["auto", "review", "offer"]),
  /** Cubby fills it when empty but never revises it, so release is not offered. */
  fillOnly: z.boolean(),
  guess: fieldGuess.nullable(),
});
export type FieldOrigin = z.infer<typeof fieldOrigin>;
