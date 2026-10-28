import { formatConfidence, type Confidence } from "@cubby/schemas/ai";
import type { ShortcodeEntity } from "@cubby/schemas/entity-manifest";
import type { QueryClient } from "@tanstack/react-query";
import type { ReactNode } from "react";

import { entityMetadata } from "~/entity/metadata";
import { getAppErrorDetails } from "~/lib/error-utils";
import { DateDisplay } from "~/ui/common/date-display";
import { DecisionLevels } from "~/ui/derived/decision-levels";
import { Row, Stack } from "~/ui/layout";
import { Disclosure } from "~/ui/layout/disclosure";
import { Button } from "~/ui/primitives/button";
import { Description } from "~/ui/primitives/description";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "~/ui/primitives/popover";

/** The manifest fields a field's decision reads: Jev and Clef return no
 * prose, so these, the runner-up and provenance are the suggestion's "why". */
export function suggestionBasisLabels(
  queryClient: QueryClient,
  entity: ShortcodeEntity,
  field: string,
): string[] {
  const basis =
    entityMetadata(queryClient, entity).fields.fields.find(
      (candidate) => candidate.key === field,
    )?.control?.suggest?.basis ?? [];
  return basis.map(
    (key) =>
      entityMetadata(queryClient, entity).fields.fields.find(
        (candidate) => candidate.key === key,
      )?.label ?? key,
  );
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
  explain?: (pending: ReactNode) => ReactNode;
}

function stop(event: { stopPropagation: () => void }) {
  event.stopPropagation();
}

function ProvenanceCaption({ model, runId, at }: SuggestionProvenance) {
  return (
    <Description size="xs" className="text-muted-foreground">
      {model ?? "Live check"}
      {at ? (
        <>
          {" "}
          · <DateDisplay timestamp={at} />
        </>
      ) : null}
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
  explain,
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
          disabled={disabled || saving}
          onClick={onReject}
        >
          Reject
        </Button>
        {onUseDifferent ? (
          <Button
            type="button"
            size="xs"
            variant="link"
            disabled={disabled || saving}
            onClick={onUseDifferent}
          >
            Use a different value…
          </Button>
        ) : null}
      </Row>
      <Disclosure summary="Decision details">
        <Stack gap="xs">
          <ProvenanceCaption {...provenance} />
          {onUseDifferent ? (
            <Description size="xs">
              A different value is written to the record and this suggestion is
              recorded as a Miss.
            </Description>
          ) : null}
        </Stack>
      </Disclosure>
    </Stack>
  );
  const pendingLevel = (
    <div className="grid gap-2">
      <div className="text-foreground">{proposed}</div>
      <span>Confidence: {formatConfidence(probability, confidence)}</span>
      {accept}
      {evidenceBody}
    </div>
  );
  const chain = explain ? (
    explain(pendingLevel)
  ) : (
    <DecisionLevels deciding={current !== null ? "own" : undefined}>
      {(level) =>
        level === "own" ? current : level === "pending" ? pendingLevel : null
      }
    </DecisionLevels>
  );
  return (
    // oxlint-disable-next-line jsx-a11y/click-events-have-key-events jsx-a11y/no-static-element-interactions -- Review controls own keyboard behavior; this wrapper only blocks the record row click.
    <div
      className="suggestion-review min-w-0 text-xs whitespace-normal"
      data-suggestion-action={removal ? "remove" : "change"}
      onClick={stop}
      onMouseDown={stop}
    >
      {compact ? (
        <div className="suggestion-proposal flex min-w-0 flex-wrap items-center gap-2">
          {current !== null ? (
            <span className="suggestion-value">
              <span className="suggestion-value-label">Current</span>
              <span>{current}</span>
            </span>
          ) : null}
          <span className="suggestion-value">
            <span className="suggestion-value-label">
              {removal ? "Proposed removal" : "Proposed"}
            </span>
            <span className="suggestion-proposed-value">{proposed}</span>
          </span>
          <span className="suggestion-confidence">
            Confidence: {formatConfidence(probability, confidence)}
          </span>
          {compact ? accept : null}
        </div>
      ) : null}
      {compact ? (
        // Parts, not `Disclosure`: the trigger sits on the proposal line and the
        // evidence wraps to a full-width line beneath it (ledger.css).
        <Popover>
          <PopoverTrigger render={<Button variant="link" size="xs" />}>
            Review
          </PopoverTrigger>
          <PopoverContent className="max-h-[85dvh] w-[min(25rem,calc(100vw-1rem))] overflow-y-auto">
            <h3 className="mb-2 text-sm font-semibold">Why this value</h3>
            {chain}
          </PopoverContent>
        </Popover>
      ) : (
        <div className="pt-2">{chain}</div>
      )}
      {failure !== null ? (
        <Description size="xs" role="alert">
          Could not save: {getAppErrorDetails(failure).message}
        </Description>
      ) : null}
    </div>
  );
}
