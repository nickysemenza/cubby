import { z } from "zod";

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
      const key =
        alias.externalAccountId === null
          ? `alias\u0000${alias.source}\u0000${alias.alias}`
          : `id\u0000${alias.source}\u0000${alias.externalAccountId}`;
      if (seen.has(key)) return false;
      seen.add(key);
    }
    return true;
  }, "sourceAliases must not contain duplicate entries");

export const financialAccountLast4 = last4;
