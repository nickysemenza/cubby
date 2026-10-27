import type { EntityFieldEnvelopeRead } from "@cubby/schemas/entity-field-envelopes";
import { fieldValueOf } from "@cubby/schemas/field-envelope";
import { countLabel } from "@cubby/shared/pluralize";

import { formatCurrency } from "~/lib/number-format";
import { NoneValue } from "~/ui/primitives/none-value";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "~/ui/primitives/tooltip";

/** Cost renders only its canonical snapshot; its shared explanation owns source details. */
export function ProductCostValue({
  envelope,
}: {
  envelope: EntityFieldEnvelopeRead<"product", "output">["fields"]["cost"];
}) {
  if (envelope.result.kind === "missing")
    return (
      <span className="text-muted-foreground">
        {envelope.work.kind === "failed" ? "Unavailable" : "Updating…"}
      </span>
    );
  const cost = fieldValueOf(envelope);
  if (!cost) return <NoneValue />;
  if (cost.kind === "item") return formatCurrency(cost.amount);
  const explanation = `${countLabel(cost.chargeCount, "charge")}. Latest dated charge: ${cost.latestCharge === null ? "not recorded" : formatCurrency(cost.latestCharge)}. Average of positive actual charges; not a monthly rate.`;
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <button
            type="button"
            aria-label={`${formatCurrency(cost.amount)} per charge. ${explanation}`}
          />
        }
      >
        {formatCurrency(cost.amount)} / charge
      </TooltipTrigger>
      <TooltipContent side="top">{explanation}</TooltipContent>
    </Tooltip>
  );
}
