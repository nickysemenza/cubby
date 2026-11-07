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
import { StaticTable } from "~/ui/data-table/static-table";
import { ErrorDisplay } from "~/ui/feedback/error-display";
import { SimpleLoading } from "~/ui/feedback/loading-skeletons";
import { Row, Section, Stack } from "~/ui/layout";
import { Input } from "~/ui/primitives/input";
import { Description } from "~/ui/text/description";
import { DateDisplay } from "~/ui/values/date-display";

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
  const year =
    typeof search.maintenanceYear === "number" &&
    Number.isInteger(search.maintenanceYear) &&
    search.maintenanceYear >= 1900 &&
    search.maintenanceYear <= 9999
      ? search.maintenanceYear
      : Number(householdLocalDate().slice(0, 4));
  const projectIds = history.data?.projectIds ?? [];
  const expenseFilters = {
    projectId: projectIds,
    dateFrom: `${year}-01-01`,
    dateTo: `${year}-12-31`,
  };
  return (
    <Stack gap="lg">
      <Description>
        Tasks and spending in projects whose names contain “maintenance”.
        Completion history spans all years. Purchases describe project spending,
        not proof a part was installed.
      </Description>
      <Section title="Planned work" headingAs="h2">
        <EmbeddedEntityList
          entity="task"
          pageSize={20}
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
        caption="Exact task names and the same optional Product only. Dates are recorded completions, not deadlines. Similar names remain separate."
      >
        {history.isPending ? (
          <SimpleLoading />
        ) : history.isError ? (
          <ErrorDisplay error={history.error} />
        ) : (
          <StaticTable
            rows={history.data.groups}
            emptyMessage="No completed maintenance work in this task scope."
            rowKey={(row) => JSON.stringify([row.name, row.subjectProductId])}
            columns={[
              {
                id: "work",
                header: "Work",
                cell: (row) => (
                  <Stack gap="xs">
                    <span>{row.name}</span>
                    {row.subjectProductId && (
                      <EntityRefLink
                        entity="product"
                        data={{
                          id: row.subjectProductId,
                          name: row.subjectProductName ?? row.subjectProductId,
                        }}
                      />
                    )}
                  </Stack>
                ),
              },
              {
                id: "last",
                header: "Last recorded completion",
                cell: (row) =>
                  row.completedDates.at(-1) ? (
                    <DateDisplay start={row.completedDates.at(-1)!} />
                  ) : (
                    "Not recorded"
                  ),
              },
              {
                id: "cadence",
                header: "Observed interval",
                cell: (row) =>
                  row.medianIntervalDays === null
                    ? "Insufficient history"
                    : `About ${Math.round(row.medianIntervalDays)} days (median)`,
              },
              {
                id: "evidence",
                header: "Evidence",
                cell: (row) => (
                  <Stack gap="xs">
                    <span>
                      {countLabel(
                        row.completedDates.length,
                        "dated completion",
                      )}{" "}
                      ·{" "}
                      {countLabel(
                        Math.max(0, row.completedDates.length - 1),
                        "interval",
                      )}
                    </span>
                    <span>
                      {row.completedDates.join(", ") || "No completion dates"}
                    </span>
                    {row.undatedCompletions > 0 && (
                      <span>
                        {countLabel(
                          row.undatedCompletions,
                          "undated completion",
                        )}{" "}
                        excluded
                      </span>
                    )}
                  </Stack>
                ),
              },
            ]}
          />
        )}
      </Section>
      <Section
        title="Completed work"
        headingAs="h2"
        caption="Record Completed on when the work date is known. Existing deadlines are preserved separately."
      >
        <EmbeddedEntityList
          entity="task"
          pageSize={20}
          filters={{ ...scope, status: ["done"] }}
          columns={["name", "completedOn", "subjectProductId", "projectId"]}
        />
      </Section>
      <Section title="Maintenance projects" headingAs="h2">
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
      <Section
        title="Purchase spending"
        headingAs="h2"
        caption="The summary counts only allocated project shares. Rows retain full expense amounts; open Project allocation to inspect shared tax or discounts."
      >
        <SpendingYearField
          key={year}
          year={year}
          onCommit={(value) => navigate({ maintenanceYear: value })}
        />
        {projectIds.length > 0 && (
          <ExpenseLedgerSummary filters={expenseFilters} />
        )}
        {projectIds.length > 0 && (
          <EmbeddedEntityList
            entity="expense"
            pageSize={20}
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
