import type { ProjectContributionOut } from "@cubby/schemas/household-contribution";
import { useQuery } from "@tanstack/react-query";
import type { LucideIcon } from "lucide-react";
import { AlertTriangle, UsersRound, WalletCards } from "lucide-react";
import { useId } from "react";
import { Row, Stack } from "~/components/layout";
import { Alert, AlertDescription, AlertTitle } from "~/components/ui/alert";
import { Badge } from "~/components/ui/badge";
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

export function ProjectContributionReport({
  data,
}: {
  data: ProjectContributionOut;
}) {
  const id = useId();
  const beneficiariesHeadingId = `${id}-beneficiaries`;
  const fundersHeadingId = `${id}-funders`;
  return (
    <Stack gap="lg">
      <p className="m-0 text-muted-foreground text-xs/relaxed">
        Spend stays whole-group here. Initial funding is historical; later
        reimbursements remain in the household ledger rather than changing this
        project.
      </p>
      <StatGrid>
        <StatTile label="Whole-group cost">
          {formatCurrency(data.wholeGroupCost)}
        </StatTile>
        <StatTile label="Household initial exposure">
          {formatCurrency(data.householdInitialExposure)}
        </StatTile>
        <StatTile label="Guest initial funding">
          {formatCurrency(data.guestInitialFunding)}
        </StatTile>
        <StatTile label="Unattributed funding">
          {formatCurrency(data.unattributedInitialFunding)}
        </StatTile>
      </StatGrid>

      <div className="grid gap-4 lg:grid-cols-2">
        <section aria-labelledby={beneficiariesHeadingId}>
          <h3
            id={beneficiariesHeadingId}
            className="eyebrow mb-2 border-foreground border-b-[3px] pb-1"
          >
            Beneficiaries
          </h3>
          {data.people.length === 0 ? (
            <CompactEmpty
              icon={UsersRound}
              title="No beneficiaries attributed"
              detail="Record who consumed the project’s spend to compare contributions fairly."
            />
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="w-40">Person</TableHead>
                  <TableHead className="w-28 text-right">Consumed</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {data.people.map((person) => (
                  <TableRow key={person.personId}>
                    <TableCell>
                      <Row align="center" gap="xs">
                        <span>{person.name}</span>
                        <Badge
                          variant={
                            person.kind === "household" ? "slate" : "outline"
                          }
                        >
                          {person.kind}
                        </Badge>
                      </Row>
                    </TableCell>
                    <TableCell className="text-right font-mono tabular-nums">
                      {formatCurrency(person.consumed)}
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
            className="eyebrow mb-2 border-foreground border-b-[3px] pb-1"
          >
            Original funders
          </h3>
          {data.funders.length === 0 ? (
            <CompactEmpty
              icon={WalletCards}
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
                  <TableRow key={`${funder.party.kind}:${funder.party.key}`}>
                    <TableCell>
                      <Row align="center" gap="xs">
                        <span>{funder.party.name}</span>
                        <Badge
                          variant={funder.party.household ? "slate" : "outline"}
                        >
                          {funder.party.kind === "shared_fund"
                            ? "Shared fund"
                            : funder.party.household
                              ? "Household"
                              : "Guest"}
                        </Badge>
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
        <Alert>
          <AlertTriangle className="size-3.5 text-warning-ink" />
          <AlertTitle>Contribution attribution is incomplete</AlertTitle>
          <AlertDescription>{data.gaps.join(" · ")}</AlertDescription>
        </Alert>
      )}
    </Stack>
  );
}

function CompactEmpty({
  icon: Icon,
  title,
  detail,
}: {
  icon: LucideIcon;
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
  const api = useTRPC();
  const query = useQuery(
    api.householdContribution.project.queryOptions({
      projectId,
      includeSubprojects: true,
    }),
  );

  if (query.isLoading) return <Skeleton className="h-72" />;
  if (query.isError)
    return (
      <Alert variant="destructive">
        <AlertTriangle className="size-3.5" />
        <AlertTitle>Contribution report could not load</AlertTitle>
        <AlertDescription>
          Try again after the connection recovers.
        </AlertDescription>
      </Alert>
    );
  return query.data ? <ProjectContributionReport data={query.data} /> : null;
}
