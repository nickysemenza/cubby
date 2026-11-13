import { fieldValueOf } from "@cubby/schemas/field-envelope";

import { fieldEnumOptions } from "~/entity/display/enum-field-display";
import { renderOptionCell } from "~/entity/table/column-helpers";
import { NoneValue } from "~/ui/text/none-value";

import type { EntityDetailFieldRenderers } from "./index";

/**
 * The import outcome is an ordinary filterable field: its declared option and
 * the server's reason. Who acts next and what the import waits on belong to
 * the record's machinery.
 */
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
          {detail?.reason ? (
            <p className="min-w-0 break-words">{detail.reason}</p>
          ) : null}
        </div>
      ),
    };
  },
} satisfies EntityDetailFieldRenderers<"email">;
