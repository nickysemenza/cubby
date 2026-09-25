import type { HouseholdContributionLedgerOut } from "@cubby/schemas/household-contribution";
import { ArrowsLeftRightIcon } from "@phosphor-icons/react/dist/csr/ArrowsLeftRight";
import { CheckCircleIcon } from "@phosphor-icons/react/dist/csr/CheckCircle";
import { WarningIcon } from "@phosphor-icons/react/dist/csr/Warning";
import { XCircleIcon } from "@phosphor-icons/react/dist/csr/XCircle";
import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { useId, useMemo, useState } from "react";

import { renderOptionCell } from "~/app/_components/data-table/columnHelpers";
import { DatePickerInput } from "~/app/_components/date-picker-input";
import {
  ContributionGapTargets,
  contributionGapLabels,
  MoneyCell,
} from "~/app/_components/household-contribution-format";
import { ErrorDisplay } from "~/components/feedback/error-display";
import { Row, Stack } from "~/components/layout";
import { Alert, AlertDescription, AlertTitle } from "~/components/ui/alert";
import { Badge } from "~/components/ui/badge";
import { Button } from "~/components/ui/button";
import { Skeleton } from "~/components/ui/skeleton";
import { StatGrid, StatTile } from "~/components/ui/stat-tile";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "~/components/ui/table";
import { fieldEnumOptions } from "~/entities/enum-field-display";
import { countLabel } from "~/lib/pluralize";
import { formatCurrency } from "~/lib/utils";

import { householdContribution } from "./household-contribution.functions";

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
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead className="w-48">Check</TableHead>
          <TableHead className="w-64 text-right">Result</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {checks.map((check) => (
          <TableRow key={check.label}>
            <TableCell>
              <Row align="center" gap="xs">
                <CheckMark ok={check.ok} />
                <span>{check.label}</span>
              </Row>
            </TableCell>
            <TableCell className="text-right font-mono text-2xs tabular-nums">
              {check.value}
            </TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}

export function HouseholdContributionLedgerReport({
  data,
}: {
  data: HouseholdContributionLedgerOut;
}) {
  const id = useId();
  const partyHeadingId = `${id}-parties`;
  const checksHeadingId = `${id}-checks`;
  const gapsHeadingId = `${id}-gaps`;
  return (
    <Stack gap="lg">
      <StatGrid>
        <StatTile label="Whole-group cost">
          {formatCurrency(data.checks.expenseTotal)}
        </StatTile>
        <StatTile label="Attributed consumption">
          {formatCurrency(data.checks.consumedTotal)}
        </StatTile>
        <StatTile label="Initial outlays">
          {formatCurrency(data.checks.fundedTotal)}
        </StatTile>
        <StatTile label="Net position">
          {formatCurrency(data.checks.positionNet)}
        </StatTile>
      </StatGrid>

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
        <Table containerClassName="border border-border">
          <TableHeader>
            <TableRow>
              <TableHead className="w-40">Party</TableHead>
              <TableHead className="w-28 text-right">Consumed</TableHead>
              <TableHead className="w-32 text-right">Initial outlay</TableHead>
              <TableHead className="w-24 text-right">Sent</TableHead>
              <TableHead className="w-24 text-right">Received</TableHead>
              <TableHead className="w-32 text-right">Contribution</TableHead>
              <TableHead className="w-28 text-right">Position</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {data.parties.map((row) => (
              <TableRow key={row.party.id}>
                <TableCell>
                  <Stack gap="tight" className="min-w-0">
                    <span
                      className="truncate font-medium"
                      title={row.party.name}
                    >
                      {row.party.name}
                    </span>
                    {renderOptionCell(
                      row.party.kind,
                      fieldEnumOptions("ledgerParty", "kind"),
                    )}
                  </Stack>
                </TableCell>
                <MoneyCell value={row.consumed} />
                <MoneyCell value={row.initiallyOutlaid} />
                <MoneyCell value={row.transfersSent} />
                <MoneyCell value={row.transfersReceived} />
                <MoneyCell value={row.netContribution} strong />
                <MoneyCell value={row.position} strong />
              </TableRow>
            ))}
          </TableBody>
        </Table>
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
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="w-56">Issue</TableHead>
                <TableHead className="w-32 text-right">Amount</TableHead>
                <TableHead className="w-52">Records</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {data.gaps.map((gap) => (
                <TableRow key={`${gap.code}:${gap.targetIds.join(":")}`}>
                  <TableCell>
                    <Row align="center" gap="xs">
                      <WarningIcon className="size-3.5 shrink-0 text-warning-ink" />
                      {contributionGapLabels[gap.code]}
                    </Row>
                  </TableCell>
                  <MoneyCell value={gap.amount} empty="—" />
                  <TableCell className="font-mono text-2xs text-muted-foreground">
                    {/* Aggregated codes stand for many expenses and carry no
                        targets — a count is the honest thing to show. */}
                    {gap.count === undefined ? (
                      <ContributionGapTargets targetIds={gap.targetIds} />
                    ) : (
                      countLabel(gap.count, "expense")
                    )}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
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
