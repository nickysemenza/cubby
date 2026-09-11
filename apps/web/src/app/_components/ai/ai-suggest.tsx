import type { Confidence } from "@cubby/schemas/ai";
import { type ReactNode, useEffect, useRef } from "react";

import { VerbButton } from "~/app/_components/actions/action-verb-ui";
import { Row, Stack } from "~/components/layout";
import { Description } from "~/components/ui/description";

import { AiProposalCard, AiProvenance } from "./ai-proposal-card";
import { useAiProposal } from "./use-ai-proposal";

/**
 * A field paired with a "Suggest" button. Owns the ai-availability gate,
 * request-basis snapshots, stale-response rejection, and explicit acceptance.
 * Domain adapters keep their typed field patches local.
 *
 * The button is the registry's `suggest` verb, so the icon, the label and the
 * phone treatment are the same on every field that offers one; `object` names
 * what this field suggests ("category", "type", "a location") and stays in the
 * accessible name after the text is hidden below `sm`.
 */
export function FieldWithAISuggest<
  TResult extends { confidence: Confidence; reasoning: string },
>({
  field,
  enabled,
  disabledReason,
  object,
  basisKey,
  currentValue,
  fieldDirty,
  runSuggest,
  onAccept,
  onDismiss,
  children,
}: {
  field: ReactNode;
  /** Inputs sufficient to suggest (caller-computed; e.g. name && manufacturer). */
  enabled: boolean;
  /** Why the button is unavailable, e.g. "Enter product name first". */
  disabledReason: string;
  /** What this field suggests: "category", "type", "a location". */
  object: string;
  /** Stable serialization of the values the model will inspect. */
  basisKey: string;
  /** The field value when a proposal was requested; manual changes invalidate it. */
  currentValue: unknown;
  /** Exposed so domain callers state their edit-state contract explicitly. */
  fieldDirty: boolean;
  runSuggest: () => Promise<TResult>;
  onAccept: (result: TResult) => void;
  onDismiss?: (result: TResult) => void;
  /**
   * The value being proposed, named. Without it the card explains a choice it
   * never states — the reasoning has to be read as a riddle for the answer.
   */
  children?: (result: TResult) => ReactNode;
}) {
  const { proposal, isLoading, request, accept, dismiss } =
    useAiProposal<TResult>({ basisKey, run: runSuggest });

  // `useAiProposal` only tracks `basisKey`; the field a suggestion would
  // write to is not part of it, so a manual edit to that field after a
  // proposal appears needs its own staleness check. `requestValueRef` is the
  // field's value when the *currently shown* proposal was requested — set at
  // click time, copied into `committedValueRef` only once that request's
  // response actually lands as a proposal (a stale/dropped response must not
  // stomp the value belonging to whatever proposal is still on screen).
  const requestValueRef = useRef(currentValue);
  const committedValueRef = useRef<unknown>(null);

  useEffect(() => {
    if (proposal) committedValueRef.current = requestValueRef.current;
  }, [proposal]);

  useEffect(() => {
    if (proposal && fieldDirty && committedValueRef.current !== currentValue) {
      dismiss();
    }
  }, [proposal, fieldDirty, currentValue, dismiss]);

  const handleSuggest = () => {
    if (!enabled) return;
    requestValueRef.current = currentValue;
    void request();
  };

  return (
    <Stack gap="sm">
      <Row align="end" gap="sm">
        <div className="flex-1">{field}</div>
        <VerbButton
          verb="suggest"
          object={object}
          phoneIconOnly
          pending={isLoading}
          disabledReason={enabled ? undefined : disabledReason}
          className="min-h-9 max-sm:min-h-11"
          onClick={handleSuggest}
        />
      </Row>

      {/* Visible, not only a `title`: the button's own tooltip cannot open on
          a touch device, which is where half this form is filled in. */}
      {!enabled && <Description size="xs">{disabledReason}</Description>}

      {proposal && (
        <AiProposalCard
          label={`Suggested ${object}`}
          confidence={proposal.result.confidence}
          reasoning={proposal.result.reasoning}
          // The suggest endpoints answer with the value alone: no model, no
          // analysis timestamp. Until `packages/schemas/src/ai.ts` carries
          // them, the honest provenance is when it was asked.
          provenance={<AiProvenance analyzedAt={proposal.at} />}
          onAccept={() => {
            const result = accept();
            if (result) onAccept(result);
          }}
          onDismiss={() => {
            onDismiss?.(proposal.result);
            dismiss();
          }}
        >
          {children?.(proposal.result)}
        </AiProposalCard>
      )}
    </Stack>
  );
}
