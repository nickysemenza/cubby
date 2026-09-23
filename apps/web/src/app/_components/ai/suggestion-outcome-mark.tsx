import type {
  FieldSuggestion,
  FieldSuggestionAlternative,
  FieldSuggestionOutcome,
  FieldSuggestionRemoval,
} from "@cubby/schemas/ai";
import { ClassicV2 } from "loading-dev";
import { CircleAlert, Sparkle } from "lucide-react";
import type { MouseEvent, ReactNode } from "react";

import { Stack } from "~/components/layout";
import { Description } from "~/components/ui/description";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "~/components/ui/popover";
import { getErrorMessage } from "~/lib/error-utils";
import { cn } from "~/lib/utils";

import { formatProbability } from "./field-suggestion";
import {
  ALTERNATIVE_THRESHOLD,
  FILL_THRESHOLD,
  reviewThreshold,
} from "./suggestion-review";

export type SuggestionOutcomeSurface = "inline" | "cell" | "line";

/** A runner-up under this probability is noise ("tools · 0%"), not a
 * ranking — the same floor the picker's pinned "Suggested" group uses. */
const MIN_LISTED_ALTERNATIVE = 0.05;
/** Beyond the top three the popover stops being a glance. */
const MAX_LISTED_ALTERNATIVES = 3;

function stopPropagation(event: MouseEvent) {
  event.stopPropagation();
}

/** `FieldSuggestionHint`'s callers (form fields, `external-id-kind-suggestion.tsx`)
 * carry a bare `FieldSuggestion` with no `outcomes` envelope — an evaluated
 * pick is the only outcome shape a raw suggestion can stand in for. */
function outcomeFromSuggestion(
  suggestion: FieldSuggestion,
): FieldSuggestionOutcome {
  return {
    kind: "evaluated",
    answer: "pick",
    confidence: suggestion.confidence,
    probability: suggestion.probability,
    alternatives: suggestion.alternatives,
  };
}

interface HeadlineSegments {
  prefix: string;
  bold: string | null;
  suffix: string;
}

function percentOrConfidence(outcome: {
  probability: number | null;
  confidence: FieldSuggestion["confidence"];
}): string {
  return outcome.probability != null
    ? formatProbability(outcome.probability)
    : `confidence ${outcome.confidence}`;
}

export interface DescribeOutcomeArgs {
  outcome: FieldSuggestionOutcome | null;
  suggestion?: FieldSuggestion | null;
  currentValue?: string | null;
  currentLabel?: string | null;
  autoFilled?: boolean;
  alternative?: boolean;
  actionable?: boolean;
  prune?: boolean;
}

function skippedSegments(
  reason: Extract<FieldSuggestionOutcome, { kind: "skipped" }>["reason"],
): HeadlineSegments {
  const reasonText =
    reason === "no_signal"
      ? "nothing to go on yet"
      : reason === "no_candidates"
        ? "no candidates"
        : "inherited";
  return { prefix: `Not checked — ${reasonText}`, bold: null, suffix: "" };
}

/** `answer: "none"` — a fill target found no good fit, or a prune target
 * kept every entry (in which case `alternatives[0]` is the closest call). */
function declinedSegments(
  outcome: Extract<FieldSuggestionOutcome, { kind: "evaluated" }>,
  prune: boolean,
): HeadlineSegments {
  const percentText = percentOrConfidence(outcome);
  if (!prune) {
    return { prefix: `No good fit · ${percentText}`, bold: null, suffix: "" };
  }
  const closest = outcome.alternatives[0];
  if (!closest) return { prefix: "Nothing to remove", bold: null, suffix: "" };
  return {
    prefix: "Nothing to remove · closest ",
    bold: closest.label,
    suffix: ` ${formatProbability(closest.probability)} — needs ${Math.round(FILL_THRESHOLD * 100)}%`,
  };
}

/** `answer: "pick"` — a candidate was chosen, whether or not it clears the
 * actionable bar (see `reviewThreshold`) or merely restates the current value. */
function pickSegments(
  outcome: Extract<FieldSuggestionOutcome, { kind: "evaluated" }>,
  {
    suggestion,
    currentValue,
    currentLabel,
    autoFilled,
    alternative,
    actionable,
  }: Required<
    Pick<
      DescribeOutcomeArgs,
      | "suggestion"
      | "currentValue"
      | "currentLabel"
      | "autoFilled"
      | "alternative"
      | "actionable"
    >
  >,
): HeadlineSegments {
  const percentText = percentOrConfidence(outcome);
  const matchesCurrent =
    suggestion?.value != null &&
    currentValue != null &&
    suggestion.value === currentValue;
  if (matchesCurrent) {
    return autoFilled
      ? { prefix: `Filled in · ${percentText}`, bold: null, suffix: "" }
      : {
          prefix: "Agrees with ",
          bold: currentLabel ?? suggestion?.label ?? currentValue ?? "",
          suffix: ` · ${percentText}`,
        };
  }

  const label = suggestion?.label ?? suggestion?.value ?? "";
  if (actionable) {
    return { prefix: "Suggested ", bold: label, suffix: ` · ${percentText}` };
  }
  const threshold = suggestion
    ? reviewThreshold(suggestion, currentValue, alternative)
    : ALTERNATIVE_THRESHOLD;
  const neededPct = Math.round(threshold * 100);
  return threshold === FILL_THRESHOLD
    ? {
        prefix: "Leaning ",
        bold: label,
        suffix: ` · ${percentText} — needs ${neededPct}%`,
      }
    : {
        prefix: "Would pick ",
        bold: label,
        suffix: ` · ${percentText} — needs ${neededPct}% to change`,
      };
}

function headlineSegments({
  outcome,
  suggestion = null,
  currentValue = null,
  currentLabel = null,
  autoFilled = false,
  alternative = false,
  actionable = false,
  prune = false,
}: DescribeOutcomeArgs & {
  outcome: FieldSuggestionOutcome;
}): HeadlineSegments {
  if (outcome.kind === "skipped") return skippedSegments(outcome.reason);
  if (outcome.answer === "none") return declinedSegments(outcome, prune);
  return pickSegments(outcome, {
    suggestion,
    currentValue,
    currentLabel,
    autoFilled,
    alternative,
    actionable,
  });
}

function segmentsToText(segments: HeadlineSegments): string {
  return `${segments.prefix}${segments.bold ?? ""}${segments.suffix}`;
}

function segmentsToNode(segments: HeadlineSegments): ReactNode {
  return (
    <>
      {segments.prefix}
      {segments.bold ? (
        <span className="font-medium">{segments.bold}</span>
      ) : null}
      {segments.suffix}
    </>
  );
}

/** Plain-text headline for one outcome — the mark's own popover heading and
 * `SuggestionStatus`'s per-field listing rows share this so the wording
 * cannot drift between the two surfaces. */
export function describeOutcome(args: DescribeOutcomeArgs): string {
  if (!args.outcome) return "";
  return segmentsToText(headlineSegments({ ...args, outcome: args.outcome }));
}

/** The mark's popover body: the headline (skipped for `line`, already
 * visible beside the glyph there), up to 3 ranked alternatives, a `remove`
 * proposal's individual removals, then the caller's `review` slot. */
function OutcomePopoverBody({
  segments,
  surface,
  alternatives,
  removals,
  review,
}: {
  segments: HeadlineSegments;
  surface: SuggestionOutcomeSurface;
  alternatives: readonly FieldSuggestionAlternative[];
  removals: readonly FieldSuggestionRemoval[];
  review?: ReactNode;
}) {
  const listed = alternatives
    .filter((alternative) => alternative.probability >= MIN_LISTED_ALTERNATIVE)
    .slice(0, MAX_LISTED_ALTERNATIVES);
  return (
    <Stack gap="xs">
      {surface !== "line" ? <p>{segmentsToNode(segments)}</p> : null}
      {listed.length > 0 ? (
        <Stack gap="xs">
          {listed.map((alternative) => (
            <Description
              key={alternative.value}
              size="xs"
              className="text-muted-foreground"
            >
              {alternative.label} · {formatProbability(alternative.probability)}
            </Description>
          ))}
        </Stack>
      ) : null}
      {removals.length > 0 ? (
        <Stack gap="xs">
          {removals.map((removal) => (
            <Description
              key={removal.value}
              size="xs"
              className="text-muted-foreground"
            >
              {removal.value} · {removal.reason} ·{" "}
              {formatProbability(removal.probability)}
            </Description>
          ))}
        </Stack>
      ) : null}
      {review}
    </Stack>
  );
}

/** One footprint for every glyph state (checking, failed, outcome), so a
 * settling query swaps icons in space already taken: phone touch target on
 * `inline`/`line`, 12px elsewhere, and the shared 20px rail slot in a table
 * cell so it lines up with the cell's other affordances. */
function glyphTriggerClass(surface: SuggestionOutcomeSurface) {
  return cn(
    "inline-flex shrink-0 items-center justify-center rounded-sm outline-none focus-visible:ring-2 focus-visible:ring-ring",
    surface === "cell" ? "size-5" : "min-h-11 min-w-11 md:min-h-0 md:min-w-0",
  );
}

/** The glyph itself — sized down and untabbable in a non-actionable table
 * cell, full touch-target size on `inline`/`line` surfaces. */
function MarkGlyph({
  headlineText,
  surface,
  accented,
  actionable,
}: {
  headlineText: string;
  surface: SuggestionOutcomeSurface;
  /** Cobalt: there is a live proposal to act on from this glyph. */
  accented: boolean;
  actionable: boolean;
}) {
  return (
    <PopoverTrigger
      openOnHover
      closeDelay={150}
      aria-label={headlineText}
      tabIndex={surface === "cell" && !actionable ? -1 : undefined}
      onMouseDown={stopPropagation}
      onClick={stopPropagation}
      className={glyphTriggerClass(surface)}
    >
      <Sparkle
        className={cn(
          "size-3",
          accented
            ? "text-primary"
            : surface === "cell"
              ? "text-muted-foreground/50"
              : "text-muted-foreground",
        )}
      />
    </PopoverTrigger>
  );
}

/** The glyph before an outcome exists: rotating rays (the sparkle's own
 * silhouette) while the field's query is in flight, an alert carrying the raw
 * error once it fails. */
function UnsettledMark({
  pending,
  error,
  surface,
}: {
  pending?: boolean;
  error?: unknown;
  surface: SuggestionOutcomeSurface;
}) {
  // Record surfaces only: a form's `pending` is react-query's `isPending`,
  // which stays true forever for a query that was never enabled, so a form
  // glyph would spin indefinitely and its hover popover swallowed the next
  // click (the dialog's Create). Forms already have their own status line.
  if (surface === "line") return null;
  const failed = error !== undefined && error !== null;
  if (!failed && !pending) return null;
  const text = failed
    ? `Suggestion unavailable: ${getErrorMessage(error)}`
    : "Checking suggestion…";
  return (
    <Popover>
      <PopoverTrigger
        openOnHover
        closeDelay={150}
        aria-label={text}
        onMouseDown={stopPropagation}
        onClick={stopPropagation}
        className={glyphTriggerClass(surface)}
      >
        {failed ? (
          <CircleAlert className="size-3 text-destructive" />
        ) : (
          <ClassicV2 size={12} className="text-muted-foreground" />
        )}
      </PopoverTrigger>
      <PopoverContent side="bottom" className="w-auto max-w-xs p-2 text-xs">
        {text}
      </PopoverContent>
    </Popover>
  );
}

/**
 * The always-visible mark every evaluated (or skipped) suggest field carries:
 * a small glyph whose hover/tap popover states the outcome. In a dense table
 * cell (`surface="cell"`) the entire actionable review — headline, current
 * value, alternatives, apply/dismiss — lives inside the popover via `review`
 * so the row itself never grows past 32px; `inline`/`line` surfaces render
 * the review directly in the flow and pass no `review` (the popover there
 * only adds the ranked alternatives a proposal doesn't have room for inline).
 */
export function SuggestionOutcomeMark({
  outcome = null,
  suggestion = null,
  currentValue = null,
  currentLabel = null,
  alternative = false,
  autoFilled = false,
  surface = "inline",
  actionable = false,
  dismissed = false,
  prune = false,
  pending,
  error,
  review,
}: {
  outcome?: FieldSuggestionOutcome | null;
  suggestion?: FieldSuggestion | null;
  currentValue?: string | null;
  currentLabel?: string | null;
  alternative?: boolean;
  autoFilled?: boolean;
  surface?: SuggestionOutcomeSurface;
  /** The proposal cleared its review bar — a fact about the proposal, so the
   * copy still reads "Suggested X" after the person dismisses it. */
  actionable?: boolean;
  /** Dismissed this visit: the copy stays, the cobalt "act here" cue goes. */
  dismissed?: boolean;
  prune?: boolean;
  /** The outcome is still in flight. The glyph shows from the start rather
   * than on arrival: on a phone the 44px glyph wraps onto its own line, so
   * mounting it late pushed every later fact down mid-tap (a reset button
   * tapped as Jev settled received the tap on empty space). */
  pending?: boolean;
  /** The field's query failed; shown instead of silently omitting the mark. */
  error?: unknown;
  review?: ReactNode;
}) {
  const resolvedOutcome =
    outcome ?? (suggestion ? outcomeFromSuggestion(suggestion) : null);
  if (!resolvedOutcome)
    return <UnsettledMark pending={pending} error={error} surface={surface} />;

  const args: DescribeOutcomeArgs & { outcome: FieldSuggestionOutcome } = {
    outcome: resolvedOutcome,
    suggestion,
    currentValue,
    currentLabel,
    autoFilled,
    alternative,
    actionable,
    prune,
  };
  const segments = headlineSegments(args);
  const headlineText = segmentsToText(segments);
  const alternatives =
    resolvedOutcome.kind === "evaluated" ? resolvedOutcome.alternatives : [];
  const removals =
    suggestion?.operation === "remove" ? suggestion.removals : [];

  const glyph = (
    <MarkGlyph
      headlineText={headlineText}
      surface={surface}
      accented={actionable && !dismissed}
      actionable={actionable}
    />
  );
  return (
    <Popover>
      {surface === "line" ? (
        <span className="inline-flex items-center gap-1">
          {glyph}
          <Description size="xs" className="text-muted-foreground">
            {headlineText}
          </Description>
        </span>
      ) : (
        glyph
      )}
      <PopoverContent side="bottom" className="w-auto max-w-xs p-2 text-xs">
        <OutcomePopoverBody
          segments={segments}
          surface={surface}
          alternatives={alternatives}
          removals={removals}
          review={review}
        />
      </PopoverContent>
    </Popover>
  );
}
