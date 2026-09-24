import type {
  FieldSuggestion,
  FieldSuggestionOutcome,
} from "@cubby/schemas/ai";
import { SparkleIcon } from "@phosphor-icons/react/dist/csr/Sparkle";

import { Stack } from "~/components/layout";
import { Description } from "~/components/ui/description";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "~/components/ui/popover";

import { describeOutcome } from "./suggestion-outcome-mark";
import { actionableSuggestion } from "./suggestion-review";

export interface SuggestionStatusField {
  readonly label: string;
  readonly outcome: FieldSuggestionOutcome;
  readonly suggestion: FieldSuggestion | null;
  readonly currentValue: string | null;
  readonly currentLabel?: string | null;
}

/** Beyond this many fields the popover switches from a per-field list to
 * bucketed counts — a whole table page's worth of rows × suggest fields
 * would otherwise be an unreadable wall of rows. */
const MAX_LISTED_FIELDS = 8;

function pluralize(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? "" : "s"}`;
}

function headlineText({
  checking,
  unasked,
  count,
  evaluated,
  skipped,
  failures,
}: {
  checking: boolean;
  unasked: string | null;
  count: number;
  evaluated: number;
  skipped: number;
  failures: number;
}): string | null {
  if (checking) return "Checking suggestions…";
  if (unasked) return `Not checked — add a ${unasked} first`;
  // A check that failed outright still reports it. Returning null here also
  // unmounted the "Checking suggestions…" trigger a form dialog had given
  // initial focus to, and the dialog then pulled focus back to its shell,
  // off whatever control the person had moved to.
  if (evaluated === 0 && skipped === 0)
    return failures > 0 ? "Suggestions unavailable" : null;
  const suggestionsText =
    count === 0
      ? "No suggestions"
      : count === 1
        ? "1 suggestion"
        : `${count} suggestions`;
  return (
    suggestionsText +
    ` · ${pluralize(evaluated, "field")} checked` +
    (skipped > 0 ? ` · ${skipped} not checked` : "") +
    (failures > 0 ? " · Some suggestions unavailable" : "")
  );
}

/** "12 agree · 3 would change · 4 no fit · 2 not checked" — the popover's
 * fallback once the per-field list would be too long to read. */
function bucketSummary(fields: readonly SuggestionStatusField[]): string {
  let agree = 0;
  let change = 0;
  let noFit = 0;
  let notChecked = 0;
  for (const field of fields) {
    if (field.outcome.kind === "skipped") {
      notChecked += 1;
      continue;
    }
    if (field.outcome.answer === "none") {
      noFit += 1;
      continue;
    }
    if (
      field.suggestion?.value != null &&
      field.suggestion.value === field.currentValue
    ) {
      agree += 1;
    } else {
      change += 1;
    }
  }
  return [
    agree > 0 ? `${agree} agree` : null,
    change > 0 ? `${change} would change` : null,
    noFit > 0 ? `${noFit} no fit` : null,
    notChecked > 0 ? `${notChecked} not checked` : null,
  ]
    .filter((part): part is string => part != null)
    .join(" · ");
}

/**
 * The one status line every suggestion surface (list, detail, and form)
 * renders once its query settles — how many fields Jev checked, so a record
 * it agreed with in full no longer reads as untouched ("0 suggestions").
 * Hover/tap opens the per-field breakdown; beyond `MAX_LISTED_FIELDS` that
 * becomes bucketed counts instead of a wall of rows.
 */
export function SuggestionStatus({
  checking,
  failures,
  count,
  fields,
  unasked = null,
}: {
  checking: boolean;
  failures: number;
  count: number;
  fields: readonly SuggestionStatusField[];
  unasked?: string | null;
}) {
  const evaluated = fields.filter(
    (field) => field.outcome.kind === "evaluated",
  ).length;
  const skipped = fields.length - evaluated;
  const text = headlineText({
    checking,
    unasked,
    count,
    evaluated,
    skipped,
    failures,
  });
  if (text === null) return null;
  const showBreakdown = !checking && !unasked && fields.length > 0;
  return (
    // One line at every width: the settled headline is longer than
    // "Checking suggestions…", and wrapping it pushed the whole record down
    // mid-tap on a phone. The popover and accessible name keep the full text.
    <Description
      size="xs"
      as="output"
      className="flex min-w-0 items-center gap-1"
    >
      <Popover>
        <PopoverTrigger
          openOnHover
          closeDelay={150}
          aria-label={text}
          title={text}
          className="inline-flex min-w-0 items-center gap-1 rounded-sm outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          <SparkleIcon className="size-3 shrink-0" />
          <span className="truncate">{text}</span>
        </PopoverTrigger>
        {showBreakdown ? (
          <PopoverContent
            side="bottom"
            align="start"
            className="w-auto max-w-xs p-2 text-xs"
          >
            {fields.length <= MAX_LISTED_FIELDS ? (
              <Stack gap="xs">
                {fields.map((field) => (
                  <Description
                    key={`${field.label}:${field.outcome.kind}:${field.suggestion?.value ?? ""}:${field.currentValue ?? ""}`}
                    size="xs"
                    className="text-muted-foreground"
                  >
                    {field.label} —{" "}
                    {describeOutcome({
                      ...field,
                      actionable: actionableSuggestion(
                        field.suggestion,
                        field.currentValue,
                      ),
                    })}
                  </Description>
                ))}
              </Stack>
            ) : (
              <Description size="xs" className="text-muted-foreground">
                {bucketSummary(fields)}
              </Description>
            )}
          </PopoverContent>
        ) : null}
      </Popover>
    </Description>
  );
}
