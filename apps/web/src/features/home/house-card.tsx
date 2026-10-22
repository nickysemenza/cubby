import type { EntityReportOut } from "@cubby/schemas/entity-report";
import { useInfiniteQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";

import { EntityRefLink } from "~/entity/components/entity-ref-link";
import { entities, entityDetailParams } from "~/entity/entities";
import { cursorQueryOptions } from "~/integrations/tanstack-query/cursor-query-options";
import { entityReport } from "~/integrations/tanstack-query/generated/catalog/entityReport.gen";
import { DateDisplay } from "~/ui/common/date-display";
import { EmptyState } from "~/ui/feedback/empty-state";
import { ErrorDisplay } from "~/ui/feedback/error-display";
import { Section } from "~/ui/layout";

import { HomeList, HomeRow, HomeRowsLoading } from "./home-list";

/** Home's preloaded task briefing: the generic `task.briefing` collection report. */
const taskBriefingReportInput = {
  slot: "task.briefing",
  scope: { kind: "list", entity: "task", filters: {} },
} as const;

type ReportBlock = EntityReportOut["blocks"][number];
type ReportRecordRow = Extract<
  ReportBlock,
  { kind: "records" }
>["rows"][number];

/** The briefing's counts by label and its ranked next rows, read from the report blocks. */
export function useTaskBriefing() {
  const query = useInfiniteQuery(
    cursorQueryOptions(entityReport.get, taskBriefingReportInput),
  );
  const blocks: ReportBlock[] =
    query.data?.pages.flatMap((page) => page.blocks) ?? [];
  const counts = new Map<string, number>();
  for (const block of blocks) {
    if (block.kind !== "stats") continue;
    for (const figure of block.figures)
      if (figure.value !== null) counts.set(figure.label, figure.value);
  }
  const records = blocks.find((block) => block.kind === "records");
  return {
    query,
    count: (label: string) => counts.get(label) ?? 0,
    rows: records?.kind === "records" ? records.rows : undefined,
  };
}

/**
 * Today's briefing receives only this already-ranked prefix from the server;
 * it never invents a client-side score or has to fetch the actionable graph.
 */
function taskBriefingSecondary(briefing: {
  nextCount: number;
  laterCount: number;
  blockedCount: number;
  shown: number;
}): string | null {
  const hiddenNext = Math.max(briefing.nextCount - briefing.shown, 0);
  const parts = [
    hiddenNext > 0 ? `${hiddenNext} more ready` : null,
    briefing.laterCount > 0 ? `${briefing.laterCount} later` : null,
    briefing.blockedCount > 0 ? `${briefing.blockedCount} blocked` : null,
  ].filter(Boolean);
  return parts.length > 0 ? parts.join(" · ") : null;
}

export function TodayAttention() {
  const { query: briefing, count, rows } = useTaskBriefing();
  const secondary = rows
    ? taskBriefingSecondary({
        nextCount: count("Ready"),
        laterCount: count("Later"),
        blockedCount: count("Blocked"),
        shown: rows.length,
      })
    : null;
  return (
    <Section
      title="Today"
      headingAs="h2"
      ruled
      actions={
        <Link to="/tasks" search={{ view: "agenda" }}>
          All tasks
        </Link>
      }
    >
      {briefing.isError ? (
        <ErrorDisplay
          error={briefing.error}
          title="the next tasks"
          onRetry={() => void briefing.refetch()}
          className="mt-2"
        />
      ) : rows === undefined ? (
        <HomeRowsLoading label="Loading next tasks" />
      ) : rows.length === 0 ? (
        <EmptyState size="inline" className="mt-2">
          Nothing ready right now. Open work is blocked or set aside.
        </EmptyState>
      ) : (
        <HomeList label="Next tasks">
          {rows.map((item) => (
            <HomeRow
              key={item.id ?? item.title}
              trailing={
                item.trailing ? (
                  // Muted until the deadline passes; overdue paints its own tone.
                  <span className="text-xs text-muted-foreground">
                    <DateDisplay start={item.trailing} stacked={false} due />
                  </span>
                ) : null
              }
            >
              {item.id ? (
                <EntityRefLink
                  variant="table"
                  tone="identity"
                  to={entities.task.routes.detail}
                  params={entityDetailParams(item.id)}
                  title={item.title}
                  className="truncate"
                >
                  {item.title}
                </EntityRefLink>
              ) : (
                <span className="truncate">{item.title}</span>
              )}
              <BriefingProjectLine line={item.lines?.[0]} />
            </HomeRow>
          ))}
        </HomeList>
      )}
      {secondary ? (
        <p className="pt-2 text-xs text-muted-foreground">{secondary}</p>
      ) : null}
    </Section>
  );
}

function BriefingProjectLine({
  line,
}: {
  line: NonNullable<ReportRecordRow["lines"]>[number] | undefined;
}) {
  if (!line) return null;
  if (line.ref?.entity === "project")
    return (
      <EntityRefLink
        variant="table"
        tone="muted"
        to={entities.project.routes.detail}
        params={entityDetailParams(line.ref.id)}
        title={line.text}
        className="min-w-0 truncate text-muted-foreground"
      >
        {line.text}
      </EntityRefLink>
    );
  return (
    <span className="min-w-0 truncate text-muted-foreground">{line.text}</span>
  );
}
