import { fieldSuggestionsInput } from "@cubby/schemas/ai";
import { entityFieldEnvelopeFields } from "@cubby/schemas/entity-field-envelopes";
import { fieldEnvelopeFor, fieldValueOf } from "@cubby/schemas/field-envelope";
import { basisValueOf } from "@cubby/schemas/field-suggestion";
import type { RunId } from "@cubby/schemas/identifiers";
import { sweepFieldTargets } from "@cubby/schemas/run-fields";
import {
  supportedDecisionModelSchema,
  type SupportedDecisionModel,
} from "@cubby/shared/ai/models";
import { z } from "zod";

import {
  suggestFields,
  type SuggestFieldsPorts,
} from "~/server/ai/field-suggest/suggest-fields";
import type { Database } from "~/server/db";
import { spendingClassificationRevision } from "~/server/domains/expense/repo/expense-category-resolution";
import { executeEntity } from "~/server/entity-kernel";
import type { EntityKernelContext } from "~/server/entity-kernel/adapter";
import { entityCommandSchema } from "~/server/entity-kernel/contracts";
import { resolveLiveShortcodes } from "~/server/generic/shortcode/repo/shortcode-resolver";

import {
  suggestionValueSchema,
  type SuggestionValue,
} from "../repo/suggestion-sweep-state";

export type SuggestionSweepPorts = {
  /** Entity operations need the authenticated request's kernel services. */
  context: EntityKernelContext;
  decisionModel?: () => SupportedDecisionModel;
  suggest?: typeof suggestFields;
  suggestPorts?: SuggestFieldsPorts;
  /** Test seam that pauses after a persisted number of processed targets. */
  pauseAfter?: number;
};
type SweepTarget = {
  id: string;
  currentValue: SuggestionValue;
  entityId: string;
  basis: Record<string, string | null>;
  field: string;
};
const sweepListRowSchema = z.object({ id: z.string() }).passthrough();
const sweepRunInputSchema = sweepFieldTargets.element.extend({
  entity: fieldSuggestionsInput.shape.entity,
  model: supportedDecisionModelSchema.optional(),
  taxonomyRevision: z.string().optional(),
});
type SweepInput = z.infer<typeof sweepRunInputSchema>;
/** The stored input a field pass evaluates under, captured by its roster step. */
export async function suggestionSweepInput(
  db: Database,
  input: SweepInput,
  ports: Pick<SuggestionSweepPorts, "decisionModel" | "suggestPorts"> = {},
) {
  return sweepRunInputSchema.parse({
    ...input,
    model: ports.decisionModel?.() ?? ports.suggestPorts?.decisionModel,
    taxonomyRevision: await spendingClassificationRevision(db),
  });
}

/**
 * Reconciles each listed record and links the field Asks to the owning Sweep.
 */
export async function rosterSuggestionTargets(
  db: Database,
  runId: RunId,
  storedInput: unknown,
  ports: SuggestionSweepPorts,
) {
  const input = sweepRunInputSchema.parse(storedInput);
  let pageIndex = 0;
  let rowsSeen = 0;
  let totalCount = 0;
  const targets: SweepTarget[] = [];
  do {
    const command = entityCommandSchema.parse({
      action: "list",
      entity: input.entity,
      filters: input.filters,
      pagination: { pageIndex, pageSize: 500 },
    });
    const listed = await executeEntity(ports.context, command);
    if (listed.action !== "list")
      throw new Error(
        "Suggestion sweep target read returned a non-list result",
      );
    const items = z.array(sweepListRowSchema).parse(listed.items);
    rowsSeen += items.length;
    totalCount = z.number().parse(listed.meta.totalCount);
    const recordIds = await resolveLiveShortcodes(
      db,
      items.map((row) => row.id),
      input.entity,
    );
    for (const row of items) {
      const recordId = recordIds.get(row.id);
      if (!recordId) continue;
      const governedFields = entityFieldEnvelopeFields[input.entity];
      const valueOf = (key: string) => {
        if (!Object.hasOwn(governedFields, key)) return row[key];
        const envelope = fieldEnvelopeFor(row, key);
        return envelope ? fieldValueOf(envelope) : null;
      };
      const basis = Object.fromEntries(
        [
          ...new Set([
            ...Object.keys(row).filter((key) => key !== "fields"),
            ...Object.keys(governedFields),
          ]),
        ].map((key) => [key, basisValueOf(valueOf(key))]),
      );
      for (const field of input.fields) {
        const currentValue = suggestionValueSchema.parse(
          valueOf(field) ?? null,
        );
        targets.push({
          id: row.id,
          entityId: recordId,
          currentValue,
          basis,
          field,
        });
      }
    }
    pageIndex++;
  } while (rowsSeen < totalCount);
  const { reconcileNow } = await import("~/server/kernel/api");
  await reconcileNow(
    db,
    [
      ...new Map(
        targets.map((target) => [
          target.entityId,
          {
            kind: "fields",
            key: `${input.entity}:${target.entityId}`,
          },
        ]),
      ).values(),
    ],
    { runId },
  );
  return targets.length;
}
