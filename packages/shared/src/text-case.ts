/**
 * Case conversions whose result type mirrors the runtime string, so a roster
 * key derived from an entity key (`financialAccount` →
 * `FINANCIAL_ACCOUNT_NOT_FOUND`, `product` → `ProductId`) keeps its literal
 * type and still satisfies a closed `Record`.
 */

/** `camelCase` → `SCREAMING_SNAKE`; each upper-case boundary becomes `_`. */
export type ScreamingSnake<S extends string> = S extends `${infer H}${infer T}`
  ? `${H extends Lowercase<H> ? "" : "_"}${Uppercase<H>}${ScreamingSnake<T>}`
  : "";

export const screamingSnake = <S extends string>(value: S): ScreamingSnake<S> =>
  // SAFETY: an underscore before every upper-case char, then upper-case the
  // whole — the same rule the type applies char by char.
  value
    .replace(/[A-Z]/gu, (char) => `_${char}`)
    .toUpperCase() as ScreamingSnake<S>;

/** First character upper-cased; the rest untouched. */
export const capitalize = <S extends string>(value: S): Capitalize<S> =>
  // SAFETY: `Capitalize<S>` is exactly this transformation.
  `${value.charAt(0).toUpperCase()}${value.slice(1)}` as Capitalize<S>;
