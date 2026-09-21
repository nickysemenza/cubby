import { z } from "zod";

import {
  expenseShortcode,
  inventoryShortcode,
  ledgerPartyShortcode,
  purchaseShortcode,
} from "./identifier-fields";
import { ledgerAttributionInput, ledgerPartyKind } from "./ledger-party-fields";

export const inventoryOwnershipModeValues = [
  "inherit",
  "person",
  "unassigned",
] as const;
export const inventoryOwnershipMode = z.enum(inventoryOwnershipModeValues);
export type InventoryOwnershipMode = z.infer<typeof inventoryOwnershipMode>;

export const inventoryOwner = z.object({
  id: ledgerPartyShortcode,
  name: z.string(),
  kind: ledgerPartyKind.exclude(["household"]),
});
export type InventoryOwner = z.infer<typeof inventoryOwner>;

export const inventoryOwnershipSourceValues = [
  "explicit",
  "unassigned",
  "inherited_beneficiary",
  "inherited_vendor_account",
  "inherited_payment_account",
  "unresolved",
] as const;
export const inventoryOwnershipSource = z.enum(inventoryOwnershipSourceValues);
export type InventoryOwnershipSource = z.infer<typeof inventoryOwnershipSource>;

export const inventoryOwnershipEvidence = z.object({
  purchaseId: purchaseShortcode.nullable(),
  expenseIds: z.array(expenseShortcode),
  acquisitionKey: z.string().nullable(),
});

/**
 * The resolved value and its trace are one value so a consumer cannot render
 * an owner from one read and explain it with evidence from another.
 */
export const effectiveInventoryOwnership = z.object({
  mode: inventoryOwnershipMode,
  explicitOwner: inventoryOwner.nullable(),
  effectiveOwner: inventoryOwner.nullable(),
  source: inventoryOwnershipSource,
  basis: z.literal("Inferred from the only recorded acquisition").nullable(),
  evidence: inventoryOwnershipEvidence.nullable(),
  evidenceFingerprint: z.string(),
  matchesInheritedOwner: z.boolean(),
});
export type EffectiveInventoryOwnership = z.infer<
  typeof effectiveInventoryOwnership
>;

export const inventoryOwnershipSelection = z.discriminatedUnion("mode", [
  z.object({ mode: z.literal("inherit"), ownerId: z.null().optional() }),
  z.object({ mode: z.literal("unassigned"), ownerId: z.null().optional() }),
  z.object({ mode: z.literal("person"), ownerId: ledgerPartyShortcode }),
]);
export type InventoryOwnershipSelection = z.infer<
  typeof inventoryOwnershipSelection
>;

export const setInventoryOwnershipInput = z.object({
  inventoryEntryId: inventoryShortcode,
  ownership: inventoryOwnershipSelection,
  quantity: z.number().positive().optional(),
});

export const confirmInventoryOwnershipInput = z.object({
  inventoryEntryId: inventoryShortcode,
  evidenceFingerprint: z.string().min(1),
  quantity: z.number().positive().optional(),
});

export const inventoryOwnershipMutationOut = z.object({
  entries: z.array(inventoryShortcode),
});

export const expenseInventoryOwnershipContextInput = z.object({
  inventoryEntryId: inventoryShortcode,
});

export const expenseInventoryOwnershipContextOut = z.object({
  inventoryEntryId: inventoryShortcode,
  effectiveOwnership: effectiveInventoryOwnership,
  suggestedBeneficiaries: z.array(ledgerAttributionInput),
});

export const confirmInventoryExpenseBeneficiaryInput = z.object({
  inventoryEntryId: inventoryShortcode,
  expenseId: expenseShortcode,
  evidenceFingerprint: z.string().min(1),
});

export const confirmInventoryExpenseBeneficiaryOut = z.object({
  expenseId: expenseShortcode,
  beneficiaries: z.array(ledgerAttributionInput),
});
