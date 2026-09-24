import type { AllProblems } from "@cubby/schemas/problems";
import { MagicWandIcon } from "@phosphor-icons/react/dist/csr/MagicWand";
import { useQuery, useQueryClient } from "@tanstack/react-query";
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
import {
  combineRippleTags,
  ripple,
  type InvalidationTagSet,
} from "~/integrations/tanstack-query/cache-tags";
import { invalidateOperationTags } from "~/integrations/tanstack-query/operation-cache";
import { getErrorMessage } from "~/lib/error-utils";
import { problems as problemOperations } from "~/lib/problems.functions";

import { type AutoFixTask, buildAutoFixPlan } from "./auto-fix-registry";

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
  const { data: counts } = useQuery({
    ...problemOperations.getMaintenanceCounts.queryOptions(),
  });

  return buildAutoFixPlan(problems, counts);
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
    const invalidations: InvalidationTagSet[] = [ripple.problems];

    for (const [index, task] of tasks.entries()) {
      try {
        const outcome = await task.run();
        if (outcome.summary) clauses.push(outcome.summary);
        if (task.invalidateTags) invalidations.push(task.invalidateTags);
      } catch (error) {
        failures.push(`${task.label}: ${getErrorMessage(error)}`);
      }
      setRunning({ done: index + 1, total: tasks.length });
    }

    void invalidateOperationTags(
      queryClient,
      combineRippleTags(...invalidations),
    );
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

    toast.success(`Fixed: ${clauses.join(" · ")}.`);
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
          <MagicWandIcon className="mr-2 size-3.5" />
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
      <Row gap="xs" className="border-t border-border/60 pt-2">
        <span className="text-muted-foreground">
          Not included: fetching UPC images, re-parsing recipe lines, pruning
          aliases, and anything that deletes or overwrites data — those keep
          their own buttons.
        </span>
      </Row>
    </Stack>
  );
}
