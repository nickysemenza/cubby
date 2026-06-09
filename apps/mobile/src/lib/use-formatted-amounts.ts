import type { WAmount } from "@cubby/recipebridge";
import { useEffect, useState } from "react";
import { formatAmounts } from "./recipebridge";

/**
 * Format a list's amounts via on-device recipebridge in a single round-trip.
 * Returns a Map of id → formatted string; rows fall back to a raw value until it
 * resolves. Mirrors the web's tryFormatAmount (apps/web/.../format-amount.tsx).
 */
export function useFormattedAmounts<T>(
  items: T[],
  getId: (item: T) => string,
  getAmount: (item: T) => WAmount | null | undefined,
): Map<string, string> {
  const [formatted, setFormatted] = useState<Map<string, string>>(
    () => new Map(),
  );

  // Re-run only when the set of (id, amount) actually changes.
  const sig = items
    .map((it) => {
      const a = getAmount(it);
      return a
        ? `${getId(it)}:${a.value}:${a.unit}:${a.upper_value ?? ""}`
        : "";
    })
    .join("|");

  // biome-ignore lint/correctness/useExhaustiveDependencies: keyed on `sig`.
  useEffect(() => {
    let active = true;
    const withAmount = items.filter((it) => getAmount(it) != null);
    if (withAmount.length === 0) {
      setFormatted(new Map());
      return;
    }
    formatAmounts(withAmount.map((it) => getAmount(it) as WAmount))
      .then((results) => {
        if (!active) return;
        const map = new Map<string, string>();
        withAmount.forEach((it, idx) => {
          const f = results[idx];
          if (f != null) map.set(getId(it), f);
        });
        setFormatted(map);
      })
      .catch(() => {});
    return () => {
      active = false;
    };
  }, [sig]);

  return formatted;
}

/**
 * Like useFormattedAmounts, but each item has an ARRAY of amounts; returns a Map
 * of id → the item's amounts formatted and joined (e.g. "⅓ cup, 173 g"). All
 * amounts across all items are formatted in one round-trip.
 */
export function useFormattedAmountLists<T>(
  items: T[],
  getId: (item: T) => string,
  getAmounts: (item: T) => WAmount[],
  sep = ", ",
): Map<string, string> {
  const [formatted, setFormatted] = useState<Map<string, string>>(
    () => new Map(),
  );

  const sig = items
    .map(
      (it) =>
        `${getId(it)}:${getAmounts(it)
          .map((a) => `${a.value}/${a.unit}/${a.upper_value ?? ""}`)
          .join(",")}`,
    )
    .join("|");

  // biome-ignore lint/correctness/useExhaustiveDependencies: keyed on `sig`.
  useEffect(() => {
    let active = true;
    // Flatten all amounts, tracking each item's span, so one batch covers everyone.
    const flat: WAmount[] = [];
    const spans: { id: string; start: number; len: number }[] = [];
    for (const it of items) {
      const amts = getAmounts(it);
      if (amts.length === 0) continue;
      spans.push({ id: getId(it), start: flat.length, len: amts.length });
      flat.push(...amts);
    }
    if (flat.length === 0) {
      setFormatted(new Map());
      return;
    }
    formatAmounts(flat)
      .then((results) => {
        if (!active) return;
        const map = new Map<string, string>();
        for (const sp of spans) {
          const parts = results
            .slice(sp.start, sp.start + sp.len)
            .filter((x): x is string => x != null);
          if (parts.length) map.set(sp.id, parts.join(sep));
        }
        setFormatted(map);
      })
      .catch(() => {});
    return () => {
      active = false;
    };
  }, [sig, sep]);

  return formatted;
}
