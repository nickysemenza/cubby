/**
 * The canonical basis of one saved field question: the record read through
 * the selected-detail reader, so the prompt sees effective values, reference
 * identities and assignment intent exactly as Why this value does.
 */
import { fieldSuggestionsInput } from "@cubby/schemas/ai";
import { systemActor } from "@cubby/schemas/context";
import { entityRefKey } from "@cubby/schemas/entity";
import { entityFieldEnvelopeFields } from "@cubby/schemas/entity-field-envelopes";
import { fieldEnvelopeFor, fieldValueOf } from "@cubby/schemas/field-envelope";
import {
  basisValueOf,
  fieldSuggestionContextKeys,
  fieldSuggestionResolutionContext,
} from "@cubby/schemas/field-suggestion";
import { parseEntityRef } from "@cubby/schemas/identifiers";

import { decisionCatalogRows } from "~/server/ai/decision-catalog";
import type { Database } from "~/server/db";
import type { EntityKernelContext } from "~/server/entity-kernel/adapter";
import { readSelectedEntityRecords } from "~/server/entity-kernel/selected-read";
import { lookupShortcodes } from "~/server/generic/shortcode/repo/shortcode-resolver";
import { buildCrudServices } from "~/server/http/request-context";

const systemContext = (db: Database): EntityKernelContext => ({
  ...buildCrudServices(db),
  db,
  actorContext: systemActor(),
});

/** The basis keys a field's decision policy reads, or null for an unknown field. */
function fieldRequest(entity: string, field: string) {
  const parsed = fieldSuggestionsInput.shape.entity.safeParse(entity);
  if (!parsed.success) return null;
  const policy = decisionCatalogRows().find(
    (row) => row.entity === parsed.data && row.field === field,
  );
  if (!policy) return null;
  const policyKeys = [...policy.basis.map((row) => row.key), field];
  return {
    entity: parsed.data,
    policyKeys,
    keys: fieldSuggestionContextKeys(parsed.data, policyKeys),
  };
}

export type PreparedField = {
  entity: (typeof fieldSuggestionsInput.shape.entity.options)[number];
  publicId: string;
  basis: Record<string, string | null>;
};

/**
 * The provided basis `suggestFields` reads for one saved record's field, or
 * null when the record is gone or the field's result is still missing.
 */
export async function prepareSavedField(
  db: Database,
  entity: string,
  recordId: string,
  field: string,
): Promise<PreparedField | null> {
  const request = fieldRequest(entity, field);
  if (!request) return null;
  const codes = await lookupShortcodes(db, [
    parseEntityRef(request.entity, recordId),
  ]);
  const publicId = codes.get(entityRefKey(request.entity, recordId));
  if (!publicId) return null;
  const [record] = await readSelectedEntityRecords({
    context: systemContext(db),
    entity: request.entity,
    ids: [publicId],
    fields: request.keys,
  });
  if (!record) return null;
  const governed = entityFieldEnvelopeFields[request.entity];
  const valueOf = (key: string) => {
    if (!Object.hasOwn(governed, key)) return record[key];
    const envelope = fieldEnvelopeFor(record, key);
    return envelope ? fieldValueOf(envelope) : null;
  };
  // Effective values drive the question; the envelope keeps assignment intent.
  const basis: Record<string, string | null> = Object.fromEntries(
    request.keys.map((key) => [key, basisValueOf(valueOf(key))]),
  );
  basis.__resolutionContext = fieldSuggestionResolutionContext(
    record.fields,
    request.policyKeys,
  );
  return { entity: request.entity, publicId, basis };
}
