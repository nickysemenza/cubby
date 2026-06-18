/**
 * English count pluralization, single-sourced (this is a single-user app, so no
 * i18n). Replaces the `count === 1 ? "" : "s"` idiom hand-written across toasts,
 * dialogs, and labels.
 */

/** The word form for a count: `singular` when 1, else `plural` (default `${singular}s`). */
export const pluralize = (
  count: number,
  singular: string,
  plural?: string,
): string => (count === 1 ? singular : (plural ?? `${singular}s`));

/** "1 item" / "3 items" — the count plus its pluralized word. */
export const countLabel = (
  count: number,
  singular: string,
  plural?: string,
): string => `${count} ${pluralize(count, singular, plural)}`;
