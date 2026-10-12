import { formatConfidence, type Confidence } from "@cubby/schemas/ai";
import { entityFieldByKey } from "@cubby/schemas/entity-fields";
import type { ShortcodeEntity } from "@cubby/schemas/entity-manifest";
import { ArrowRightIcon } from "@phosphor-icons/react/dist/csr/ArrowRight";
import type { MouseEvent, ReactNode } from "react";

import { getAppErrorDetails } from "~/lib/error-utils";
import { formatCompactRelative } from "~/ui/HoverableTimestamp";
import { Row, Stack } from "~/ui/layout";
import { Button } from "~/ui/primitives/button";
import { Description } from "~/ui/primitives/description";

/** The manifest fields a field's decision reads: Jev and Clef return no
 * prose, so these, the runner-up and provenance are the suggestion's "why". */
export function suggestionBasisLabels(
  entity: ShortcodeEntity,
  field: string,
): string[] {
  const basis = entityFieldByKey(entity, field)?.control?.suggest?.basis ?? [];
  return basis.map((key) => entityFieldByKey(entity, key)?.label ?? key);
}

export interface SuggestionProvenance {
  model: string | null;
  /** The Run's public shortcode, when the suggestion was stored by one. */
  runId: string | null;
  at: Date | string | null;
}

export interface SuggestionBodyProps {
  /** What the field holds now; null for an addition. */
  current: ReactNode | null;
  proposed: ReactNode;
  probability: number | null;
  confidence?: Confidence;
  runnerUp?: { label: ReactNode; probability: number | null } | null;
  /** Prose a chat-tier or branch roll-up wrote; Jev and Clef write none. */
  reasoning?: string;
  basis: readonly string[];
  provenance: SuggestionProvenance;
  /** A prune proposal names its own removal; it never reads "Suggested". */
  removal?: boolean;
  /** Context the decision used beyond the basis (finance evidence). */
  evidence?: ReactNode;
  notice?: string;
  saving?: boolean;
  disabled?: boolean;
  failure?: unknown;
  onAccept: () => void;
  onReject: () => void;
  /** Writes another value to the record and records this suggestion as a Miss. */
  onUseDifferent?: () => void;
}

function stop(event: MouseEvent) {
  event.stopPropagation();
}

function ProvenanceCaption({ model, runId, at }: SuggestionProvenance) {
  const time = at ? new Date(at) : null;
  const relative = time ? formatCompactRelative(time) : null;
  return (
    <Description size="xs" className="text-muted-foreground">
      {[
        model ?? "Live check",
        relative ? (relative === "now" ? "just now" : `${relative} ago`) : null,
      ]
        .filter(Boolean)
        .join(" · ")}
      {runId ? (
        <>
          {" · "}
          <a
            href={`/runs/${runId}`}
            className="underline-offset-2 hover:underline"
          >
            {runId}
          </a>
        </>
      ) : null}
      {" · "}
      {/* Plain anchors: the body also renders in router-less form surfaces. */}
      <a href="/ai?tab=usage" className="underline-offset-2 hover:underline">
        AI usage
      </a>
    </Description>
  );
}

/**
 * One suggestion body for every field-suggestion surface: the proposal,
 * "92% · high", the runner-up, the basis the model read, provenance, and
 * Accept / Reject (with "Use a different value…"). Table cells and phone
 * rows open it from their compact mark; nothing rides in a `title`.
 */
export function SuggestionBody({
  current,
  proposed,
  probability,
  confidence,
  runnerUp,
  reasoning,
  basis,
  provenance,
  evidence,
  removal = false,
  notice,
  saving = false,
  disabled = false,
  failure = null,
  onAccept,
  onReject,
  onUseDifferent,
}: SuggestionBodyProps) {
  return (
    <Stack
      gap="xs"
      className="min-w-0 text-xs whitespace-normal"
      onClick={stop}
      onMouseDown={stop}
    >
      <Row gap="xs" wrap align="center">
        {current !== null ? (
          <>
            <span className="text-muted-foreground">{current}</span>
            <ArrowRightIcon
              className="size-3.5 shrink-0"
              aria-label="suggested replacement"
            />
          </>
        ) : null}
        <span className="font-medium text-primary">
          {current === null && !removal ? "Suggested: " : null}
          {proposed}
        </span>
        <span className="text-muted-foreground tabular-nums">
          {formatConfidence(probability, confidence)}
        </span>
      </Row>
      {runnerUp ? (
        <Description size="xs" className="text-muted-foreground">
          Runner-up: {runnerUp.label}
          {runnerUp.probability !== null
            ? ` · ${formatConfidence(runnerUp.probability)}`
            : ""}
        </Description>
      ) : null}
      {reasoning ? <Description size="xs">{reasoning}</Description> : null}
      {basis.length > 0 ? (
        <Description size="xs" className="text-muted-foreground">
          Based on {basis.join(", ")}
        </Description>
      ) : null}
      {evidence}
      <ProvenanceCaption {...provenance} />
      {notice ? <Description size="xs">{notice}</Description> : null}
      <Row gap="xs" wrap align="center">
        <Button
          type="button"
          size="xs"
          className="min-h-11 md:min-h-0"
          disabled={disabled || saving}
          onClick={onAccept}
        >
          {saving ? "Saving…" : "Accept"}
        </Button>
        <Button
          type="button"
          size="xs"
          variant="ghost"
          className="min-h-11 md:min-h-0"
          disabled={saving}
          onClick={onReject}
        >
          Reject
        </Button>
        {onUseDifferent ? (
          <Button
            type="button"
            size="xs"
            variant="link"
            className="min-h-11 md:min-h-0"
            disabled={saving}
            onClick={onUseDifferent}
          >
            Use a different value…
          </Button>
        ) : null}
      </Row>
      {onUseDifferent ? (
        <Description size="xs" className="text-muted-foreground">
          A different value is written to the record and this suggestion is
          recorded as a Miss.
        </Description>
      ) : null}
      {failure !== null ? (
        <Description size="xs" role="alert">
          Could not save: {getAppErrorDetails(failure).message}
        </Description>
      ) : null}
    </Stack>
  );
}
