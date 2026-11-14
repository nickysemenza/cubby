/**
 * The canonical basis of saved field questions: records read through
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
 * The provided bases in request order. Canonical detail reads share one
 * projection per entity; each field keeps only its own policy's context.
 */
export async function prepareSavedFields(
  db: Database,
  inputs: readonly { entity: string; recordId: string; field: string }[],
): Promise<(PreparedField | null)[]> {
  const result: (PreparedField | null)[] = inputs.map(() => null);
  const groups = new Map<
    PreparedField["entity"],
    {
      index: number;
      id: string;
      request: NonNullable<ReturnType<typeof fieldRequest>>;
    }[]
  >();
  for (const [index, input] of inputs.entries()) {
    const request = fieldRequest(input.entity, input.field);
    if (!request) continue;
    const group = groups.get(request.entity) ?? [];
    group.push({ index, id: input.recordId, request });
    groups.set(request.entity, group);
  }
  for (const [entity, requests] of groups) {
    const ids = [...new Set(requests.map((entry) => entry.id))];
    const codes = await lookupShortcodes(
      db,
      ids.map((id) => parseEntityRef(entity, id)),
    );
    const publicIds = ids.flatMap((id) => {
      const code = codes.get(entityRefKey(entity, id));
      return code ? [code] : [];
    });
    if (!publicIds.length) continue;
    const records = await readSelectedEntityRecords({
      context: systemContext(db),
      entity,
      ids: publicIds,
      fields: [...new Set(requests.flatMap((entry) => entry.request.keys))],
    });
    const byCode = new Map(
      records.map((record) => [String(record.id), record]),
    );
    const governed = entityFieldEnvelopeFields[entity];
    for (const { index, id, request } of requests) {
      const publicId = codes.get(entityRefKey(entity, id));
      const record = publicId ? byCode.get(publicId) : null;
      if (!record || !publicId) continue;
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
      result[index] = { entity, publicId, basis };
    }
  }
  return result;
}
