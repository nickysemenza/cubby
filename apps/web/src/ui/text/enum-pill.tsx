import type { KernelStage } from "@cubby/schemas/kernel/stage";
import type { EnumIcon } from "@cubby/shared/enum-palette";
import { CheckIcon } from "@phosphor-icons/react/dist/csr/Check";
import { cn } from "cn";
import {
  useContext,
  type CSSProperties,
  type ReactElement,
  type ReactNode,
} from "react";

import { OptionGlyph } from "~/ui/media/option-glyph";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "~/ui/primitives/tooltip";
import { NoneValue } from "~/ui/text/none-value";
import { Pill } from "~/ui/text/pill";
import { DenseCellContext } from "~/ui/values/stacked-value";

/**
 * Shared chip geometry for both roles. `border-transparent` keeps the 1px
 * box so a suggestion's dashed boundary can paint without shifting the value.
 */
const CHIP = "overflow-hidden border-transparent whitespace-nowrap";

/** Only the declared stage calls attention to a state. */
const STAGE_TONES = {
  ended: "text-muted-foreground",
  stuck: "bg-destructive-surface text-destructive",
  working: "text-foreground",
  needs_you: "bg-warning-surface text-warning-ink",
  waiting: "text-muted-foreground",
  done: "text-foreground",
} satisfies Record<KernelStage, string>;

function optionTint(color: string) {
  return `color-mix(in srgb, ${color} 12%, var(--background))`;
}

type ValueProps = {
  stage?: KernelStage;
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
  optionRole = "category",
  stage,
  value: _value,
  color = "var(--neutral-status)",
  glyph,
  icon,
  description,
  children,
  className,
}: ValueProps & { optionRole?: string | null; value?: string }) {
  const tone =
    optionRole === "status" ? STAGE_TONES[stage ?? "waiting"] : undefined;
  const exception =
    optionRole === "status" && (stage === "stuck" || stage === "needs_you");
  return withDescription(
    <Pill
      data-enum-role={optionRole ?? "category"}
      data-enum-tone={exception ? "exception" : "quiet"}
      className={cn(CHIP, tone ?? "text-foreground", className)}
      // SAFETY: CSSProperties has no index signature for the --enum-color custom property.
      style={
        {
          "--enum-color": optionRole === "status" ? "currentColor" : color,
          ...(tone ? {} : { backgroundColor: optionTint(color) }),
        } as CSSProperties
      }
    >
      <span data-enum-lead="" className="contents">
        <Lead
          glyph={glyph}
          icon={icon}
          color={optionRole === "status" ? "currentColor" : color}
        />
      </span>
      <span className="min-w-0 truncate">{children}</span>
    </Pill>,
    description,
  );
}

/**
 * A stored boolean: a text-size check for yes; no is the shared empty mark
 * (blank in a table cell). No pill — two states need no chip. `null` stays
 * the caller's unknown mark.
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
  // A No in a table cell is blank; it is a value, so it never offers "Add…".
  const inCell = useContext(DenseCellContext) !== null;
  return value ? (
    <span className="inline-flex items-center gap-1 text-positive">
      <CheckIcon aria-hidden className="size-3" />
      <span className="sr-only">{trueLabel}</span>
    </span>
  ) : (
    <span className="inline-flex items-center">
      {!inCell && <NoneValue />}
      <span className="sr-only">{falseLabel}</span>
    </span>
  );
}
