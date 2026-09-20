/**
 * One platform's disposition for a semantic renderer or slot declared by the
 * entity manifest. Registries are exhaustive over generated ids, so adding a
 * declaration requires an implementation or an explicit ownership/safety
 * decision instead of silently dropping presentation.
 */
export type PresentationCoverage<Implementation> =
  | { readonly kind: "implemented"; readonly implementation: Implementation }
  | { readonly kind: "generic" }
  | { readonly kind: "ownedElsewhere" }
  | { readonly kind: "unsupported"; readonly reason: string };

export const implemented = <Implementation>(
  implementation: Implementation,
): PresentationCoverage<Implementation> => ({
  kind: "implemented",
  implementation,
});

export const generic = {
  kind: "generic",
} as const satisfies PresentationCoverage<never>;

export const ownedElsewhere = {
  kind: "ownedElsewhere",
} as const satisfies PresentationCoverage<never>;

export const unsupported = (reason: string): PresentationCoverage<never> => ({
  kind: "unsupported",
  reason,
});
