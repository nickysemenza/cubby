import type { MerchantVendorInference } from "@cubby/schemas/financial-transaction";

import { Row, Stack } from "~/components/layout";
import { entities, entityDetailParams } from "~/entities/entities";

import { TableLink } from "../_components/table/TableLink";

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

  if (inference.status === "suggested") {
    const candidate = inference.candidates[0];
    return (
      <Stack gap="tight" className="min-w-0">
        <TableLink
          to={entities.vendor.routes.detail}
          params={entityDetailParams(candidate.vendorId)}
          className="block truncate"
        >
          {candidate.vendorName}
        </TableLink>
        <span className="text-2xs text-muted-foreground">
          {compact
            ? supportCopy(candidate.supportingTransactionCount)
            : `Based on ${supportCopy(candidate.supportingTransactionCount)}.`}
        </span>
      </Stack>
    );
  }

  return (
    <details className="group min-w-0 text-xs">
      <summary className="cursor-pointer text-muted-foreground marker:text-muted-foreground hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/35 focus-visible:outline-none">
        {inference.candidates.length} possible vendors
      </summary>
      <Stack as="ul" gap="tight" className="mt-2">
        {inference.candidates.map((candidate) => (
          <Row as="li" key={candidate.vendorId} justify="between" gap="sm">
            <TableLink
              to={entities.vendor.routes.detail}
              params={entityDetailParams(candidate.vendorId)}
              className="min-w-0 truncate"
            >
              {candidate.vendorName}
            </TableLink>
            <span className="shrink-0 text-2xs text-muted-foreground">
              {supportCopy(candidate.supportingTransactionCount)}
            </span>
          </Row>
        ))}
      </Stack>
    </details>
  );
}
