import { type ProjectContributionOut } from "@cubby/schemas/household-contribution";
import { UsersIcon } from "@phosphor-icons/react/dist/csr/Users";
import { WalletIcon } from "@phosphor-icons/react/dist/csr/Wallet";
import type { Icon } from "@phosphor-icons/react/lib";
import { useQuery } from "@tanstack/react-query";
import { useId } from "react";

import { fieldEnumOptions } from "~/entity/enum-field-display";
import { ContributionGapsTable } from "~/features/finance/household-contribution-format";
import { householdContribution } from "~/integrations/tanstack-query/generated/catalog.gen";
import { formatCurrency } from "~/lib/utils";
import { renderOptionCell } from "~/ui/data-table/columnHelpers";
import { ErrorDisplay } from "~/ui/feedback/error-display";
import { Row, Stack } from "~/ui/layout";
import { Alert, AlertDescription, AlertTitle } from "~/ui/primitives/alert";
import { Badge } from "~/ui/primitives/badge";
import { Skeleton } from "~/ui/primitives/skeleton";
import { StatGrid, StatTile } from "~/ui/primitives/stat-tile";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "~/ui/primitives/table";

export function ProjectContributionReport({
  data,
}: {
  data: ProjectContributionOut;
}) {
  const id = useId();
  const beneficiariesHeadingId = `${id}-beneficiaries`;
  const fundersHeadingId = `${id}-funders`;
  const gapsHeadingId = `${id}-gaps`;
  return (
    <Stack gap="lg">
      <p className="m-0 text-xs/relaxed text-muted-foreground">
        Spend stays whole-group here. Initial funding is historical; later
        reimbursements remain in the household ledger rather than changing this
        project.
      </p>
      <StatGrid>
        <StatTile label="Whole-group cost">
          {formatCurrency(data.wholeGroupCost)}
        </StatTile>
        {/* The same three quantities project budget shows above, from the same
            helper — a single netted figure hides which is which. */}
        <StatTile label="Actual">{formatCurrency(data.actualSpend)}</StatTile>
        <StatTile label="Committed">
          {formatCurrency(data.committedSpend)}
        </StatTile>
        <StatTile label="Credits">
          {formatCurrency(data.creditsReceived)}
        </StatTile>
        <StatTile label="Household initial exposure">
          {formatCurrency(data.householdInitialExposure)}
        </StatTile>
        <StatTile label="Guest initial funding">
          {formatCurrency(data.guestInitialFunding)}
        </StatTile>
        <StatTile label="Unattributed consumption">
          {formatCurrency(data.unattributedConsumption)}
        </StatTile>
        <StatTile label="Unattributed funding">
          {formatCurrency(data.unattributedInitialFunding)}
        </StatTile>
      </StatGrid>

      <div className="grid gap-4 lg:grid-cols-2">
        <section aria-labelledby={beneficiariesHeadingId}>
          <h3
            id={beneficiariesHeadingId}
            className="mb-2 border-b border-foreground pb-1 eyebrow"
          >
            Beneficiaries
          </h3>
          {data.parties.length === 0 ? (
            <CompactEmpty
              icon={UsersIcon}
              title="No beneficiaries attributed"
              detail="Record who consumed the project’s spend to compare contributions fairly."
            />
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="w-40">Beneficiary</TableHead>
                  <TableHead className="w-28 text-right">Consumed</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {data.parties.map(({ party, consumed }) => (
                  <TableRow key={party.id}>
                    <TableCell>
                      <Row align="center" gap="xs">
                        <span>{party.name}</span>
                        {renderOptionCell(
                          party.kind,
                          fieldEnumOptions("ledgerParty", "kind"),
                        )}
                      </Row>
                    </TableCell>
                    <TableCell className="text-right font-mono tabular-nums">
                      {formatCurrency(consumed)}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </section>

        <section aria-labelledby={fundersHeadingId}>
          <h3
            id={fundersHeadingId}
            className="mb-2 border-b border-foreground pb-1 eyebrow"
          >
            Original funders
          </h3>
          {data.funders.length === 0 ? (
            <CompactEmpty
              icon={WalletIcon}
              title="No original funders attributed"
              detail="Initial funding can be recorded without implying a later reimbursement."
            />
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="w-40">Party</TableHead>
                  <TableHead className="w-32 text-right">
                    Initially funded
                  </TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {data.funders.map((funder) => (
                  <TableRow key={funder.party.id}>
                    <TableCell>
                      <Row align="center" gap="xs">
                        <span>{funder.party.name}</span>
                        {renderOptionCell(
                          funder.party.kind,
                          fieldEnumOptions("ledgerParty", "kind"),
                        )}
                      </Row>
                    </TableCell>
                    <TableCell className="text-right font-mono tabular-nums">
                      {formatCurrency(funder.initiallyFunded)}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </section>
      </div>

      {data.gaps.length > 0 && (
        <section aria-labelledby={gapsHeadingId}>
          <div className="mb-2 flex items-baseline justify-between gap-2 border-b border-foreground pb-1">
            <h3 id={gapsHeadingId} className="my-0 eyebrow">
              Attribution gaps
            </h3>
            {data.gapsTruncated && (
              <Badge variant="warning">First 200 shown</Badge>
            )}
          </div>
          <ContributionGapsTable gaps={data.gaps} />
        </section>
      )}
    </Stack>
  );
}

function CompactEmpty({
  icon: Icon,
  title,
  detail,
}: {
  icon: Icon;
  title: string;
  detail: string;
}) {
  return (
    <Alert>
      <Icon className="size-3.5 text-slate" />
      <AlertTitle>{title}</AlertTitle>
      <AlertDescription>{detail}</AlertDescription>
    </Alert>
  );
}

export function ProjectContributionSection({
  projectId,
}: {
  projectId: string;
}) {
  const query = useQuery(
    householdContribution.project.queryOptions({
      projectId,
      includeSubprojects: true,
    }),
  );

  if (query.isLoading) return <Skeleton className="h-72" />;
  if (query.isError)
    return (
      <ErrorDisplay
        error={query.error}
        title="the contribution report"
        onRetry={() => void query.refetch()}
      />
    );
  return query.data ? <ProjectContributionReport data={query.data} /> : null;
}
