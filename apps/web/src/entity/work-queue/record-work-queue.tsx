import {
  workQueueRecordInput,
  type WorkQueueRow,
} from "@cubby/schemas/work-queue";
import { useQuery } from "@tanstack/react-query";

import { workQueue } from "~/integrations/tanstack-query/generated/domains/workQueue.gen";
import { useHydrated } from "~/ui/hooks/use-hydrated";

import { WorkActions } from "./work-actions";
import { GapChip, OwnerPill } from "./work-queue-display";

const EMPTY_ROWS: WorkQueueRow[] = [];

/** The record's own Work queue rows; empty until hydrated and while loading. */
export function useRecordWorkQueue(id: string, enabled = true) {
  const hydrated = useHydrated();
  const input = workQueueRecordInput.safeParse({ id });
  const result = useQuery({
    ...workQueue.forRecord.queryOptions(input.data ?? { id }),
    enabled: enabled && hydrated && input.success,
  });
  return {
    rows: result.data?.items ?? EMPTY_ROWS,
    error: result.isError ? result.error : null,
  };
}

/**
 * One Work queue row's failed checks (or reason), actions and owner; `inline`
 * keeps them on one line for a chip.
 */
export function RecordWorkQueueRow({
  row,
  inline = false,
}: {
  row: WorkQueueRow;
  inline?: boolean;
}) {
  return (
    <div
      className={
        inline
          ? "flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1"
          : "grid min-w-0 gap-1"
      }
    >
      <div className="flex min-w-0 flex-wrap items-center gap-1">
        {row.gaps.length > 0
          ? row.gaps.map((gap) => <GapChip key={gap.check} gap={gap} />)
          : row.reason}
      </div>
      <div className="flex min-w-0 flex-wrap items-center gap-2">
        <WorkActions actions={row.actions} target={{ scope: "item", row }} />
        <OwnerPill owners={row.owners} shared={row.shared} />
      </div>
    </div>
  );
}
