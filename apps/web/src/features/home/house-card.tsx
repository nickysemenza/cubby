import type { EntityReportOut } from "@cubby/schemas/entity-report";
import {
  useInfiniteQuery,
  useSuspenseInfiniteQuery,
} from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";

import { EntityRefLink } from "~/entity/components/entity-ref-link";
import {
  CommandButton,
  useReportCommands,
} from "~/entity/entity-detail/report-commands";
import { cursorQueryOptions } from "~/integrations/tanstack-query/cursor-query-options";
import { entityReport } from "~/integrations/tanstack-query/domains/entityReport";
import { DateDisplay } from "~/ui/common/date-display";
import { DenseCellContext } from "~/ui/common/stacked-value";
import { EmptyState } from "~/ui/feedback/empty-state";
import { ErrorDisplay } from "~/ui/feedback/error-display";
import { QuerySection } from "~/ui/feedback/query-section";
import { Section } from "~/ui/layout";

import { HomeList, HomeRowsLoading } from "./home-list";

/** Home's preloaded task briefing: the generic `task.briefing` collection report. */
export const taskBriefingReportInput = {
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
  return (
    <QuerySection
      title="the next tasks"
      fallback={
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
          <HomeRowsLoading label="Loading next tasks" />
        </Section>
      }
    >
      <TodayAttentionContent />
    </QuerySection>
  );
}

function TodayAttentionContent() {
  useSuspenseInfiniteQuery(
    cursorQueryOptions(entityReport.get, taskBriefingReportInput),
  );
  const { query: briefing, count, rows } = useTaskBriefing();
  const commands = useReportCommands();
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
            <li
              key={item.id ?? item.title}
              className="grid min-w-0 grid-cols-[minmax(0,1fr)_auto] items-start gap-x-3 gap-y-1 border-b border-border py-2 text-sm"
            >
              <div className="min-w-0 space-y-1">
                <DenseCellContext.Provider value={{ linksTo: null }}>
                  {item.id ? (
                    <EntityRefLink
                      entity="task"
                      id={item.id}
                      name={item.title}
                      className="max-w-full"
                    />
                  ) : (
                    <span className="block truncate">{item.title}</span>
                  )}
                  <div className="min-w-0 text-xs text-muted-foreground">
                    <BriefingProjectLine line={item.lines?.[0]} />
                  </div>
                </DenseCellContext.Provider>
              </div>
              <div className="flex items-start gap-2">
                {item.trailing ? (
                  <DateDisplay
                    start={item.trailing}
                    stacked
                    due
                    className="text-right text-xs text-muted-foreground"
                  />
                ) : null}
                {(item.commands ?? []).map((command) => (
                  <CommandButton
                    key={command.id}
                    command={command}
                    commands={commands}
                    quiet
                  />
                ))}
              </div>
            </li>
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
    return <EntityRefLink entity="project" id={line.ref.id} name={line.text} />;
  return (
    <span className="min-w-0 truncate text-muted-foreground">{line.text}</span>
  );
}
