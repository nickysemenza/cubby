import { CheckIcon } from "@phosphor-icons/react/dist/csr/Check";
import { MinusIcon } from "@phosphor-icons/react/dist/csr/Minus";
import {
  type EnumIcon,
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
 * Shared chip geometry for both roles. `border-transparent` keeps the 1px
 * box so a suggestion's dashed boundary can paint without shifting the value.
 */
const CHIP = "overflow-hidden border-transparent whitespace-nowrap";

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

/** Render supplied presentation; raw unrecognized values stay neutral and readable. */
export function EnumPill({
  optionRole = "category", value: _value,
  color = "var(--brand-neutral-status)", glyph, icon, description, children, className,
}: ValueProps & {optionRole?: string | null; value?: string}) {
  return withDescription(
    <Pill data-enum-role={optionRole ?? "category"}
      className={cn(CHIP, "text-foreground", className)}
      style={{backgroundColor: optionTint(color)}}>
      <Lead glyph={glyph} icon={icon} color={color} />
      <span className="min-w-0 truncate">{children}</span>
    </Pill>, description,
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
