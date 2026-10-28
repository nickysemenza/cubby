import type { EntityFieldModel } from "@cubby/schemas/entity-fields";
import {
  isCancelledError,
  type Query,
  type QueryClient,
} from "@tanstack/react-query";
import { z } from "zod";

import { entityDetailFor } from "~/entity/entity-detail";
import { removeCachedListItems } from "~/entity/hooks/optimistic-list";
import { ensureEntityMetadata } from "~/entity/metadata";
import { mutationReceiptSchema } from "~/entity/mutation-receipt";
import { showErrorToast } from "~/ui/feedback/error-details";

const envelope = z
  .object({ receipt: z.unknown().optional(), result: z.unknown().optional() })
  .passthrough();
const record = z.object({ id: z.string() }).passthrough();
const container = z
  .object({
    pages: z.array(z.unknown()).optional(),
    items: z.array(z.unknown()).optional(),
    data: z.array(z.unknown()).optional(),
  })
  .passthrough();

/** Adapters preserve the complete receipt even when their public result is narrower. */
export function mutationReceipt(value: unknown) {
  const direct = mutationReceiptSchema.safeParse(value);
  if (direct.success) return direct.data;
  const outer = envelope.safeParse(value);
  if (!outer.success) return;
  const receipt = mutationReceiptSchema.safeParse(outer.data.receipt);
  if (receipt.success) return receipt.data;
  const inner = envelope.safeParse(outer.data.result);
  const nested = mutationReceiptSchema.safeParse(
    inner.success
      ? (inner.data.receipt ?? outer.data.result)
      : outer.data.result,
  );
  return nested.success ? nested.data : undefined;
}

type CachedProjection<T> =
  | T
  | z.infer<typeof record>
  | z.infer<typeof container>
  | unknown[];

function patchRecord<T>(
  value: T,
  id: string,
  fields: ReadonlyMap<string, unknown>,
  includeMissing = false,
): CachedProjection<T> {
  const identified = record.safeParse(value);
  if (identified.success && identified.data.id === id) {
    let next = identified.data;
    let changed = false;
    for (const [key, saved] of fields) {
      // Partial receipts never manufacture a complete projection. Expanded,
      // inherited and derived fields keep their read owner's representation.
      if ((!includeMissing && !(key in next)) || Object.is(next[key], saved))
        continue;
      next = { ...next, [key]: saved };
      changed = true;
    }
    return changed ? next : value;
  }
  if (Array.isArray(value)) {
    const next = value.map((item) =>
      patchRecord(item, id, fields, includeMissing),
    );
    return next.every((item, index) => item === value[index]) ? value : next;
  }
  const parsed = container.safeParse(value);
  if (!parsed.success) return value;
  let next = parsed.data;
  let changed = false;
  for (const key of ["pages", "items", "data"] as const) {
    const source = parsed.data[key];
    if (!source) continue;
    const patched = patchRecord(source, id, fields, includeMissing);
    if (patched !== source) {
      next = { ...next, [key]: patched };
      changed = true;
    }
  }
  return changed ? next : value;
}

function hasReceiptRepresentation(field: EntityFieldModel["fields"][number]) {
  return (
    field.readKey === field.key &&
    !field.reference &&
    !field.collection &&
    !field.resolution &&
    !field.explanation &&
    !field.provenance &&
    (!field.display.readPath || field.display.readPath === field.key)
  );
}

function publishProjection<T>(client: QueryClient, query: Query, next: T) {
  if (next === query.state.data) return;
  const { error, status, isInvalidated } = query.state;
  client.setQueryData(query.queryKey, next);
  // A partial record patch cannot certify every other value in this view.
  query.setState({ error, status, isInvalidated });
}

/** Expanded/inherited editors load one authoritative record, including enrichment. */
export async function settleReceiptProjection(
  client: QueryClient,
  receipt: ReturnType<typeof mutationReceipt>,
) {
  if (!receipt || receipt.action !== "update") return;
  const model = (await ensureEntityMetadata(client, receipt.entity)).fields;
  if (
    !receipt.appliedFields.some((key) => {
      const field = model.fields.find((field) => field.key === key);
      return field && !hasReceiptRepresentation(field);
    })
  )
    return;
  const options = entityDetailFor(receipt.entity).queryOptions(receipt.item.id);
  // Another accepted write can cancel tagged reads. Follow its replacement
  // instead of interpreting cancellation as authoritative completion.
  for (;;) {
    try {
      const detail = await client.fetchQuery({ ...options, staleTime: 0 });
      if (!detail) return;
      const canonical = record.parse(detail);
      const fields = new Map<string, unknown>();
      for (const field of model.fields) {
        if (field.readKey && field.readKey in canonical)
          fields.set(field.readKey, canonical[field.readKey]);
      }
      // The detail schema owns these read representations, including deferred
      // reference fields. Publishing into base rows prevents retained older
      // enrichment from winning while its replacement is still loading.
      for (const query of client.getQueryCache().getAll()) {
        const next = patchRecord(
          query.state.data,
          receipt.item.id,
          fields,
          true,
        );
        publishProjection(client, query, next);
      }
      return;
    } catch (error) {
      if (isCancelledError(error)) continue;
      showErrorToast(error, "Saved, but current values could not be loaded");
      return;
    }
  }
}

/** Apply only confirmed scalars with the same declared stored/read representation. */
export async function reconcileMutationReceipt(
  client: QueryClient,
  receipt: ReturnType<typeof mutationReceipt>,
) {
  if (!receipt) return;
  if (receipt.action === "create" || receipt.action === "update") {
    const model = (await ensureEntityMetadata(client, receipt.entity)).fields;
    const fields = new Map<string, unknown>();
    for (const key of receipt.appliedFields) {
      const field = model.fields.find((field) => field.key === key);
      if (!field || !hasReceiptRepresentation(field)) continue;
      if (key in receipt.item) fields.set(key, receipt.item[key]);
    }
    if (!fields.size) return;
    for (const query of client.getQueryCache().getAll()) {
      const next = patchRecord(query.state.data, receipt.item.id, fields);
      // setQueryData also clears failures/invalidation, even for equal data.
      publishProjection(client, query, next);
    }
  } else if (receipt.action === "delete" || receipt.action === "merge") {
    const merged =
      receipt.action === "merge"
        ? z
            .object({ deletedIds: z.array(z.string()) })
            .safeParse(receipt.mergeSummary)
        : undefined;
    const ids = new Set(
      receipt.action === "delete"
        ? receipt.deletedReferences.map((reference) => reference.id)
        : merged?.success
          ? merged.data.deletedIds
          : [],
    );
    if (!ids.size) return;
    for (const query of client.getQueryCache().getAll()) {
      const old = query.state.data;
      const identified = record.safeParse(old);
      const next =
        identified.success && ids.has(identified.data.id)
          ? null
          : removeCachedListItems(old, ids);
      publishProjection(client, query, next);
    }
  }
}
