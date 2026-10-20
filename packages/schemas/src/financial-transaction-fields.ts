import { z } from "zod";
import { uniqueBy } from "./base-entity";
import { externalIdSource } from "./external-id";
import { purchaseShortcode, vendorShortcode } from "./identifier-fields";
import { wholeCentAmount } from "./money";
import { plainDate } from "./base-entity";

/** Posting state reported by the source, independent of Cubby classification. */
const financialTransactionKindValues = [
  "purchase",
  "refund",
  "account_transfer",
  "credit_card_payment",
  "fee",
  "interest",
  "income",
  "adjustment",
  "other",
] as const;
const financialTransactionStatusValues = [
  "expected",
  "pending",
  "posted",
  "void",
] as const;
export const financialTransactionKind = z.enum(financialTransactionKindValues);
export type FinancialTransactionKind = z.infer<typeof financialTransactionKind>;
export const financialTransactionStatus = z.enum(
  financialTransactionStatusValues,
);
export type FinancialTransactionStatus = z.infer<
  typeof financialTransactionStatus
>;

export const financialTransactionProviderStatus = z.enum(["posted", "pending"]);

export const financialTransactionNonZeroAmount = wholeCentAmount.refine(
  (amount) => amount !== 0,
  "amount must be non-zero",
);

export const financialTransactionSourceRef = z.strictObject({
  // Same slug rule as every other source column: `ExternalSource.slug` is a
  // kebab-case CHECK, so a hand-typed "Monarch " must normalize, not fail it.
  source: externalIdSource,
  externalId: z.string().min(1),
});
export type FinancialTransactionSourceRef = z.infer<
  typeof financialTransactionSourceRef
>;
export const financialTransactionSourceRefs = z
  .array(financialTransactionSourceRef)
  .refine(
    ...uniqueBy<FinancialTransactionSourceRef>(
      (ref) => `${ref.source}\u0000${ref.externalId}`,
      "sourceRefs must not contain duplicate source/externalId pairs",
    ),
  );

export const financialTransactionAllocation = z.object({
  purchaseId: purchaseShortcode,
  amount: wholeCentAmount,
});
export const financialTransactionAllocations = z.array(
  financialTransactionAllocation,
);

/**
 * How well a charge's purchase is itemized against it. `shared` wins over every
 * other verdict: a charge that is one of several on a purchase (installments,
 * combined orders) is never compared to that purchase's lines.
 */
export const financialTransactionItemizationValues = [
  "bare",
  "lump",
  "itemized_match",
  "itemized_mismatch",
  "shared",
] as const;
export const financialTransactionItemization = z.enum(
  financialTransactionItemizationValues,
);
export type FinancialTransactionItemization = z.infer<
  typeof financialTransactionItemization
>;

export const merchantVendorCandidate = z.object({
  vendorId: vendorShortcode,
  vendorName: z.string().min(1),
  supportingTransactionCount: z.number().int().positive(),
  lastSeenDate: plainDate.nullable(),
});
const noMerchantVendorCandidates = z.object({
  status: z.literal("none"),
  candidates: z.tuple([]),
});
const insufficientMerchantVendorCandidate = merchantVendorCandidate.extend({
  supportingTransactionCount: z.literal(1),
});
const suggestedMerchantVendorCandidate = merchantVendorCandidate.extend({
  supportingTransactionCount: z.number().int().min(2),
});
export const merchantVendorInference = z.discriminatedUnion("status", [
  noMerchantVendorCandidates,
  z.object({
    status: z.literal("insufficient_history"),
    candidates: z.tuple([insufficientMerchantVendorCandidate]),
  }),
  z.object({
    status: z.literal("suggested"),
    candidates: z.tuple([suggestedMerchantVendorCandidate]),
  }),
  z.object({
    status: z.literal("ambiguous"),
    candidates: z.array(merchantVendorCandidate).min(2),
  }),
]);

/**
 * Payment processors recognized by a bank descriptor's prefix
 * (`SQ *BLUE BOTTLE`, `TST* JOES PIZZA`). Each pattern is a POSIX regex that
 * Postgres (`~*`) and JavaScript evaluate the same way, so the list filter
 * and {@link parseBankDescriptor} cannot disagree. The raw descriptor stays
 * the record; the processor is derived on read.
 */
export const descriptorProcessor = z.enum([
  "square",
  "toast",
  "paypal",
  "shopify",
  "instacart",
  "py",
]);
// Whitespace is the explicit `[ \t]` class: Postgres classifies non-ASCII
// spaces by locale, so `\s` would let the parser and the SQL filter disagree.
// The parser matches the untrimmed descriptor for the same reason.
export const descriptorProcessors = [
  {
    value: "square",
    label: "Square",
    pattern: "^[ \\t]*(SQ|SQUARE)[ \\t]*\\*",
  },
  { value: "toast", label: "Toast", pattern: "^[ \\t]*TST[ \\t]*\\*" },
  {
    value: "paypal",
    label: "PayPal",
    pattern: "^[ \\t]*(PAYPAL|PP)[ \\t]*\\*",
  },
  { value: "shopify", label: "Shopify", pattern: "^[ \\t]*SP[ \\t]+" },
  { value: "instacart", label: "Instacart", pattern: "^[ \\t]*IC[ \\t]*\\*" },
  { value: "py", label: "PY", pattern: "^[ \\t]*PY[ \\t]*\\*" },
] as const satisfies readonly {
  value: z.infer<typeof descriptorProcessor>;
  label: string;
  pattern: string;
}[];
export type DescriptorProcessor = z.infer<typeof descriptorProcessor>;

const US_STATE =
  /^(A[KLRZ]|C[AOT]|D[CE]|FL|GA|HI|I[ADLN]|K[SY]|LA|M[ADEINOST]|N[CDEHJMVY]|O[HKR]|PA|RI|S[CD]|T[NX]|UT|V[AT]|W[AIVY])$/u;

// Multiword US cities common in descriptors; a trailing match is removed
// whole, so a merchant word like `LAKE` survives unless the full name matches.
const MULTIWORD_CITIES = new Set([
  "SAN FRANCISCO",
  "SAN JOSE",
  "SAN DIEGO",
  "SAN ANTONIO",
  "SAN MATEO",
  "SANTA MONICA",
  "SANTA CLARA",
  "SANTA BARBARA",
  "SANTA CRUZ",
  "SANTA FE",
  "LOS ANGELES",
  "LOS ALTOS",
  "LAS VEGAS",
  "NEW YORK",
  "NEW ORLEANS",
  "SALT LAKE CITY",
  "KANSAS CITY",
  "JERSEY CITY",
  "OKLAHOMA CITY",
  "ST LOUIS",
  "ST PAUL",
  "SAINT LOUIS",
  "SAINT PAUL",
  "FORT WORTH",
  "FORT LAUDERDALE",
  "PALO ALTO",
  "PALM SPRINGS",
  "EL PASO",
  "LONG BEACH",
  "BATON ROUGE",
  "COLORADO SPRINGS",
  "DES MOINES",
  "ANN ARBOR",
  "LITTLE ROCK",
  "VIRGINIA BEACH",
  "BEVERLY HILLS",
  "CULVER CITY",
  "DALY CITY",
  "REDWOOD CITY",
  "MOUNTAIN VIEW",
  "NORTH BEND",
  "PORT ANGELES",
]);

/**
 * Splits a bank descriptor into its processor and a searchable merchant
 * phrase: the processor prefix, store and reference numbers, a trailing
 * phone number, and a trailing `CITY ST` are removed. A run of two or more
 * spaces is the bank's fixed-width field padding, so the name ends there.
 * `merchant` is null when fewer than three letters remain.
 */
export function parseBankDescriptor(raw: string | null | undefined) {
  let text = raw ?? "";
  const matched = descriptorProcessors.find((processor) =>
    new RegExp(processor.pattern, "iu").test(text),
  );
  if (matched) text = text.replace(new RegExp(matched.pattern, "iu"), "");
  text = text.trim();
  const padded = text.split(/[ \t]{2,}|\t/u).filter(Boolean);
  const words = (padded[0] ?? "")
    .replace(/\(?\d{3}\)?[-. ]?\d{3}[-. ]?\d{4}\s*$/u, " ")
    .replace(/#\s*\d+/gu, " ")
    .replace(/\b\d{3,}\b/gu, " ")
    .replace(/[*#]+/gu, " ")
    .trim()
    .split(/\s+/u)
    .filter(Boolean);
  // A trailing state code and its city: a known multiword city whole,
  // otherwise one word, while a name remains.
  if (words.length >= 3 && US_STATE.test(words.at(-1)?.toUpperCase() ?? "")) {
    words.pop();
    const city = [3, 2].find(
      (size) =>
        words.length > size &&
        MULTIWORD_CITIES.has(words.slice(-size).join(" ").toUpperCase()),
    );
    words.splice(-(city ?? 1));
  }
  const merchant = words.join(" ").toLowerCase();
  return {
    processor: matched?.value ?? null,
    merchant: (merchant.match(/\p{L}/gu)?.length ?? 0) >= 3 ? merchant : null,
  };
}
