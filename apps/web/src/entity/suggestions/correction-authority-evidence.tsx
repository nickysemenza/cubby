import type { FieldSuggestionOutcome } from "@cubby/schemas/ai";
import type { ReactNode } from "react";

import { Stack } from "~/ui/layout";
import { Description } from "~/ui/primitives/description";

type Decision = Extract<
  FieldSuggestionOutcome,
  { kind: "correction" }
>["decision"];

/** Member authority is supported by applied receipts, never a model probability. */
export function CorrectionAuthorityEvidence({
  decision,
  renderValue,
}: {
  decision: Decision;
  renderValue?: (
    value: Extract<Decision, { status: "confirmed" }>["value"],
  ) => ReactNode;
}) {
  const sources =
    decision.status === "confirmed" ? [decision] : decision.sources;
  return (
    <Stack gap="sm">
      <Description size="xs">
        {decision.status === "confirmed"
          ? "Uses an applied member correction for the same complete decision inputs. Automatic application still checks current evidence and member edits."
          : "Applied member corrections disagree for the same complete decision inputs. Automatic application is held."}
      </Description>
      {sources.map((source) => (
        <Stack gap="xs" key={source.sourceFeedbackId}>
          <div>
            Corrected value:{" "}
            {source.value === null
              ? "None"
              : renderValue
                ? renderValue(source.value)
                : typeof source.value === "string"
                  ? source.value
                  : JSON.stringify(source.value)}
          </div>
          <Description size="xs">
            Member decision:{" "}
            <code className="break-all">{source.sourceFeedbackId}</code>
          </Description>
          <Description size="xs">
            Application receipt:{" "}
            <code className="break-all">
              {source.sourceApplicationFeedbackId}
            </code>
          </Description>
        </Stack>
      ))}
    </Stack>
  );
}
