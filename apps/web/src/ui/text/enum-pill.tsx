import type { EnumIcon } from "@cubby/shared/enum-palette";
import { CheckIcon } from "@phosphor-icons/react/dist/csr/Check";
import { MinusIcon } from "@phosphor-icons/react/dist/csr/Minus";
import { cn } from "cn";
import type { CSSProperties, ReactElement, ReactNode } from "react";

import { OptionGlyph } from "~/ui/media/option-glyph";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "~/ui/primitives/tooltip";
import { Pill } from "~/ui/text/pill";

/**
 * Shared chip geometry for both roles. `border-transparent` keeps the 1px
 * box so a suggestion's dashed boundary can paint without shifting the value.
 */
const CHIP = "overflow-hidden border-transparent whitespace-nowrap";

/** Tone surfaces are rendering styles; the supplied role decides when to use them. */
const STATUS_TONES = new Map([
  ["var(--positive)", "bg-positive-surface text-positive"],
  ["var(--warning)", "bg-warning-surface text-warning-ink"],
  ["var(--destructive)", "bg-destructive-surface text-destructive"],
  ["var(--info)", "bg-info-surface text-info"],
  ["var(--neutral-status)", "bg-muted text-muted-foreground"],
]);

function optionTint(color: string) {
  return `color-mix(in srgb, ${color} 12%, var(--background))`;
}

type ValueProps = {
  /** Option color: a condition tone for status, a category tint otherwise. */
  color?: string;
  /** The option's compiled glyph (Phosphor name). */
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
 * Tones the declared `status` role marks as an exception. Only these keep a
 * filled pill in a table; every other value paints as a dot and text
 * (`table.css`). The decision reads the declared role and tone, never the
 * value's spelling.
 */
const EXCEPTION_TONES: ReadonlySet<string> = new Set([
  "var(--warning)",
  "var(--destructive)",
]);

/** Render supplied presentation; raw unrecognized values stay neutral and readable. */
export function EnumPill({
  optionRole = "category",
  value: _value,
  color = "var(--neutral-status)",
  glyph,
  icon,
  description,
  children,
  className,
}: ValueProps & { optionRole?: string | null; value?: string }) {
  const tone = optionRole === "status" ? STATUS_TONES.get(color) : undefined;
  const exception = optionRole === "status" && EXCEPTION_TONES.has(color);
  return withDescription(
    <Pill
      data-enum-role={optionRole ?? "category"}
      data-enum-tone={exception ? "exception" : "quiet"}
      className={cn(CHIP, tone ?? "text-foreground", className)}
      // SAFETY: CSSProperties has no index signature for the --enum-color custom property.
      style={
        {
          "--enum-color": color,
          ...(tone ? {} : { backgroundColor: optionTint(color) }),
        } as CSSProperties
      }
    >
      <span data-enum-lead="" className="contents">
        <Lead glyph={glyph} icon={icon} color={color} />
      </span>
      <span className="min-w-0 truncate">{children}</span>
    </Pill>,
    description,
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
      <CheckIcon aria-hidden className="size-3.5" />
      <span className="sr-only">{trueLabel}</span>
    </span>
  ) : (
    <span className="inline-flex items-center text-muted-foreground">
      <MinusIcon aria-hidden weight="regular" className="size-3.5" />
      <span className="sr-only">{falseLabel}</span>
    </span>
  );
}
