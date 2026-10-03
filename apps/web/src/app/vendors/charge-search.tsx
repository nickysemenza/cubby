import {
  financialTransactionShortcode,
  vendorAccountShortcode,
} from "@cubby/schemas/identifiers";
import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { useState } from "react";

import type { DetailSlotComponent } from "~/entity/entity-detail/detail-slots";
import { vendor } from "~/integrations/tanstack-query/generated/catalog.gen";
import { getErrorMessage } from "~/lib/error-utils";
import { formatCurrency } from "~/lib/utils";
import { useActionMutation } from "~/ui/hooks/useActionMutation";
import { Row, Stack } from "~/ui/layout";
import { Badge } from "~/ui/primitives/badge";
import { Button } from "~/ui/primitives/button";
import { Checkbox } from "~/ui/primitives/checkbox";
import { StatusText } from "~/ui/primitives/status-text";
import { TechnicalError } from "~/ui/primitives/technical-error";

const outcomeLabel = {
  pending: "Searching",
  resolved: "Settled",
  deferred: "Needs review",
  not_found: "Order not found",
} as const;

/**
 * A member's statement charges still waiting for an order on this Vendor
 * account. Selecting some starts one browser run for exactly those charges;
 * the rest keep waiting for the normal background search.
 */
function ChargeSearch({ vendorAccountId }: { vendorAccountId: string }) {
  const [selection, setSelection] = useState<ReadonlySet<string>>(new Set());
  const accountId = vendorAccountShortcode.parse(vendorAccountId);
  const charges = useQuery(
    vendor.chargeHunts.queryOptions({ vendorAccountId: accountId }),
  );
  const start = useActionMutation({
    mutationFn: vendor.startChargeRun.mutationOptions,
    success: "Charge search started",
    onSuccess: () => setSelection(new Set()),
  });
  if (charges.isPending)
    return <StatusText>Loading statement charges…</StatusText>;
  if (charges.isError)
    return <StatusText tone="destructive">{charges.error.message}</StatusText>;
  const { items } = charges.data;
  if (items.length === 0)
    return (
      <StatusText>
        No statement charge is waiting for an order on this account.
      </StatusText>
    );
  return (
    <Stack gap="sm">
      <Row align="center" gap="sm" className="flex-wrap" aria-live="polite">
        <Button
          type="button"
          size="sm"
          disabled={selection.size === 0 || start.isPending}
          onClick={() =>
            start.mutate({
              vendorAccountId: accountId,
              transactionIds: [...selection].map((id) =>
                financialTransactionShortcode.parse(id),
              ),
            })
          }
        >
          {start.isPending
            ? "Starting search…"
            : `Search selected charges (${selection.size})`}
        </Button>
        {selection.size > 0 ? (
          <Button
            type="button"
            size="sm"
            variant="ghost"
            onClick={() => setSelection(new Set())}
          >
            Clear selection
          </Button>
        ) : null}
        {start.data ? (
          <Link
            to="/runs/$shortcode"
            params={{ shortcode: start.data.runId }}
            className="text-primary underline underline-offset-4"
          >
            View charge search
          </Link>
        ) : null}
      </Row>
      {start.error ? (
        <TechnicalError error={getErrorMessage(start.error)} />
      ) : null}
      <ul className="grid gap-2">
        {items.map((charge) => (
          <li
            key={charge.transactionId}
            className="rounded-lg border border-border bg-card p-3 text-sm"
          >
            <Row
              align="center"
              justify="between"
              gap="sm"
              className="flex-wrap"
            >
              <div className="flex items-center gap-2">
                <Checkbox
                  id={`charge-${charge.transactionId}`}
                  checked={selection.has(charge.transactionId)}
                  disabled={charge.reason !== null}
                  onCheckedChange={(checked) =>
                    setSelection((current) => {
                      const next = new Set(current);
                      if (checked === true) next.add(charge.transactionId);
                      else next.delete(charge.transactionId);
                      return next;
                    })
                  }
                />
                <label htmlFor={`charge-${charge.transactionId}`}>
                  {charge.merchant ?? "Unknown merchant"} ·{" "}
                  {charge.transactionDate ?? "Undated"}
                </label>
              </div>
              <span className="font-mono tabular-nums">
                {formatCurrency(charge.amount)}
              </span>
            </Row>
            {charge.reason ? (
              <p className="mt-1 text-muted-foreground">
                {charge.runId ? (
                  <>
                    {charge.outcome ? (
                      <Badge variant="outline" className="mr-2">
                        {outcomeLabel[charge.outcome]}
                      </Badge>
                    ) : null}
                    <Link
                      to="/runs/$shortcode"
                      params={{ shortcode: charge.runId }}
                      className="text-primary underline underline-offset-4"
                    >
                      {charge.runId}
                    </Link>
                  </>
                ) : (
                  charge.reason
                )}
              </p>
            ) : null}
          </li>
        ))}
      </ul>
    </Stack>
  );
}

export const VendorAccountChargeSearch: DetailSlotComponent<
  "vendorAccount"
> = ({ record }) => <ChargeSearch vendorAccountId={record.id} />;
