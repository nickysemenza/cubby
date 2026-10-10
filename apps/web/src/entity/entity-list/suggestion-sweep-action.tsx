import { entityFieldModels } from "@cubby/schemas/entity-fields";
import type { ShortcodeEntity } from "@cubby/schemas/entity-manifest";
import { useMutation, useQuery } from "@tanstack/react-query";
import { useQueryClient } from "@tanstack/react-query";
import { useEffect, useMemo, useRef } from "react";
import { z } from "zod";

import {
  entityRipple,
  exactRippleTags,
} from "~/integrations/tanstack-query/cache-tags";
import { ai } from "~/integrations/tanstack-query/generated/catalog.gen";
import { invalidateOperationTags } from "~/integrations/tanstack-query/operation-cache";
import { Button } from "~/ui/primitives/button";

export function SuggestionSweepAction({
  entity,
  filters,
  operations = ai,
}: {
  entity: ShortcodeEntity;
  filters: object;
  operations?: Pick<
    typeof ai,
    | "latestSuggestionSweepStatus"
    | "startSuggestionSweep"
    | "pauseSuggestionSweep"
    | "resumeSuggestionSweep"
  >;
}) {
  const fields = useMemo(
    () =>
      entityFieldModels[entity].fields.flatMap((field) =>
        field.control?.suggest ? [field.key] : [],
      ),
    [entity],
  );
  const queryClient = useQueryClient();
  const refresh = () =>
    Promise.all([
      invalidateOperationTags(
        queryClient,
        exactRippleTags(
          operations.latestSuggestionSweepStatus.queryOptions().meta
            ?.cacheTags ?? [],
        ),
      ),
      invalidateOperationTags(queryClient, entityRipple(entity)),
    ]);
  const start = useMutation({
    ...operations.startSuggestionSweep.mutationOptions(),
    onSuccess: refresh,
  });
  const pause = useMutation({
    ...operations.pauseSuggestionSweep.mutationOptions(),
    onSuccess: refresh,
  });
  const resume = useMutation({
    ...operations.resumeSuggestionSweep.mutationOptions(),
    onSuccess: refresh,
  });
  const status = useQuery({
    ...operations.latestSuggestionSweepStatus.queryOptions(),
    refetchInterval: (query) =>
      start.isPending || query.state.data?.status === "running" ? 1500 : false,
  });
  const current = status.data?.entity === entity ? status.data : null;
  const previousProgress = useRef<string | null>(null);
  useEffect(() => {
    const progressKey = current
      ? JSON.stringify([current.status, current.progress])
      : null;
    if (
      progressKey !== null &&
      previousProgress.current !== null &&
      progressKey !== previousProgress.current
    )
      void invalidateOperationTags(queryClient, entityRipple(entity));
    previousProgress.current = progressKey;
  }, [current, entity, queryClient]);
  const progressSchema = z
    .object({ done: z.number().optional(), total: z.number().optional() })
    .passthrough();
  const parsedProgress = progressSchema.safeParse(current?.progress);
  const progress = parsedProgress.success ? parsedProgress.data : null;
  if (fields.length === 0) return null;
  return (
    <div className="flex items-center gap-2" aria-label="Suggestion sweep">
      {start.isPending || current?.status === "running" ? (
        <>
          <output className="text-xs text-muted-foreground">
            Suggesting {progress?.done ?? 0}/{progress?.total ?? 0}
          </output>
          {current?.latestRunId && (
            <Button
              size="sm"
              variant="outline"
              onClick={() =>
                void (current.paused
                  ? resume.mutateAsync({ runId: current.latestRunId! })
                  : pause.mutateAsync({ runId: current.latestRunId! }))
              }
            >
              {current.paused ? "Resume" : "Pause"}
            </Button>
          )}
        </>
      ) : (
        <Button
          size="sm"
          variant="outline"
          disabled={start.isPending}
          onClick={() =>
            start.mutate({
              entity,
              fields,
              filters: z.record(z.string(), z.json()).parse(filters),
            })
          }
        >
          Suggest for these rows
        </Button>
      )}
    </div>
  );
}
