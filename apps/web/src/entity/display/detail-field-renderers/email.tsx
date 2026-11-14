import { fieldValueOf } from "@cubby/schemas/field-envelope";

import { EntityRefLink } from "~/entity/components/entity-ref-link";
import { fieldEnumOptions } from "~/entity/display/enum-field-display";
import { renderOptionCell } from "~/entity/table/column-helpers";
import { NoneValue } from "~/ui/text/none-value";

import type { EntityDetailFieldRenderers } from "./index";

/** Import outcome, ownership and the evidence that can settle it. */
export const emailDetailFields = {
  "email-import-outcome": (email, queryClient) => {
    const detail = fieldValueOf(email.fields.importOutcomeDetail);
    const outcome = detail?.outcome ?? fieldValueOf(email.fields.importOutcome);
    if (!outcome) return { value: <NoneValue /> };
    return {
      value: (
        <div className="flex w-full min-w-0 flex-col items-start gap-1 text-sm">
          {renderOptionCell(
            outcome,
            fieldEnumOptions(queryClient, "email", "importOutcome"),
          )}
          {detail?.executor ? (
            <p>
              Who settles it:{" "}
              {detail.executor === "human"
                ? "You"
                : detail.executor === "agent"
                  ? "An agent"
                  : "Cubby"}
            </p>
          ) : null}
          {detail?.waitingOn ? (
            <p>
              Waiting on{" "}
              {detail.waitingOn.kind === "email" ? (
                <EntityRefLink entity="email" id={detail.waitingOn.emailId} />
              ) : (
                <>
                  {detail.waitingOn.orderId}
                  {detail.waitingOn.vendorId ? (
                    <>
                      {" "}
                      at{" "}
                      <EntityRefLink
                        entity="vendor"
                        id={detail.waitingOn.vendorId}
                      />
                    </>
                  ) : null}
                </>
              )}
            </p>
          ) : null}
          {detail?.runId ? (
            <EntityRefLink entity="run" id={detail.runId} />
          ) : null}
          {detail?.reason ? (
            <p className="min-w-0 break-words">{detail.reason}</p>
          ) : null}
        </div>
      ),
    };
  },
} satisfies EntityDetailFieldRenderers<"email">;
