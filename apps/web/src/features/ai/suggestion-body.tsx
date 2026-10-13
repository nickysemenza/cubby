import { formatConfidence, type Confidence } from "@cubby/schemas/ai";
import { entityFieldByKey } from "@cubby/schemas/entity-fields";
import type { ShortcodeEntity } from "@cubby/schemas/entity-manifest";
import { ArrowRightIcon } from "@phosphor-icons/react/dist/csr/ArrowRight";
import type { ReactNode } from "react";

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
  /** Inline records keep evidence behind an explicit disclosure. */
  compact?: boolean;
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

function stop(event: { stopPropagation: () => void }) {
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
  compact = false,
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
  const accept = (
    <Button
      type="button"
      size="xs"
      className="min-h-11 md:min-h-0"
      disabled={disabled || saving}
      onClick={onAccept}
    >
      {saving ? "Saving…" : "Accept"}
    </Button>
  );
  const evidenceBody = (
    <Stack gap="xs" className="min-w-0 text-xs">
      <Description size="xs">
        Confidence: {formatConfidence(probability, confidence)}
      </Description>
      {runnerUp ? (
        <Description size="xs">
          Alternative: {runnerUp.label}
          {runnerUp.probability !== null
            ? ` · ${formatConfidence(runnerUp.probability)}`
            : ""}
        </Description>
      ) : null}
      {reasoning ? <Description size="xs">{reasoning}</Description> : null}
      {basis.length > 0 ? (
        <Description size="xs">Based on {basis.join(", ")}</Description>
      ) : null}
      {evidence}
      {notice ? <Description size="xs">{notice}</Description> : null}
      <Row gap="xs" wrap align="center">
        <Button
          type="button"
          size="xs"
          variant="ghost"
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
            disabled={saving}
            onClick={onUseDifferent}
          >
            Use a different value…
          </Button>
        ) : null}
      </Row>
      <details>
        <summary className="cursor-pointer text-xs text-muted-foreground">
          Decision details
        </summary>
        <Stack gap="xs" className="pt-2">
          <ProvenanceCaption {...provenance} />
          {onUseDifferent ? (
            <Description size="xs">
              A different value is written to the record and this suggestion is
              recorded as a Miss.
            </Description>
          ) : null}
        </Stack>
      </details>
    </Stack>
  );
  return (
    // oxlint-disable-next-line jsx-a11y/click-events-have-key-events jsx-a11y/no-static-element-interactions -- Review controls own keyboard behavior; this wrapper only blocks the record row click.
    <div
      className="suggestion-review min-w-0 text-xs whitespace-normal"
      onClick={stop}
      onMouseDown={stop}
    >
      <div className="suggestion-proposal flex min-w-0 flex-wrap items-center gap-2">
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
        {accept}
      </div>
      {compact ? (
        <details className="suggestion-disclosure">
          <summary className="flex min-h-11 min-w-11 cursor-pointer items-center text-xs text-muted-foreground underline-offset-2 hover:underline md:min-h-0 md:min-w-0">
            Review
          </summary>
          <div className="suggestion-evidence border-t border-border pt-2">
            {evidenceBody}
          </div>
        </details>
      ) : (
        <div className="pt-2">{evidenceBody}</div>
      )}
      {failure !== null ? (
        <Description size="xs" role="alert">
          Could not save: {getAppErrorDetails(failure).message}
        </Description>
      ) : null}
    </div>
  );
}
