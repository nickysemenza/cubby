import type { TaskFilters } from "@cubby/schemas/project";
import { countLabel } from "@cubby/shared/pluralize";
import { useQuery } from "@tanstack/react-query";
import { useState } from "react";

import { EntityRefLink } from "~/entity/components/entity-ref-link";
import { EmbeddedEntityList } from "~/entity/entity-list/generic-entity-list";
import type { ListSlotProps } from "~/entity/entity-list/list-slot-types";
import { ExpenseLedgerSummary } from "~/features/expense/list-columns";
import { task } from "~/integrations/tanstack-query/generated/domains/task.gen";
import { householdLocalDate } from "~/lib/household-date";
import { ErrorDisplay } from "~/ui/feedback/error-display";
import { SimpleLoading } from "~/ui/feedback/loading-skeletons";
import { Row, Section, Stack } from "~/ui/layout";
import { Disclosure } from "~/ui/layout/disclosure";
import { Input } from "~/ui/primitives/input";
import { RecordList, RecordRow } from "~/ui/records/record-list";
import { Description } from "~/ui/text/description";
import { DateDisplay } from "~/ui/values/date-display";

const taskColumnVisibility = {
  dataQuality: false,
  "related:task.blockedBy": false,
};

/** Spending's year never narrows the cross-year completion evidence. */
export function MaintenanceView({
  search,
  navigate,
  filters,
}: ListSlotProps & { filters: TaskFilters }) {
  const scope = {
    ...filters,
    maintenanceProjectSearch: filters.maintenanceProjectSearch ?? "maintenance",
  };
  const history = useQuery(task.maintenanceHistory.queryOptions(scope));
  // Declared slot-only search keys use the generated urlStringParam codec.
  const requestedYear =
    typeof search.maintenanceYear === "string"
      ? Number(search.maintenanceYear)
      : NaN;
  const year =
    Number.isInteger(requestedYear) &&
    requestedYear >= 1900 &&
    requestedYear <= 9999
      ? requestedYear
      : Number(householdLocalDate().slice(0, 4));
  const projectIds = history.data?.projectIds ?? [];
  const datedGroups =
    history.data?.groups.filter((group) => group.completedDates.length > 0) ??
    [];
  const undatedCount =
    history.data?.groups.reduce(
      (count, group) => count + group.undatedCompletions,
      0,
    ) ?? 0;
  const expenseFilters = {
    projectId: projectIds,
    dateFrom: `${year}-01-01`,
    dateTo: `${year}-12-31`,
  };
  return (
    <Stack gap="lg">
      <Description>
        Household upkeep, completion history, and project spending.
      </Description>
      <Section title="Planned work" headingAs="h2">
        <EmbeddedEntityList
          entity="task"
          pageSize={10}
          initialColumnVisibility={taskColumnVisibility}
          sort={[{ id: "dueDate", desc: false }]}
          filters={{
            ...scope,
            status: ["not_started", "in_progress", "later", "blocked"],
          }}
          columns={[
            "name",
            "status",
            "dueDate",
            "subjectProductId",
            "projectId",
          ]}
        />
      </Section>
      <Section
        title="Observed cadence"
        headingAs="h2"
        caption="Based on recorded work dates across all years. Similar task names stay separate."
      >
        {history.isPending ? (
          <SimpleLoading />
        ) : history.isError ? (
          <ErrorDisplay error={history.error} />
        ) : (
          <>
            {datedGroups.length > 0 ? (
              <RecordList
                aria-label="Recorded maintenance cadence"
                columns={[
                  { id: "last", label: "Last completed" },
                  { id: "interval", label: "Observed interval" },
                  { id: "history", label: "History" },
                ]}
              >
                {datedGroups.map((group) => (
                  <RecordRow
                    key={JSON.stringify([group.name, group.subjectProductId])}
                    primary={<span className="break-words">{group.name}</span>}
                    secondary={
                      group.subjectProductId ? (
                        <EntityRefLink
                          entity="product"
                          data={{
                            id: group.subjectProductId,
                            name:
                              group.subjectProductName ??
                              group.subjectProductId,
                          }}
                        />
                      ) : undefined
                    }
                    clip={false}
                    facts={[
                      {
                        id: "last",
                        label: "Last completed",
                        value: (
                          <DateDisplay start={group.completedDates.at(-1)!} />
                        ),
                      },
                      {
                        id: "interval",
                        label: "Observed interval",
                        value:
                          group.medianIntervalDays === null ? (
                            <span className="text-muted-foreground">
                              Insufficient history
                            </span>
                          ) : (
                            `About ${Math.round(group.medianIntervalDays)} days`
                          ),
                      },
                      {
                        id: "history",
                        label: "History",
                        value: (
                          <Disclosure
                            summary={countLabel(
                              group.completedDates.length,
                              "dated completion",
                            )}
                          >
                            <Stack gap="xs">
                              <span>
                                {group.medianIntervalDays === null
                                  ? "No interval yet"
                                  : `Median of ${countLabel(group.completedDates.length - 1, "interval")}`}
                              </span>
                              {group.completedDates.map((date) => (
                                <DateDisplay key={date} start={date} />
                              ))}
                              {group.undatedCompletions > 0 && (
                                <span>
                                  {countLabel(
                                    group.undatedCompletions,
                                    "undated completion",
                                  )}{" "}
                                  excluded
                                </span>
                              )}
                            </Stack>
                          </Disclosure>
                        ),
                      },
                    ]}
                  />
                ))}
              </RecordList>
            ) : (
              <Description>
                Insufficient history. Record a completion date to start building
                a work history; two dates are needed to observe an interval.
              </Description>
            )}
            {undatedCount > 0 && (
              <Description>
                {countLabel(undatedCount, "completed task")} without a work
                date. These remain in Completed work and are excluded from
                cadence.
              </Description>
            )}
          </>
        )}
      </Section>
      <Section
        title="Completed work"
        headingAs="h2"
        caption="All years. Open a task to record its Completed on date; deadlines stay separate."
      >
        <EmbeddedEntityList
          entity="task"
          pageSize={8}
          initialColumnVisibility={taskColumnVisibility}
          sort={[{ id: "completedOn", desc: true }]}
          filters={{ ...scope, status: ["done"] }}
          columns={["name", "completedOn", "subjectProductId", "projectId"]}
        />
      </Section>
      <Section
        title="Purchase spending"
        headingAs="h2"
        caption="Allocated project shares. Purchases record spending, not completed work."
        actions={
          <SpendingYearField
            key={year}
            year={year}
            onCommit={(value) => navigate({ maintenanceYear: String(value) })}
          />
        }
      >
        {projectIds.length > 0 && (
          <ExpenseLedgerSummary filters={expenseFilters} wrap />
        )}
        {projectIds.length > 0 && (
          <EmbeddedEntityList
            entity="expense"
            initialColumnVisibility={{ dataQuality: false }}
            pageSize={8}
            sort={[{ id: "date", desc: true }]}
            filters={expenseFilters}
            columns={[
              "name",
              "cost",
              "date",
              "purchaseId",
              "projectId",
              "productId",
            ]}
          />
        )}
      </Section>
      <Section
        title="Maintenance projects"
        headingAs="h2"
        count={projectIds.length}
        disclosure={{}}
      >
        {projectIds.length > 0 ? (
          <EmbeddedEntityList
            entity="project"
            pageSize={10}
            filters={{ ids: projectIds }}
          />
        ) : (
          <Description>No maintenance projects loaded.</Description>
        )}
      </Section>
    </Stack>
  );
}

function SpendingYearField({
  year,
  onCommit,
}: {
  year: number;
  onCommit: (year: number) => void;
}) {
  const [draft, setDraft] = useState(String(year));
  const commit = () => {
    const value = Number(draft);
    if (Number.isInteger(value) && value >= 1900 && value <= 9999)
      onCommit(value);
    else setDraft(String(year));
  };
  return (
    <Row gap="sm" align="center">
      <label htmlFor="maintenance-year">Spending year</label>
      <Input
        id="maintenance-year"
        type="number"
        min={1900}
        max={9999}
        value={draft}
        onChange={(event) => setDraft(event.target.value)}
        onBlur={commit}
        onKeyDown={(event) => {
          if (event.key === "Enter") event.currentTarget.blur();
        }}
        className="w-24"
      />
    </Row>
  );
}
