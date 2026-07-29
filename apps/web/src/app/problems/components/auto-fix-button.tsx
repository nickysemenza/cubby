import type { AllProblems } from "@cubby/schemas/problems";
import type { QueryKey } from "@tanstack/react-query";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { Wand2 } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import { Row, Stack } from "~/components/layout";
import { Button } from "~/components/ui/button";
import { Progress } from "~/components/ui/progress";
import { Spinner } from "~/components/ui/spinner";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "~/components/ui/tooltip";
import { useTRPC, useTRPCClient } from "~/integrations/trpc/react";
import { getErrorMessage } from "~/lib/error-utils";
import {
  invalidateTRPCQueries,
  problemsMutationInvalidateKeys,
} from "~/lib/query-keys";
import { AUTO_FIX_TASKS, type AutoFixTask } from "./auto-fix-registry";

/**
 * What a run would do right now.
 *
 * Two different figures, deliberately not merged:
 * - `items` — everything the run touches. This is the button's promise, so it
 *   must include work with no Problems section (abandoned uploads) and the
 *   true uncapped figure behind a sampled section (missing embeddings).
 * - `listedItems` — the subset of `problems.totalProblems` the run clears. Only
 *   this may be described as "N of them", since `items` can legitimately exceed
 *   the issue count above it.
 */
export function useAutoFixPlan(problems: AllProblems) {
  const api = useTRPC();
  const { data: counts } = useQuery(
    api.problems.getMaintenanceCounts.queryOptions(undefined, {
      staleTime: 30_000,
    }),
  );

  const counted = AUTO_FIX_TASKS.map((task) => ({
    task,
    count: task.count(problems, counts),
  }));
  const actionable = counted.filter((t) => (t.count ?? 0) > 0);
  const items = actionable.reduce((n, t) => n + (t.count ?? 0), 0);
  const listedItems = actionable.reduce(
    (n, t) => n + t.task.listedCount(problems, counts),
    0,
  );

  return {
    items,
    listedItems,
    // Tail steps ride along, but only when something else justified the run.
    tasks: actionable.length
      ? counted
          .filter((t) => (t.count ?? 0) > 0 || t.task.alwaysRun)
          .map((t) => t.task)
      : [],
  };
}

/**
 * The one-click "fix everything that needs no judgment" button.
 *
 * Runs its tasks SEQUENTIALLY, each in its own request. That isn't caution about
 * load — it's the shape the Problems page already had to adopt: a single
 * procedure fanning out over every remedy is what blew the 30s Worker CPU limit
 * and forced the detectors into four separate unbatched queries. One task per
 * invocation keeps each inside its own budget.
 *
 * A failing task doesn't abort the run; failures are collected and reported
 * alongside whatever succeeded, because a half-finished sweep the user can't see
 * is worse than a noisy one. Query invalidation happens once at the end rather
 * than per task, so the four detector queries re-run once instead of six times.
 */
export function AutoFixButton({ problems }: { problems: AllProblems }) {
  const client = useTRPCClient();
  const queryClient = useQueryClient();
  const { items, tasks } = useAutoFixPlan(problems);
  const [running, setRunning] = useState<{
    done: number;
    total: number;
  } | null>(null);

  const run = async () => {
    setRunning({ done: 0, total: tasks.length });
    const clauses: string[] = [];
    const failures: string[] = [];
    const batchIds: string[] = [];
    const invalidate = new Set<QueryKey>(problemsMutationInvalidateKeys);

    for (const [index, task] of tasks.entries()) {
      try {
        const outcome = await task.run(client);
        if (outcome.summary) clauses.push(outcome.summary);
        if (outcome.batchId) batchIds.push(outcome.batchId);
        for (const key of task.invalidateKeys ?? []) invalidate.add(key);
      } catch (error) {
        failures.push(`${task.label}: ${getErrorMessage(error)}`);
      }
      setRunning({ done: index + 1, total: tasks.length });
    }

    invalidateTRPCQueries(queryClient, [...invalidate]);
    setRunning(null);

    if (failures.length) {
      toast.error(
        `${failures.length} of ${tasks.length} fixes failed — ${failures.join("; ")}`,
      );
    }
    if (!clauses.length && !failures.length) {
      toast.info("Nothing needed fixing.");
      return;
    }
    if (!clauses.length) return;

    const summary = `Fixed: ${clauses.join(" · ")}.`;
    toast.success(
      batchIds.length ? (
        <span>
          {summary}{" "}
          <Link
            to="/background-jobs"
            search={{ batchIds }}
            className="underline decoration-border decoration-dotted underline-offset-2 hover:decoration-primary"
          >
            View progress
          </Link>
        </span>
      ) : (
        summary
      ),
    );
  };

  const trigger = (
    <Button
      size="sm"
      onClick={() => void run()}
      disabled={running != null || tasks.length === 0}
    >
      {running ? (
        <>
          <Spinner className="mr-2" />
          Fixing… ({running.done}/{running.total})
        </>
      ) : (
        <>
          <Wand2 className="mr-2 size-3.5" />
          Fix{" "}
          {tasks.length ? `${items} ${items === 1 ? "item" : "items"}` : "—"}
        </>
      )}
    </Button>
  );

  return (
    <Stack gap="xs" className="shrink-0">
      <Tooltip>
        <TooltipTrigger
          render={<span className="inline-flex" />}
          // A disabled button swallows pointer events, so the tooltip has to
          // hang off a wrapper to explain *why* it's disabled.
        >
          {trigger}
        </TooltipTrigger>
        <TooltipContent className="max-w-sm">
          <AutoFixTooltip tasks={tasks} />
        </TooltipContent>
      </Tooltip>
      {running && <Progress value={running.done} max={running.total} />}
    </Stack>
  );
}

function AutoFixTooltip({ tasks }: { tasks: AutoFixTask[] }) {
  return (
    <Stack gap="snug">
      {tasks.length ? (
        <>
          <span className="font-medium">Runs, in order:</span>
          <ul className="list-inside list-disc">
            {tasks.map((t) => (
              <li key={t.key}>{t.label}</li>
            ))}
          </ul>
        </>
      ) : (
        <span>Nothing to auto-fix right now.</span>
      )}
      <Row gap="xs" className="border-border/60 border-t pt-2">
        <span className="text-muted-foreground">
          Not included: fetching UPC images, re-parsing recipe lines, pruning
          aliases, and anything that deletes or overwrites data — those keep
          their own buttons.
        </span>
      </Row>
    </Stack>
  );
}
