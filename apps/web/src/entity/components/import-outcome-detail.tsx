import type {
  EmailImportOutcomeDetail,
  MailImportGapExecutor,
} from "@cubby/schemas/email-fields";
import { fieldValueOf } from "@cubby/schemas/field-envelope";
import { humanize } from "@cubby/shared";
import { useQueryClient } from "@tanstack/react-query";

import { fieldEnumOptions } from "~/entity/display/enum-field-display";
import type { DetailRecordOf } from "~/entity/entity-detail/detail-record";
import { renderOptionCell } from "~/entity/table/column-helpers";

import { EntityRefLink } from "./entity-ref-link";

const EXECUTOR_HINT = {
  automatic: "Cubby retries this by itself.",
  agent: "An agent researches this next.",
  human: "Only you can settle this.",
} as const satisfies Record<MailImportGapExecutor, string>;

/**
 * The Email's `importOutcomeDetail`; a record read without it falls back to
 * the bare `importOutcome` value.
 */
export function readImportOutcomeDetail(
  record: DetailRecordOf<"email">,
): EmailImportOutcomeDetail | null {
  const detail = fieldValueOf(record.fields.importOutcomeDetail);
  if (detail) return detail;
  const outcome = fieldValueOf(record.fields.importOutcome);
  return outcome
    ? {
        outcome,
        category: null,
        executor: null,
        reason: null,
        waitingOn: null,
        runId: null,
      }
    : null;
}

/**
 * The one display of a mail import outcome: the declared outcome pill, the
 * gap category and who settles it, the reason, what it waits on and the Run.
 */
export function ImportOutcomeDetail({
  detail,
}: {
  detail: EmailImportOutcomeDetail;
}) {
  const queryClient = useQueryClient();
  const { category, executor, reason, waitingOn, runId } = detail;
  const note = [
    category ? humanize(category) : null,
    executor ? EXECUTOR_HINT[executor] : null,
  ].filter((part) => part !== null);
  return (
    <div
      className="flex w-full min-w-0 flex-col items-start gap-1 text-sm"
      data-testid="import-outcome-detail"
    >
      {renderOptionCell(
        detail.outcome,
        fieldEnumOptions(queryClient, "email", "importOutcome"),
      )}
      {note.length > 0 ? (
        <p className="text-xs text-muted-foreground">{note.join(" · ")}</p>
      ) : null}
      {reason ? <p className="min-w-0 break-words">{reason}</p> : null}
      {waitingOn ? (
        <p className="flex min-w-0 flex-wrap items-center gap-1 text-xs text-muted-foreground">
          <span>Waiting on</span>
          {waitingOn.kind === "email" ? (
            <EntityRefLink entity="email" id={waitingOn.emailId} />
          ) : (
            <>
              <span>order</span>
              <span className="font-mono break-all text-foreground">
                {waitingOn.orderId}
              </span>
              {waitingOn.vendorId ? (
                <EntityRefLink entity="vendor" id={waitingOn.vendorId} />
              ) : null}
            </>
          )}
        </p>
      ) : null}
      {runId ? (
        <p className="flex flex-wrap items-center gap-1 text-xs text-muted-foreground">
          <span>Run</span>
          <EntityRefLink entity="run" id={runId} />
        </p>
      ) : null}
    </div>
  );
}
