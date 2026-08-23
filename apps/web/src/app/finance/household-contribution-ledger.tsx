import type { HouseholdContributionLedgerOut } from "@cubby/schemas/household-contribution";
import { useQuery } from "@tanstack/react-query";
import {
  AlertTriangle,
  ArrowRightLeft,
  CircleCheck,
  CircleX,
} from "lucide-react";
import { useId, useMemo, useState } from "react";
import { DatePickerInput } from "~/app/_components/date-picker-input";
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
import { useTRPC } from "~/integrations/trpc/react";
import { formatCurrency } from "~/lib/utils";

const gapLabels: Record<
  HouseholdContributionLedgerOut["gaps"][number]["code"],
  string
> = {
  missing_beneficiaries: "No beneficiaries recorded",
  missing_funders: "No original funder recorded",
  partial_beneficiaries: "Some beneficiary share is unattributed",
  partial_funders: "Some original funding is unattributed",
  shared_account_unmapped: "Shared account needs a funding source",
  unpriced_expense: "Expense has no price",
  transfer_evidence_one_sided: "Transfer has evidence from only one side",
  unattributed_transfer_party: "Transfer party is unavailable",
};

function CheckMark({ ok }: { ok: boolean }) {
  return ok ? (
    <CircleCheck className="size-3.5 text-positive" aria-hidden="true" />
  ) : (
    <CircleX className="size-3.5 text-warning-ink" aria-hidden="true" />
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
        <div className="mb-2 flex items-baseline justify-between gap-2 border-foreground border-b-[3px] pb-1">
          <h2 id={partyHeadingId} className="eyebrow my-0">
            Household contribution by party
          </h2>
          <span className="font-mono text-2xs text-muted-foreground">
            {data.parties.length} parties
          </span>
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
              <TableRow key={`${row.party.kind}:${row.party.key}`}>
                <TableCell>
                  <Stack gap="tight" className="min-w-0">
                    <span
                      className="truncate font-medium"
                      title={row.party.name}
                    >
                      {row.party.name}
                    </span>
                    <Badge variant={row.party.household ? "slate" : "outline"}>
                      {row.party.kind === "shared_fund"
                        ? "Shared fund"
                        : row.party.household
                          ? "Household"
                          : "Guest"}
                    </Badge>
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
        <div className="mb-2 border-foreground border-b-[3px] pb-1">
          <h2 id={checksHeadingId} className="eyebrow my-0">
            Accounting checks
          </h2>
        </div>
        <AccountingChecks data={data} />
      </section>

      <section aria-labelledby={gapsHeadingId}>
        <div className="mb-2 flex items-baseline justify-between gap-2 border-foreground border-b-[3px] pb-1">
          <h2 id={gapsHeadingId} className="eyebrow my-0">
            Reconciliation gaps
          </h2>
          {data.gapsTruncated && (
            <Badge variant="warning">First 200 shown</Badge>
          )}
        </div>
        {data.gaps.length === 0 ? (
          <Alert>
            <CircleCheck className="size-3.5 text-positive" />
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
                      <AlertTriangle className="size-3.5 shrink-0 text-warning-ink" />
                      {gapLabels[gap.code]}
                    </Row>
                  </TableCell>
                  <MoneyCell value={gap.amount} empty="—" />
                  <TableCell className="font-mono text-2xs text-muted-foreground">
                    {gap.targetIds.join(", ")}
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

function MoneyCell({
  value,
  strong = false,
  empty,
}: {
  value: number | undefined;
  strong?: boolean;
  empty?: string;
}) {
  return (
    <TableCell
      className={`text-right font-mono text-xs tabular-nums ${strong ? "font-semibold text-foreground" : ""}`}
    >
      {value === undefined ? empty : formatCurrency(value)}
    </TableCell>
  );
}

/** Query boundary for the household-wide report and its as-of control. */
export function HouseholdContributionLedger() {
  const api = useTRPC();
  const asOfId = useId();
  const [asOf, setAsOf] = useState<string | null>(null);
  const input = useMemo(() => (asOf ? { asOf } : {}), [asOf]);
  const ledgerQuery = useQuery(
    api.householdContribution.ledger.queryOptions(input),
  );
  const data = ledgerQuery.data;

  return (
    <Stack gap="lg">
      <Row align="end" wrap gap="sm" className="border-border border-b pb-2">
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
          <ArrowRightLeft className="size-3" />
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
        <Alert variant="destructive">
          <AlertTriangle className="size-3.5" />
          <AlertTitle>Contribution ledger could not load</AlertTitle>
          <AlertDescription>
            Try again after the connection recovers.
          </AlertDescription>
        </Alert>
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
