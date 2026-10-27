/**
 * Inventory's stored valuation (ADR 0021). The unit-mapping graph is WASM, so
 * SQL cannot value a row; the drain values changed rows here and lists read
 * the published figure for sort, filter and footer totals.
 */
import { parseEntityId } from "@cubby/schemas/identifiers";
import type { InventoryId } from "@cubby/schemas/identifiers";
import { OWNER_FILTER_HOUSEHOLD, OWNER_FILTER_UNKNOWN } from "@cubby/shared";
import { and, inArray } from "drizzle-orm";

import { notDeleted, unwrapDb } from "~/server/db/helpers";
import { inventoryEntry, product } from "~/server/db/schema";
import type {
  DerivedCompute,
  DerivedComputed,
} from "~/server/generic/derived/repo/compute";

import {
  computeProductOwners,
  loadInventoryOwnershipTraces,
} from "./ownership";
import { loadInventoryValuations } from "./valuation";

const inventoryValuationCompute: DerivedCompute = async (db, ids) => {
  const rows = await unwrapDb(db)
    .select({
      id: inventoryEntry.id,
      productId: inventoryEntry.productId,
      amountValue: inventoryEntry.amountValue,
      amountUnit: inventoryEntry.amountUnit,
    })
    .from(inventoryEntry)
    .where(
      and(
        // SAFETY: the drain passes ids of `inventory.valuation` marks only.
        inArray(inventoryEntry.id, ids as InventoryId[]),
        notDeleted(inventoryEntry),
      ),
    );
  const valuations = await loadInventoryValuations(db, rows);
  const out = new Map<string, DerivedComputed>();
  for (const row of rows) {
    const value = valuations.get(row.id) ?? null;
    out.set(row.id, { value, sort: value });
  }
  return out;
};

const inventoryOwnershipCompute: DerivedCompute = async (db, ids) => {
  const rows = await unwrapDb(db)
    .select({
      id: inventoryEntry.id,
      productId: inventoryEntry.productId,
      ownershipMode: inventoryEntry.ownershipMode,
      ownerLedgerPartyId: inventoryEntry.ownerLedgerPartyId,
    })
    .from(inventoryEntry)
    .where(
      and(
        inArray(
          inventoryEntry.id,
          ids.map((id) => parseEntityId("inventory", id)),
        ),
        notDeleted(inventoryEntry),
      ),
    );
  const traces = await loadInventoryOwnershipTraces(db, rows);
  return new Map(
    [...traces].map(([id, trace]) => [
      id,
      {
        value: {
          ownership: trace.ownership,
          effectiveOwnerId: trace.ownership.effectiveOwner?.id ?? null,
          ownerFilter:
            trace.ownership.effectiveOwner?.id ??
            (trace.ownership.mode === "explicit"
              ? OWNER_FILTER_HOUSEHOLD
              : OWNER_FILTER_UNKNOWN),
          inheritedFilter:
            trace.ownership.inheritedOwner?.id ?? OWNER_FILTER_UNKNOWN,
          inheritedSource:
            trace.steps.find((step) => step.decides)?.source === "acquisition"
              ? "unresolved"
              : (trace.steps.find((step) => step.decides)?.source ??
                "unresolved"),
          fallbackSource: trace.fallbackSource,
        },
        sort: trace.ownership.effectiveOwner?.name ?? null,
        decision: {
          outcome: { kind: "value" },
          provenance:
            trace.ownership.mode === "explicit"
              ? { kind: "own", ownership: { kind: "record" } }
              : trace.fallbackSource
                ? { kind: "inherited", source: trace.fallbackSource }
                : { kind: "computed" },
        },
      } satisfies DerivedComputed,
    ]),
  );
};

export const productOwnershipCompute: DerivedCompute = async (db, ids) => {
  const products = await unwrapDb(db)
    .select({ id: product.id })
    .from(product)
    .where(
      and(
        inArray(
          product.id,
          ids.map((id) => parseEntityId("product", id)),
        ),
        notDeleted(product),
      ),
    );
  const owners = await computeProductOwners(
    db,
    products.map((row) => row.id),
  );
  return new Map(
    [...owners].map(([id, owners]) => [
      id,
      {
        value: {
          owners,
          ownerFilters: owners.map(
            (owner) =>
              owner.ref?.entityId ??
              (owner.inherited ? OWNER_FILTER_UNKNOWN : OWNER_FILTER_HOUSEHOLD),
          ),
        },
        sort: null,
      },
    ]),
  );
};

export const inventoryDerivedComputes = {
  "inventory.ownership": inventoryOwnershipCompute,
  "inventory.valuation": inventoryValuationCompute,
};
