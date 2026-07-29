import { type ProjectId, unsafeProjectId } from "@cubby/schemas/identifiers";
import type { ExpenseOut } from "@cubby/schemas/project";
import { useQuery } from "@tanstack/react-query";
import { Lightbulb } from "lucide-react";
import { useMemo } from "react";
import { Row } from "~/components/layout";
import { Button } from "~/components/ui/button";
import { useTRPC } from "~/integrations/trpc/react";
import { householdLocalDate } from "~/lib/household-date";
import {
  rankProjectSuggestions,
  type SuggestableProject,
  type TradeAffinityCell,
} from "./project-suggestions";

// Module-level stable defaults — an inline `= []` allocates a fresh reference
// every render and destabilises the memo below (guard rule: unstable-hook-default).
const NO_PROJECTS: SuggestableProject[] = [];
const NO_AFFINITY: TradeAffinityCell[] = [];

interface ProjectSuggestionChipsProps {
  expense: ExpenseOut;
  onAssign: (projectId: ProjectId) => Promise<void>;
  isPending: boolean;
}

/**
 * One-click project suggestions for an unassigned expense.
 *
 * Only rendered when the expense has no project and does have a date — with
 * no date there is no window to intersect, so there is nothing to suggest.
 * Ranking (and why it is three chips) lives in `project-suggestions.ts`.
 */
export function ProjectSuggestionChips({
  expense,
  onAssign,
  isPending,
}: ProjectSuggestionChipsProps) {
  const api = useTRPC();
  const unassigned = expense.projectId === null && expense.date !== null;

  const { data: projects = NO_PROJECTS } = useQuery({
    ...api.project.options.queryOptions(),
    enabled: unassigned,
  });
  const { data: affinity = NO_AFFINITY } = useQuery({
    ...api.expense.tradeAffinity.queryOptions(),
    enabled: unassigned,
  });

  const suggestions = useMemo(
    () =>
      unassigned
        ? rankProjectSuggestions(
            { date: expense.date, trade: expense.trade },
            projects,
            affinity,
            householdLocalDate(),
          )
        : [],
    [unassigned, expense.date, expense.trade, projects, affinity],
  );

  if (!unassigned || suggestions.length === 0) return null;

  return (
    <Row align="center" gap="sm" wrap className="border-t pt-2">
      <Row align="center" gap="xs" className="text-slate text-xs">
        <Lightbulb className="size-3" />
        ACTIVE THEN
      </Row>
      {suggestions.map((suggestion) => (
        <Button
          key={suggestion.id}
          size="sm"
          variant="outline"
          disabled={isPending}
          // The ranking module is deliberately dependency-free, so its ids are
          // plain strings — re-brand at this boundary.
          onClick={() => void onAssign(unsafeProjectId(suggestion.id))}
          // The affinity count is the whole basis for the ordering, so show it
          // rather than presenting the ranking as an oracle.
          title={`${suggestion.affinity} ${expense.trade} expense${suggestion.affinity === 1 ? "" : "s"} already on this project`}
        >
          {suggestion.name}
        </Button>
      ))}
    </Row>
  );
}
