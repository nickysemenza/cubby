import type { WAmount } from "@cubby/recipebridge";
import type { Amount } from "@cubby/schemas/codec";

/**
 * Per-axis parser drift for one stored ingredient occurrence. Each field holds the fresh
 * re-parse value when that axis drifted, else null. Serializable (crosses the wire in
 * StaleIngredientParse). Test with {@link hasDrift}; check fields with `!== null` —
 * drift-to-empty is `[]`/`""`, not null.
 */
export interface ParseDrift {
  name: string | null;
  amounts: WAmount[] | null;
  modifier: string | null;
}

const norm = (s: string) => s.trim().toLowerCase();

/**
 * Structural amount equality, comparing only `value` + `unit` per element in order.
 *
 * `upper_value` is intentionally ignored: the persisted {@link Amount} shape has no
 * such field and the import/apply write path stores `{ value, unit }` only, so a
 * range's upper bound is never persisted. Comparing it would false-flag every ranged
 * line ("2–3 cloves") even right after a fresh import. We compare exactly what the
 * write path persists.
 */
export const amountsEqual = (
  persisted: readonly Amount[],
  fresh: readonly WAmount[],
): boolean => {
  if (persisted.length !== fresh.length) return false;
  return persisted.every(
    (p, i) => p.value === fresh[i]?.value && p.unit === fresh[i]?.unit,
  );
};

/**
 * Compare a persisted ingredient occurrence against a fresh parse of its raw line.
 * Pure — the caller does the `wasm.parse_ingredient(rawLine)` and passes `fresh`, so
 * this stays wasm-free and runs identically on client and server.
 *
 * `knownNames` is the ingredient's name plus its aliases: a parsed name that matches
 * any of them is NOT drift (mirrors `findOrCreateIngredient`'s case-insensitive,
 * alias-aware matching), so an alias hit doesn't read as a false positive.
 */
export const computeParseDrift = (
  persisted: {
    knownNames: readonly string[];
    amounts: readonly Amount[];
    modifier: string | null;
  },
  // `wasm.parse_ingredient` returns a deeply-readonly value; accept readonly.
  fresh: {
    name: string;
    amounts: readonly WAmount[];
    modifier?: string;
  },
): ParseDrift => {
  const known = new Set(persisted.knownNames.map(norm).filter(Boolean));
  const nameDrifted = !known.has(norm(fresh.name));

  const amountsDrifted = !amountsEqual(persisted.amounts, fresh.amounts);

  const freshModifier = (fresh.modifier ?? "").trim();
  const storedModifier = (persisted.modifier ?? "").trim();
  const modifierDrifted = freshModifier !== storedModifier;

  return {
    name: nameDrifted ? fresh.name : null,
    // Clone into plain mutable WAmounts (the input is deep-readonly).
    amounts: amountsDrifted
      ? fresh.amounts.map((a) => ({
          unit: a.unit,
          value: a.value,
          upper_value: a.upper_value,
        }))
      : null,
    modifier: modifierDrifted ? freshModifier : null,
  };
};

/**
 * Whether any axis drifted. The single signal every surface keys off (editor gate,
 * detail-table arrow, problems badge). All drift is equal — a row is in sync with the
 * parser or it isn't. Severity (name/amounts before modifier) is a display/sort choice,
 * never a filter on what counts.
 */
export const hasDrift = (d: ParseDrift): boolean =>
  d.name !== null || d.amounts !== null || d.modifier !== null;
