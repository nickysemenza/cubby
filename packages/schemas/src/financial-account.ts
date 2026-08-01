import { z } from "zod";
import { financialAccountRelatedFilterFields } from "./related-view";
import { deriveUpdateData, timestampedFields } from "./base-entity";
import { financialAccountShortcode } from "./identifiers";
import {
  createPaginatedResponseSchema,
  oneOrMany,
  presenceFilter,
} from "./pagination";

const last4 = z.string().regex(/^\d{4}$/, "expected four digits");

export const financialAccountIdentityKind = z.enum([
  "credit_card",
  "bank_account",
  "stored_value",
  "cash",
  "other",
]);
export type FinancialAccountIdentityKind = z.infer<
  typeof financialAccountIdentityKind
>;

const nullableLast4 = last4.nullable();

export const financialAccountIdentity = z.discriminatedUnion("kind", [
  z.strictObject({
    kind: z.literal("credit_card"),
    issuer: z.string().nullable(),
    network: z
      .enum(["visa", "mastercard", "amex", "discover", "other"])
      .nullable(),
    last4: nullableLast4,
  }),
  z.strictObject({
    kind: z.literal("bank_account"),
    institution: z.string().nullable(),
    accountType: z.enum(["checking", "savings", "money_market", "other"]),
    last4: nullableLast4,
  }),
  z.strictObject({
    kind: z.literal("stored_value"),
    provider: z.string().min(1),
    last4: nullableLast4,
  }),
  z.strictObject({ kind: z.literal("cash") }),
  z.strictObject({
    kind: z.literal("other"),
    institution: z.string().nullable(),
    last4: nullableLast4,
  }),
]);
export type FinancialAccountIdentity = z.infer<typeof financialAccountIdentity>;

export const financialAccountSourceAlias = z.strictObject({
  source: z.string().min(1),
  alias: z.string().min(1),
  externalAccountId: z.string().min(1).nullable(),
});
export type FinancialAccountSourceAlias = z.infer<
  typeof financialAccountSourceAlias
>;

export const financialAccountSourceAliases = z
  .array(financialAccountSourceAlias)
  .refine((aliases) => {
    const seen = new Set<string>();
    for (const alias of aliases) {
      // Provider ids are account identity, so two labels for one provider id
      // are still duplicate aliases. Without an id, the display alias is only
      // advisory evidence, but repeating that same evidence adds no value.
      const key =
        alias.externalAccountId === null
          ? `alias\u0000${alias.source}\u0000${alias.alias}`
          : `id\u0000${alias.source}\u0000${alias.externalAccountId}`;
      if (seen.has(key)) return false;
      seen.add(key);
    }
    return true;
  }, "sourceAliases must not contain duplicate entries");

const financialAccountFields = {
  name: z.string().min(1),
  identity: financialAccountIdentity,
  provisional: z.boolean(),
  sourceAliases: financialAccountSourceAliases,
  notes: z.string().nullable(),
};

const financialAccountCreateShape = {
  ...financialAccountFields,
  provisional: z.boolean().default(false),
  sourceAliases: financialAccountSourceAliases.default([]),
  notes: z.string().nullable().default(null),
};

export const financialAccountCreateInput = z.object(
  financialAccountCreateShape,
);
export type FinancialAccountCreateInput = z.infer<
  typeof financialAccountCreateInput
>;

export const financialAccountUpdateData = deriveUpdateData(
  financialAccountCreateShape,
);
export type FinancialAccountUpdateData = z.infer<
  typeof financialAccountUpdateData
>;
export const financialAccountUpdateInput = z.object({
  id: financialAccountShortcode,
  data: financialAccountUpdateData,
});
export type FinancialAccountUpdateInput = z.infer<
  typeof financialAccountUpdateInput
>;

export const financialAccountFilterFields = {
  ...financialAccountRelatedFilterFields,
  search: z.string().optional(),
  identityKind: oneOrMany(financialAccountIdentityKind).optional(),
  provisional: z.boolean().optional(),
  last4: z
    .string()
    .regex(/^\d{4}$/)
    .optional(),
  source: oneOrMany(z.string().min(1)).optional(),
  externalAccountId: oneOrMany(z.string().min(1)).optional(),
  sourceAliasPresenceFilter: presenceFilter,
};
export const financialAccountFiltersSchema = z.object(
  financialAccountFilterFields,
);
export type FinancialAccountFilters = z.infer<
  typeof financialAccountFiltersSchema
>;

export const financialAccountSortableFields = [
  "name",
  "provisional",
  "transactionCount",
  "createdAt",
] as const;
export type FinancialAccountSortField =
  (typeof financialAccountSortableFields)[number];

export const financialAccountOut = z.object({
  id: financialAccountShortcode,
  ...financialAccountFields,
  transactionCount: z.number().int().nonnegative(),
  ...timestampedFields,
});
export type FinancialAccountOut = z.infer<typeof financialAccountOut>;

export const financialAccountListResponse =
  createPaginatedResponseSchema(financialAccountOut);
export type FinancialAccountListResponse = z.infer<
  typeof financialAccountListResponse
>;
