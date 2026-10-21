import tokens from "../../design-tokens/tokens.json" with { type: "json" };
import { z } from "zod";

export const enumRoles = ["status", "category"] as const;
export type EnumRole = (typeof enumRoles)[number];
export type ColorToken = keyof typeof tokens.colors;

export const colorTokenSchema = z.custom<ColorToken>(
  (value) => typeof value === "string" && Object.hasOwn(tokens.colors, value),
  "must name a color in design-tokens/tokens.json",
);
export const enumIconSchema = z.strictObject({
  phosphor: z.string().min(1),
  sfSymbol: z.string().min(1),
});
export type EnumIcon = z.infer<typeof enumIconSchema>;

const enumPresentationSchema = z.strictObject({
  role: z.enum(enumRoles),
  color: z.string().min(1),
  glyph: enumIconSchema,
});
export type EnumPresentation = z.infer<typeof enumPresentationSchema>;

/** Tone defaults are explicit visual vocabulary, independent of stored words. */
const STATUS_GLYPHS = new Map<string, EnumIcon>(
  Object.entries({
    positive: { phosphor: "CheckCircle", sfSymbol: "checkmark.circle.fill" },
    warning: { phosphor: "Clock", sfSymbol: "clock" },
    destructive: { phosphor: "XCircle", sfSymbol: "xmark.circle.fill" },
    info: { phosphor: "CircleHalf", sfSymbol: "circle.lefthalf.filled" },
    "neutral-status": { phosphor: "CircleDashed", sfSymbol: "circle.dashed" },
  } satisfies Partial<Record<ColorToken, EnumIcon>>),
);

type OptionInput = {
  value: string;
  color?: string;
  role?: string | null;
  glyph?: EnumIcon;
};
type RosterDefaults = {
  role?: EnumRole | null;
  color?: ColorToken | null;
  glyph?: EnumIcon | null;
};

/** Authoring token keys become the existing cross-client CSS-token wire form. */
export const optionColorCss = (token: ColorToken) => `var(--brand-${token})`;

/**
 * Compile the declared presentation once. Missing choices fail at the owning
 * entity/field/value rather than borrowing meaning from a word or array index.
 */
export function compileEnumOptions<T extends OptionInput>(
  options: readonly T[],
  defaults: RosterDefaults,
  context: string,
): Array<Omit<T, "color" | "role" | "glyph"> & EnumPresentation> {
  const seen = new Set<string>();
  return options.map((option) => {
    const where = `${context} option ${JSON.stringify(option.value)}`;
    if (seen.has(option.value)) throw new Error(`${where}: duplicate value`);
    seen.add(option.value);
    const role = z.enum(enumRoles).safeParse(option.role ?? defaults.role);
    if (!role.success) throw new Error(`${where}: declare a roster role`);
    if (defaults.role && option.role && option.role !== defaults.role)
      throw new Error(`${where}: role must match its roster`);
    const rawColor = option.color ?? defaults.color;
    if (!rawColor) throw new Error(`${where}: declare a color token`);
    const color = colorTokenSchema.safeParse(rawColor);
    if (!color.success)
      throw new Error(
        `${where}: unknown color token ${JSON.stringify(rawColor)}`,
      );
    const statusGlyph = STATUS_GLYPHS.get(color.data);
    if (role.data === "status" && !statusGlyph)
      throw new Error(`${where}: a status must use a condition tone`);
    const glyph =
      option.glyph ??
      defaults.glyph ??
      (role.data === "status" ? statusGlyph : undefined);
    if (!glyph) throw new Error(`${where}: declare a contextual glyph`);
    return {
      ...option,
      role: role.data,
      color: optionColorCss(color.data),
      glyph,
    };
  });
}
