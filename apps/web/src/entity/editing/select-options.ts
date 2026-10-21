import type { EnumIcon, EnumRole } from "@cubby/shared/enum-palette";
import { createElement, type ReactNode } from "react";

import { colorizeSelectOptions } from "~/lib/select-options";
import { OptionGlyph } from "~/ui/common/option-glyph";

/** One picker option: a value/label pair plus an optional leading icon or swatch color. */
export type EntitySelectOption = Readonly<{
  value: string;
  label: string;
  /** What choosing this option means; shown as the pill's tooltip. */
  description?: string;
  icon?: ReactNode;
  color?: string;
  /** Compiler-filled roster role: states tint, kinds stay neutral. */
  role?: EnumRole;
  /** Declared or shared semantic glyph; becomes `icon` for pickers. */
  glyph?: EnumIcon;
}>;

/**
 * Completes a declared enum roster with web-only sentinels and deterministic
 * presentation. Declared values stay first; sentinel-only values follow in
 * their source order. A declared `glyph` becomes the picker's leading icon,
 * tinted with the option's color; a caller's explicit icon wins.
 */
export function presentEntitySelectOptions(
  entity: string,
  key: string,
  declaredOptions: readonly EntitySelectOption[] = [],
  mode?: "create" | "edit",
): EntitySelectOption[] {
  const richOptions = entitySelectOptionsFor(entity, key, mode) ?? [];
  const richByValue = new Map(
    richOptions.map((option) => [option.value, option]),
  );
  const seen = new Set<string>();
  const merged = [...declaredOptions, ...richOptions]
    .filter((option) => {
      if (seen.has(option.value)) return false;
      seen.add(option.value);
      return true;
    })
    .map((declaredOption) => {
      const richOption = richByValue.get(declaredOption.value);
      return { ...richOption, ...declaredOption };
    });
  return colorizeSelectOptions(merged).map((option) =>
    option.glyph && option.icon === undefined
      ? {
          ...option,
          icon: createElement(OptionGlyph, {
            name: option.glyph.phosphor,
            color: option.color,
          }),
        }
      : option,
  );
}

/**
 * Web-only editor sentinels. Labels, colors and glyphs belong to the
 * declarations (`control.options[].glyph`), so every client draws the same
 * mark; only choices the stored schema never holds live here. The generic
 * editor, bulk edit and inline `select` editors all read this one source.
 */
const ENTITY_SELECT_OPTIONS = {
  // The capture form's `"auto"` sentinel asks the server's role Decision
  // before create; `buildData` strips it before validation.
  "expense.lineKind": [
    {
      value: "auto",
      label: "Decide from receipt evidence",
      glyph: { phosphor: "Sparkle", sfSymbol: "sparkles" },
    },
  ],
} satisfies Readonly<Record<string, readonly EntitySelectOption[]>>;

/**
 * `mode` filters out create-only sentinel options (`"expense.lineKind"`'s
 * `"auto"`) once the field is editing a stored record: the update schema
 * has no `"auto"` member, so an edit surface offering it would let a
 * submit fail validation on a value the create-only `buildData` strip
 * never sees.
 */
export function entitySelectOptionsFor(
  entity: string,
  key: string,
  mode?: "create" | "edit",
): readonly EntitySelectOption[] | undefined {
  const optionsKey = `${entity}.${key}`;
  if (!Object.hasOwn(ENTITY_SELECT_OPTIONS, optionsKey)) return undefined;
  // SAFETY: the `Object.hasOwn` check above proves `optionsKey` is one of
  // `ENTITY_SELECT_OPTIONS`'s own declared keys, not an arbitrary string.
  const options =
    ENTITY_SELECT_OPTIONS[optionsKey as keyof typeof ENTITY_SELECT_OPTIONS];
  if (optionsKey === "expense.lineKind" && mode === "edit") {
    return options.filter((option) => option.value !== "auto");
  }
  return options;
}
