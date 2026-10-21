import type { MerchantVendorInference } from "@cubby/schemas/financial-transaction";

import { EntityRefLink } from "~/entity/components/entity-ref-link";
import { Row, Stack } from "~/ui/layout";
import { Disclosure } from "~/ui/layout/disclosure";

const supportCopy = (count: number) =>
  `${count} previously settled ${count === 1 ? "transaction" : "transactions"}`;

export function PossibleVendor({
  inference,
  compact = false,
}: {
  inference: MerchantVendorInference | null;
  compact?: boolean;
}) {
  if (
    inference === null ||
    inference.status === "none" ||
    inference.status === "insufficient_history"
  )
    return null;

  if (compact) {
    // Dense list rows: one line; the detail page shows the full evidence.
    if (inference.status === "suggested") {
      const candidate = inference.candidates[0];
      return (
        <Row gap="sm" className="min-w-0">
          <EntityRefLink
            variant="chip"
            entity="vendor"
            id={candidate.vendorId}
            name={candidate.vendorName}
          />
          <span
            className="shrink-0 text-2xs text-muted-foreground"
            title={supportCopy(candidate.supportingTransactionCount)}
          >
            {candidate.supportingTransactionCount} settled
          </span>
        </Row>
      );
    }
    return (
      <span
        className="block truncate text-xs text-muted-foreground"
        title={inference.candidates.map((c) => c.vendorName).join(", ")}
      >
        {inference.candidates.length} possible vendors
      </span>
    );
  }

  if (inference.status === "suggested") {
    const candidate = inference.candidates[0];
    return (
      <Stack gap="tight" className="min-w-0">
        <EntityRefLink
          variant="chip"
          entity="vendor"
          id={candidate.vendorId}
          name={candidate.vendorName}
        />
        <span className="text-2xs text-muted-foreground">
          Based on {supportCopy(candidate.supportingTransactionCount)}.
        </span>
      </Stack>
    );
  }

  return (
    <Disclosure
      summary="Possible vendors"
      meta={inference.candidates.length}
      className="text-xs"
    >
      <Stack as="ul" gap="tight">
        {inference.candidates.map((candidate) => (
          <Row as="li" key={candidate.vendorId} justify="between" gap="sm">
            <EntityRefLink
              variant="chip"
              entity="vendor"
              id={candidate.vendorId}
              name={candidate.vendorName}
            />
            <span className="shrink-0 text-2xs text-muted-foreground">
              {supportCopy(candidate.supportingTransactionCount)}
            </span>
          </Row>
        ))}
      </Stack>
    </Disclosure>
  );
}
