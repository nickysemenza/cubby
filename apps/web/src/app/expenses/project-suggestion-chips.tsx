import {
  type ProjectShortcode,
  unsafeProjectShortcode,
} from "@cubby/schemas/identifiers";
import type { ExpenseOut } from "@cubby/schemas/project";
import { useQuery } from "@tanstack/react-query";
import { Lightbulb } from "lucide-react";
import { useMemo, useState } from "react";
import { Row, Stack } from "~/components/layout";
import { Button } from "~/components/ui/button";
import { useTRPC } from "~/integrations/trpc/react";
import { householdLocalDate } from "~/lib/household-date";
import {
  type ProjectSuggestion,
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
  onAssign: (projectId: ProjectShortcode) => Promise<void>;
  isPending: boolean;
}

/**
 * Project suggestions for an unassigned expense. A ranked chip is only a
 * proposal: linking an expense changes its accounting context and requires an
 * explicit Accept after the user sees the chosen project.
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
  const [proposal, setProposal] = useState<{
    suggestion: ProjectSuggestion;
    basisKey: string;
  } | null>(null);
  const unassigned = expense.projectId === null && expense.date !== null;
  const basisKey = [
    expense.id,
    expense.projectId,
    expense.date,
    expense.trade,
  ].join("\u0000");

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
    <Stack gap="xs" className="border-t pt-2">
      <Row align="center" gap="sm" wrap>
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
            onClick={() => setProposal({ suggestion, basisKey })}
            title={`${suggestion.affinity} ${expense.trade} expense${suggestion.affinity === 1 ? "" : "s"} already on this project`}
          >
            {suggestion.name}
          </Button>
        ))}
      </Row>
      {proposal?.basisKey === basisKey && (
        <Row align="center" gap="xs" className="text-sm">
          <span className="text-muted-foreground">
            Assign to {proposal.suggestion.name}? {proposal.suggestion.affinity}{" "}
            similar expense
            {proposal.suggestion.affinity === 1 ? "" : "s"} already use this
            project.
          </span>
          <Button
            type="button"
            size="sm"
            disabled={isPending}
            onClick={() =>
              void onAssign(
                unsafeProjectShortcode(proposal.suggestion.id),
              ).then(
                () => setProposal(null),
                // The caller owns mutation error presentation. Keep the
                // proposal visible so it can be retried after a transient
                // failure instead of pretending it was accepted.
                () => undefined,
              )
            }
          >
            Accept
          </Button>
          <Button
            type="button"
            size="sm"
            variant="outline"
            disabled={isPending}
            onClick={() => setProposal(null)}
          >
            Dismiss
          </Button>
        </Row>
      )}
    </Stack>
  );
}
