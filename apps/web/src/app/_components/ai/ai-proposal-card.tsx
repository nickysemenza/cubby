import type { AiCacheStatus, Confidence } from "@cubby/schemas/ai";
import { Sparkles } from "lucide-react";
import { type KeyboardEvent, type ReactNode, useEffect, useRef } from "react";

import { formatCompactRelative } from "~/app/_components/HoverableTimestamp";
import { Row, Stack } from "~/components/layout";
import { Button } from "~/components/ui/button";
import { Description } from "~/components/ui/description";
import { Kbd } from "~/components/ui/kbd";
import { cn } from "~/lib/utils";

/** Confidence → text color. One map (semantic text-warning-ink for medium, not a
 * raw text-yellow-600) shared by every AI-suggestion surface. */
export const confidenceColor = {
  high: "text-positive",
  medium: "text-warning-ink",
  low: "text-destructive",
} satisfies Record<Confidence, string>;

/**
 * Where an AI answer came from, in the recipe flow footer's voice.
 *
 * Every AI surface states this, because the model behind a feature is now a
 * routing decision that can change under the user: the same button answers
 * from a different model after a tier reassignment, and without the line the
 * only way to notice is that the prose reads differently. `cacheStatus` is
 * part of it for the same reason — a cache hit is an answer to an older
 * question, not a fresh one.
 *
 * Each part is optional because not every read path carries it yet (see the
 * note on {@link AiProposalCard}'s `provenance`); the ones that are known are
 * rendered and the rest are left out rather than filled with a guess.
 */
export function AiProvenance({
  model,
  analyzedAt,
  cacheStatus,
  className,
}: {
  model?: string | null;
  /** When the answer was produced. Omit when the read path does not carry it. */
  analyzedAt?: Date | null;
  cacheStatus?: AiCacheStatus | null;
  className?: string;
}) {
  const parts: string[] = [];
  if (model) parts.push(`Analyzed by ${model}`);
  if (analyzedAt) {
    const relative = formatCompactRelative(analyzedAt);
    parts.push(relative === "now" ? "just now" : `${relative} ago`);
  }
  if (cacheStatus) parts.push(`cache ${cacheStatus}`);
  if (parts.length === 0) return null;
  return (
    <p className={cn("font-mono text-2xs text-slate", className)}>
      {parts.join(" · ")}
    </p>
  );
}

/**
 * Two labeled blocks for a proposal that replaces existing prose, so the
 * change is legible before it is accepted rather than after. Deliberately not
 * a word-level diff: these are model-rewritten paragraphs where nearly every
 * word differs, and an intra-word diff of two paragraphs reads as noise.
 */
export function AiTextDiff({
  current,
  proposed,
}: {
  current: string | null;
  proposed: string;
}) {
  return (
    <Stack gap="xs">
      {current && (
        <Stack gap="tight">
          <span className="eyebrow text-muted-foreground">Current</span>
          <p className="text-sm text-muted-foreground">{current}</p>
        </Stack>
      )}
      <Stack gap="tight">
        <span className="eyebrow">{current ? "Proposed" : "New"}</span>
        <p className="text-sm">{proposed}</p>
      </Stack>
    </Stack>
  );
}

/**
 * The value a proposal would write, named. The reasoning explains a choice;
 * this states it — without it a card argues for "tool-consumables" without
 * ever printing the words, and the only way to learn what Accept does is to
 * press it.
 */
export function ProposedValue({
  label,
  value,
}: {
  label: string;
  value: ReactNode;
}) {
  return (
    <Row align="baseline" gap="sm" className="border-t border-border pt-2">
      <span className="eyebrow text-muted-foreground">{label}</span>
      <span className="text-sm font-medium">{value}</span>
    </Row>
  );
}

/**
 * One AI answer, presented as a proposal: what the model produced, how sure it
 * is, why, where it came from, and two ways out.
 *
 * Replaces `ConfidenceReasoningCard`, which showed confidence and reasoning and
 * nothing else — every surface then bolted its own Accept/Dismiss row, its own
 * "applied" toast and, in one case, hid the reasoning in a `title` tooltip that
 * a touch device can never open. The parts that were drifting are the ones this
 * owns now.
 *
 * - **Reasoning is always visible.** It is the only thing that makes a
 *   confidence label mean anything, and a tooltip is not a place to put it.
 * - **`provenance` is required, not optional.** A surface with nothing to say
 *   has to pass `<AiProvenance />` and discover it renders nothing — which is
 *   the point: the gap is in the read path, and the type makes it visible here
 *   rather than silently absent.
 * - **`↵` accepts and `Esc` dismisses**, matching the ingredient review
 *   queue's keys. Accept takes focus on mount, so `↵` is the browser's own
 *   button activation rather than a handler on a div nothing can focus.
 *
 * With neither `onAccept` nor `onDismiss` the card is pure evidence (the review
 * queue's USDA match, where the editor's own Apply is the acceptance).
 */
export function AiProposalCard({
  label = "AI suggestion",
  confidence,
  reasoning,
  provenance,
  diff,
  children,
  onAccept,
  onDismiss,
  acceptLabel = "Accept",
  dismissLabel = "Dismiss",
  pending,
}: {
  label?: string;
  confidence: Confidence;
  reasoning: string;
  /** `model · relative time · cache status`. Required — see the note above. */
  provenance: ReactNode;
  /** What changes if this is accepted, for a proposal that replaces a value. */
  diff?: ReactNode;
  /** The proposed value itself, when it is richer than the diff slot. */
  children?: ReactNode;
  onAccept?: () => void;
  onDismiss?: () => void;
  acceptLabel?: string;
  dismissLabel?: string;
  pending?: boolean;
}) {
  const acceptRef = useRef<HTMLButtonElement>(null);
  const dismissRef = useRef<HTMLButtonElement>(null);
  const interactive = onAccept != null || onDismiss != null;

  // Focus the primary action, not the card: a proposal appears in response to
  // a click whose button is disabled by the time it lands, so focus is left
  // nowhere useful. Landing on Accept is also what makes `↵` work natively —
  // an earlier version put a key handler on the card wrapper, which is an
  // affordance a keyboard user has no way to reach and a screen reader has no
  // way to name.
  useEffect(() => {
    (acceptRef.current ?? dismissRef.current)?.focus();
  }, []);

  // Escape lives on the buttons rather than the card for the same reason. A
  // picker or price input inside the proposal keeps its own Escape.
  const onKeyDown = (event: KeyboardEvent<HTMLButtonElement>) => {
    if (event.key !== "Escape" || !onDismiss) return;
    event.preventDefault();
    onDismiss();
  };

  return (
    <div className="border border-border bg-muted/30 p-2 text-sm">
      <Stack gap="xs">
        <Row align="center" gap="sm" wrap>
          <Sparkles className="size-3 text-muted-foreground" />
          <span className="font-medium">{label}:</span>
          <span className={confidenceColor[confidence]}>
            {confidence} confidence
          </span>
        </Row>

        {reasoning ? <Description>{reasoning}</Description> : null}

        {diff}
        {children}

        {provenance}

        {interactive && (
          <Row align="center" gap="sm" wrap>
            {onAccept && (
              <Button
                ref={acceptRef}
                type="button"
                size="sm"
                className="min-h-11 max-sm:min-h-12"
                disabled={pending}
                onClick={onAccept}
                onKeyDown={onKeyDown}
              >
                {acceptLabel}
              </Button>
            )}
            {onDismiss && (
              <Button
                ref={dismissRef}
                type="button"
                size="sm"
                variant="outline"
                className="min-h-11 max-sm:min-h-12"
                disabled={pending}
                onClick={onDismiss}
                onKeyDown={onKeyDown}
              >
                {dismissLabel}
              </Button>
            )}
            {/* Desktop only: the keys exist, but a phone has no way to press
                them and the legend would just be two dead glyphs. */}
            <Row
              align="center"
              gap="sm"
              className="ml-auto hidden text-2xs text-muted-foreground sm:flex"
            >
              {onAccept && (
                <span>
                  <Kbd>↵</Kbd> {acceptLabel}
                </span>
              )}
              {onDismiss && (
                <span>
                  <Kbd>esc</Kbd> {dismissLabel}
                </span>
              )}
            </Row>
          </Row>
        )}
      </Stack>
    </div>
  );
}
