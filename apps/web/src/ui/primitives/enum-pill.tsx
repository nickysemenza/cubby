import {
  colorizeEnumOptions,
  type EnumIcon,
  type EnumRole,
} from "@cubby/shared/enum-palette";
import type { ReactElement, ReactNode } from "react";

import { cn } from "~/lib/utils";
import { OptionGlyph } from "~/ui/common/option-glyph";
import { Pill } from "~/ui/primitives/pill";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "~/ui/primitives/tooltip";

/**
 * Full-strength ink on its own surface for each condition tone. Neutral
 * ("not started", "none") reads as the inset muted chip.
 */
const STATUS_TONES: Readonly<Record<string, string>> = {
  "var(--positive)": "bg-positive-surface text-positive",
  "var(--warning)": "bg-warning-surface text-warning-ink",
  "var(--destructive)": "bg-destructive-surface text-destructive",
  "var(--info)": "bg-info-surface text-info",
  "var(--neutral-status)": "bg-muted text-muted-foreground",
};

/**
 * Shared chip geometry for both roles. `border-transparent` keeps the 1px
 * box so a suggestion's dashed boundary can paint without shifting the value.
 */
const CHIP = "overflow-hidden border-transparent whitespace-nowrap";

/**
 * The shared palette decides both facts for a lone value: a one-option
 * roster is `status` exactly when its color is a condition tone, and a
 * status option carries its value's (or tone's) inferred glyph.
 */
function paletteFor(
  value: string | undefined,
  color: string | undefined,
  role?: EnumRole,
) {
  return colorizeEnumOptions([{ value: value ?? "", color }], role)[0];
}

type ValueProps = {
  /** Option color: a condition tone for status, a category tint otherwise. */
  color?: string;
  /** The option's declared or inferred glyph (Phosphor name). */
  glyph?: EnumIcon | null;
  /** A caller-drawn leading mark; a declared `glyph` wins over it. */
  icon?: ReactNode;
  /** The option's meaning, shown as a tooltip. */
  description?: string;
  children: ReactNode;
  className?: string;
};

function withDescription(node: ReactElement, description?: string) {
  if (!description) return node;
  return (
    <Tooltip>
      <TooltipTrigger render={node} />
      <TooltipContent side="top" className="max-w-xs">
        {description}
      </TooltipContent>
    </Tooltip>
  );
}

function Lead({
  glyph,
  icon,
  color,
}: {
  glyph?: EnumIcon | null;
  icon?: ReactNode;
  color?: string;
}) {
  if (glyph) return <OptionGlyph name={glyph.phosphor} color={color} />;
  if (!icon) return null;
  return (
    <span aria-hidden className="flex shrink-0 items-center [&>svg]:size-3!">
      {icon}
    </span>
  );
}

/**
 * A state ("Done", "Blocked"): its glyph, then the label, in the tone's
 * full-strength ink on the tone's surface. Glyph and word carry the meaning;
 * color reinforces it.
 */
function StatusValue({
  color = "var(--neutral-status)",
  glyph,
  icon,
  description,
  children,
  className,
  value,
}: ValueProps & {
  /** Stored value, so `blocked`/`paused` keep their own glyph when inferred. */
  value?: string;
}) {
  const tone = STATUS_TONES[color];
  const lead =
    glyph ?? (icon ? null : (paletteFor(value, color, "status")?.glyph ?? null));
  const pill = (
    <Pill
      data-enum-role="status"
      className={cn(CHIP, "ps-1", tone, className)}
      style={
        tone
          ? undefined
          : {
              backgroundColor: `color-mix(in srgb, ${color} 12%, var(--background))`,
              color,
            }
      }
    >
      <Lead glyph={lead} icon={icon} />
      <span className="min-w-0 truncate">{children}</span>
    </Pill>
  );
  return withDescription(pill, description);
}

/**
 * A kind ("Credit card", "Travel"): a quiet option tint and matching glyph.
 * The label keeps foreground ink for contrast on every category surface.
 */
function CategoryValue({
  color,
  glyph,
  icon,
  description,
  children,
  className,
}: ValueProps) {
  const pill = (
    <Pill
      data-enum-role="category"
      className={cn(CHIP, "text-foreground", !color && "bg-muted", className)}
      style={color ? {
        backgroundColor: `color-mix(in srgb, ${color} 12%, var(--background))`,
      } : undefined}
    >
      <Lead glyph={glyph} icon={icon} color={color} />
      <span className="min-w-0 truncate">{children}</span>
    </Pill>
  );
  return withDescription(pill, description);
}

/** The role an option renders as: declared, else inferred from its color. */
function enumRoleFor(role: EnumRole | null | undefined, color?: string) {
  return role ?? paletteFor(undefined, color)?.role ?? "category";
}

/**
 * The one presentation for a declared enum value: `StatusValue` for states,
 * `CategoryValue` for kinds. Callers without an option role (computed
 * statuses, timeline kinds) get it from the color.
 */
export function EnumPill({
  optionRole,
  value,
  ...props
}: ValueProps & {
  /** The roster's role; omitted, the color decides. */
  optionRole?: EnumRole | null;
  value?: string;
}) {
  return enumRoleFor(optionRole, props.color) === "status" ? (
    <StatusValue value={value} {...props} />
  ) : (
    <CategoryValue {...props} />
  );
}

/**
 * A stored boolean in a cell: a positive check for yes, a muted dash for no.
 * No pill — two states need no chip. `null` stays the caller's unknown mark.
 */
export function BooleanValue({
  value,
  trueLabel = "Yes",
  falseLabel = "No",
}: {
  value: boolean;
  trueLabel?: string;
  falseLabel?: string;
}) {
  return value ? (
    <span className="inline-flex items-center gap-1 text-positive">
      <OptionGlyph name="Check" className="size-3.5" />
      <span className="sr-only">{trueLabel}</span>
    </span>
  ) : (
    <span className="inline-flex items-center text-muted-foreground">
      <OptionGlyph name="Minus" weight="regular" className="size-3.5" />
      <span className="sr-only">{falseLabel}</span>
    </span>
  );
}
