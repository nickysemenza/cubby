import { isCollectionTag, normalizeCollectionSlug } from "./collection-tag";

/** One sibling field (or derived fact) a tag might restate, keyed by a reason
 * string the caller controls (e.g. `"manufacturer"`, `"classification"`). A
 * value may be a single string (a name) or a list (a classification path, a
 * set of aliases); `null`/`undefined` means that reason has no signal. */
export type RedundantTokensRestating = Readonly<
  Record<string, string | readonly string[] | null | undefined>
>;

export interface RedundantTokensInput {
  readonly values: readonly string[];
  readonly restating: RedundantTokensRestating;
}

export interface RedundantTokenMatch {
  /** The original tag value, unmodified. */
  readonly value: string;
  /** The `restating` key it matched (e.g. `"manufacturer"`). */
  readonly reason: string;
  /** The specific restating value it matched, unmodified. */
  readonly matched: string;
}

/** A tag carrying a digit or `/` names a shape (`M18`, `grinder-4.5in`,
 * `1/4-hex`) that can never restate a plain-English sibling field — skip the
 * whole redundancy check for it, not just the singularizer below. */
const hasDigitOrSlash = (value: string): boolean => /[0-9/]/u.test(value);

/**
 * A trivial plural stripper — enough to catch "pants"/"accessories" restating
 * a singular classification name ("pant"/"accessory") without a full
 * inflection library. A false positive on a genuine plural-only noun costs
 * nothing: the caller only ever proposes a *removal* for review, never a
 * silent delete.
 */
const singularize = (value: string): string => {
  if (value.endsWith("ies") && value.length > 3)
    return `${value.slice(0, -3)}y`;
  if (value.endsWith("s") && !value.endsWith("ss")) return value.slice(0, -1);
  return value;
};

/** Both the slug-normalized form and its singular, so either side of a
 * plural/singular pair (tag vs. restating value) still lines up. */
const normalizedForms = (value: string): ReadonlySet<string> => {
  const normalized = normalizeCollectionSlug(value);
  return new Set([normalized, singularize(normalized)]);
};

interface RestatingCandidate {
  readonly reason: string;
  readonly matched: string;
  readonly forms: ReadonlySet<string>;
}

const restatingCandidates = (
  restating: RedundantTokensRestating,
): readonly RestatingCandidate[] => {
  const candidates: RestatingCandidate[] = [];
  for (const [reason, raw] of Object.entries(restating)) {
    if (raw == null) continue;
    for (const matched of Array.isArray(raw) ? raw : [raw]) {
      const trimmed = matched.trim();
      if (!trimmed) continue;
      candidates.push({
        reason,
        matched: trimmed,
        forms: normalizedForms(trimmed),
      });
    }
  }
  return candidates;
};

/**
 * A tag restates a sibling field when it — after slug normalization and a
 * trivial singularizer — equals that field's own normalized value: a product
 * tagged "jacquemus" restates its manufacturer, "apparel" or "pants" restates
 * a classification path segment "Apparel"/"Pant". `collection:*` entries
 * (Collections owns those) and any token carrying a digit or `/` (`M18`,
 * `grinder-4.5in`, `1/4-hex` — real compatibility shapes, not prose) are
 * never flagged. Pure, synchronous, and order-preserving: every prune target
 * (client-side chip marking, server-side `ArrayPruneSuggestSpec`s) calls this
 * directly rather than re-deriving the rule.
 */
export function redundantTokens({
  values,
  restating,
}: RedundantTokensInput): RedundantTokenMatch[] {
  const candidates = restatingCandidates(restating);
  if (candidates.length === 0) return [];
  const matches: RedundantTokenMatch[] = [];
  for (const value of values) {
    if (isCollectionTag(value) || hasDigitOrSlash(value)) continue;
    const forms = normalizedForms(value);
    const hit = candidates.find((candidate) =>
      [...forms].some((form) => form.length > 0 && candidate.forms.has(form)),
    );
    if (hit) matches.push({ value, reason: hit.reason, matched: hit.matched });
  }
  return matches;
}
