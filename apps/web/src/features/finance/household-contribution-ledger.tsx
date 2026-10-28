import { type HouseholdContributionLedgerOut } from "@cubby/schemas/household-contribution";
import { countLabel } from "@cubby/shared/pluralize";
import { ArrowsLeftRightIcon } from "@phosphor-icons/react/dist/csr/ArrowsLeftRight";
import { CheckCircleIcon } from "@phosphor-icons/react/dist/csr/CheckCircle";
import { XCircleIcon } from "@phosphor-icons/react/dist/csr/XCircle";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { useId, useMemo, useState } from "react";

import { fieldEnumOptions } from "~/entity/display/enum-field-display";
import { useEntityMetadata } from "~/entity/metadata";
import { renderOptionCell } from "~/entity/table/column-helpers";
import { ContributionGapsTable } from "~/features/finance/household-contribution-format";
import { householdContribution } from "~/integrations/tanstack-query/generated/catalog/householdContribution.gen";
import { formatCurrency } from "~/lib/number-format";
import { KeyNumbers } from "~/ui/common/key-numbers";
import { DatePickerInput } from "~/ui/date-picker-input";
import { ErrorDisplay } from "~/ui/feedback/error-display";
import { Row, Stack } from "~/ui/layout";
import { Alert, AlertDescription, AlertTitle } from "~/ui/primitives/alert";
import { Badge } from "~/ui/primitives/badge";
import { Button } from "~/ui/primitives/button";
import { Skeleton } from "~/ui/primitives/skeleton";
import { StaticTable } from "~/ui/primitives/static-table";

function CheckMark({ ok }: { ok: boolean }) {
  return ok ? (
    <CheckCircleIcon className="size-3.5 text-positive" aria-hidden="true" />
  ) : (
    <XCircleIcon className="size-3.5 text-warning-ink" aria-hidden="true" />
  );
}

function AccountingChecks({ data }: { data: HouseholdContributionLedgerOut }) {
  const consumptionComplete =
    Math.round(
      (data.checks.consumedTotal + data.unattributed.consumption) * 100,
    ) === Math.round(data.checks.expenseTotal * 100);
  const fundingComplete =
    Math.round((data.checks.fundedTotal + data.unattributed.funding) * 100) ===
    Math.round(data.checks.expenseTotal * 100);
  const transfersNet = Math.round(data.checks.transferNet * 100) === 0;
  const positionMatches =
    Math.round(data.checks.positionNet * 100) ===
    Math.round((data.checks.fundedTotal - data.checks.consumedTotal) * 100);
  const checks = [
    {
      label: "Consumption allocation",
      ok: consumptionComplete,
      value: `${formatCurrency(data.checks.consumedTotal)} attributed · ${formatCurrency(data.unattributed.consumption)} unknown`,
    },
    {
      label: "Initial funding allocation",
      ok: fundingComplete,
      value: `${formatCurrency(data.checks.fundedTotal)} attributed · ${formatCurrency(data.unattributed.funding)} unknown`,
    },
    {
      label: "Transfer net",
      ok: transfersNet,
      value: formatCurrency(data.checks.transferNet),
    },
    {
      label: "Positions reconcile",
      ok: positionMatches,
      value: `${formatCurrency(data.checks.positionNet)} net position`,
    },
  ];

  return (
    <StaticTable
      rows={checks}
      rowKey={(check) => check.label}
      columns={[
        {
          id: "column-0",
          header: "Check",
          headClassName: "w-48",
          cell: (check) => (
            <Row align="center" gap="xs">
              <CheckMark ok={check.ok} />
              <span>{check.label}</span>
            </Row>
          ),
        },
        {
          id: "column-1",
          header: "Result",
          headClassName: "w-64 text-right",
          cellClassName: "text-right font-mono text-2xs tabular-nums",
          cell: (check) => check.value,
        },
      ]}
    />
  );
}

export function HouseholdContributionLedgerReport({
  data,
}: {
  data: HouseholdContributionLedgerOut;
}) {
  const queryClient = useQueryClient();
  useEntityMetadata("ledgerParty");
  const kindOptions = useMemo(
    () => fieldEnumOptions(queryClient, "ledgerParty", "kind"),
    [queryClient],
  );
  const id = useId();
  const partyHeadingId = `${id}-parties`;
  const checksHeadingId = `${id}-checks`;
  const gapsHeadingId = `${id}-gaps`;
  return (
    <Stack gap="lg">
      <KeyNumbers
        layout="strip"
        label="Contribution totals"
        items={[
          {
            label: "Whole-group cost",
            value: formatCurrency(data.checks.expenseTotal),
            money: true,
          },
          {
            label: "Attributed consumption",
            value: formatCurrency(data.checks.consumedTotal),
            money: true,
          },
          {
            label: "Initial outlays",
            value: formatCurrency(data.checks.fundedTotal),
            money: true,
          },
          {
            label: "Net position",
            value: formatCurrency(data.checks.positionNet),
            money: true,
          },
        ]}
      />

      <section aria-labelledby={partyHeadingId}>
        <div className="mb-2 flex items-baseline justify-between gap-2 border-b border-foreground pb-1">
          <h2 id={partyHeadingId} className="my-0 eyebrow">
            Household contribution by party
          </h2>
          <Row align="center" gap="sm">
            {/* This report is the numbers; the records behind them live on
                their own pages. */}
            <Link
              to="/ledger-parties"
              className="text-2xs text-primary hover:underline"
            >
              Parties
            </Link>
            <Link
              to="/ledger-transfers"
              className="text-2xs text-primary hover:underline"
            >
              Transfers
            </Link>
            <span className="font-mono text-2xs text-muted-foreground">
              {data.parties.length} parties
            </span>
          </Row>
        </div>
        <StaticTable
          containerClassName="border border-border"
          rows={data.parties}
          rowKey={(row) => row.party.id}
          columns={[
            {
              id: "column-0",
              header: "Party",
              headClassName: "w-40",
              cell: (row) => (
                <Stack gap="tight" className="min-w-0">
                  <span className="truncate font-medium" title={row.party.name}>
                    {row.party.name}
                  </span>
                  {renderOptionCell(row.party.kind, kindOptions)}
                  {row.internalMoves.count > 0 && (
                    <span className="text-2xs text-muted-foreground tabular-nums">
                      {countLabel(row.internalMoves.count, "internal move")} ·{" "}
                      {formatCurrency(row.internalMoves.amount)}
                    </span>
                  )}
                </Stack>
              ),
            },
            {
              id: "column-1",
              header: "Consumed",
              headClassName: "w-28 text-right",
              cellClassName: "text-right font-mono text-xs tabular-nums",
              cell: (row) =>
                row.consumed === undefined
                  ? null
                  : formatCurrency(row.consumed),
            },
            {
              id: "column-2",
              header: "Initial outlay",
              headClassName: "w-32 text-right",
              cellClassName: "text-right font-mono text-xs tabular-nums",
              cell: (row) =>
                row.initiallyOutlaid === undefined
                  ? null
                  : formatCurrency(row.initiallyOutlaid),
            },
            {
              id: "column-3",
              header: "Sent",
              headClassName: "w-24 text-right",
              cellClassName: "text-right font-mono text-xs tabular-nums",
              cell: (row) =>
                row.transfersSent === undefined
                  ? null
                  : formatCurrency(row.transfersSent),
            },
            {
              id: "column-4",
              header: "Received",
              headClassName: "w-24 text-right",
              cellClassName: "text-right font-mono text-xs tabular-nums",
              cell: (row) =>
                row.transfersReceived === undefined
                  ? null
                  : formatCurrency(row.transfersReceived),
            },
            {
              id: "column-5",
              header: "Contribution",
              headClassName: "w-32 text-right",
              cellClassName:
                "text-right font-mono text-xs tabular-nums font-semibold text-foreground",
              cell: (row) =>
                row.netContribution === undefined
                  ? null
                  : formatCurrency(row.netContribution),
            },
            {
              id: "column-6",
              header: "Position",
              headClassName: "w-28 text-right",
              cellClassName:
                "text-right font-mono text-xs tabular-nums font-semibold text-foreground",
              cell: (row) =>
                row.position === undefined
                  ? null
                  : formatCurrency(row.position),
            },
          ]}
        />
      </section>

      <section aria-labelledby={checksHeadingId}>
        <div className="mb-2 border-b border-foreground pb-1">
          <h2 id={checksHeadingId} className="my-0 eyebrow">
            Accounting checks
          </h2>
        </div>
        <AccountingChecks data={data} />
      </section>

      <section aria-labelledby={gapsHeadingId}>
        <div className="mb-2 flex items-baseline justify-between gap-2 border-b border-foreground pb-1">
          <h2 id={gapsHeadingId} className="my-0 eyebrow">
            Reconciliation gaps
          </h2>
          {data.gapsTruncated && (
            <Badge variant="warning">First 200 shown</Badge>
          )}
        </div>
        {data.gaps.length === 0 ? (
          <Alert>
            <CheckCircleIcon className="size-3.5 text-positive" />
            <AlertTitle>Nothing needs reconciliation</AlertTitle>
            <AlertDescription>
              Every recorded gap category is clear as of {data.asOf}.
            </AlertDescription>
          </Alert>
        ) : (
          <ContributionGapsTable gaps={data.gaps} />
        )}
      </section>
    </Stack>
  );
}

/** Query boundary for the household-wide report and its as-of control. */
export function HouseholdContributionLedger() {
  const asOfId = useId();
  const [asOf, setAsOf] = useState<string | null>(null);
  const input = useMemo(() => (asOf ? { asOf } : {}), [asOf]);
  const ledgerQuery = useQuery(
    householdContribution.ledger.queryOptions(input),
  );
  const data = ledgerQuery.data;

  return (
    <Stack gap="lg">
      <Row align="end" wrap gap="sm" className="border-b border-border pb-2">
        <label className="grid gap-1 text-xs" htmlFor={asOfId}>
          <span className="eyebrow">As of</span>
          <DatePickerInput
            id={asOfId}
            value={asOf ?? data?.asOf ?? null}
            onChange={setAsOf}
            clearable={false}
            placeholder="Today"
          />
        </label>
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={() => setAsOf(null)}
          disabled={asOf === null}
        >
          <ArrowsLeftRightIcon className="size-3" />
          Today
        </Button>
        {data && (
          <span className="pb-1 font-mono text-2xs text-muted-foreground">
            Reporting through {data.asOf}
          </span>
        )}
      </Row>

      {ledgerQuery.isLoading && <LedgerSkeleton />}
      {ledgerQuery.isError && (
        <ErrorDisplay
          error={ledgerQuery.error}
          title="the contribution ledger"
          onRetry={() => void ledgerQuery.refetch()}
        />
      )}
      {data && <HouseholdContributionLedgerReport data={data} />}
    </Stack>
  );
}

function LedgerSkeleton() {
  return (
    <Stack gap="lg" aria-label="Loading household contribution ledger">
      <div className="grid grid-cols-2 gap-2 md:grid-cols-4">
        {["cost", "consumption", "outlays", "position"].map((key) => (
          <Skeleton key={key} className="h-14" />
        ))}
      </div>
      <Skeleton className="h-64" />
      <Skeleton className="h-40" />
    </Stack>
  );
}
