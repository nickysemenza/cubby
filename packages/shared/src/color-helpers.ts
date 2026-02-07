/**
 * Transforms an HSL color string to HSLA with the given opacity.
 * Useful for tinted backgrounds in React Native badge components.
 *
 * @example withOpacity("hsl(142, 55%, 45%)", 0.15) → "hsla(142, 55%, 45%, 0.15)"
 */
export function withOpacity(hslColor: string, opacity: number): string {
  // "hsl(h, s%, l%)" → "hsla(h, s%, l%, opacity)"
  return hslColor.replace("hsl(", "hsla(").replace(")", `, ${opacity})`);
}
