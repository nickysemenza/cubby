import {
  workQueueRecordInput,
  type WorkQueueRow,
} from "@cubby/schemas/work-queue";
import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";

import { workQueue } from "~/integrations/tanstack-query/generated/domains/workQueue.gen";
import { ErrorDisplay } from "~/ui/feedback/error-display";
import { useHydrated } from "~/ui/hooks/use-hydrated";
import { Section } from "~/ui/layout";
import { Ledger, LedgerCell, LedgerRow } from "~/ui/records/ledger";

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

/** One Work queue row's failed checks (or reason), actions and owner. */
export function RecordWorkQueueRow({ row }: { row: WorkQueueRow }) {
  return (
    <div className="grid min-w-0 gap-1">
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

/**
 * The record's own Work queue rows, one line each: failed checks (or the
 * reason), the row's declared actions, and who owns it. Absent rows render
 * nothing, and a failed read shows its raw diagnostics.
 */
export function RecordWorkQueue({ id }: { id: string }) {
  const { rows, error } = useRecordWorkQueue(id);
  if (error) return <ErrorDisplay error={error} title="Work queue" />;
  if (rows.length === 0) return null;
  return (
    <Section
      title="Work queue"
      headingAs="h3"
      compact
      actions={<Link to="/work-queue">Open queue</Link>}
    >
      <Ledger>
        {rows.map((row) => (
          <LedgerRow key={row.key}>
            <LedgerCell
              as="div"
              slot="primary"
              className="flex flex-wrap items-center gap-1"
            >
              {row.gaps.length > 0
                ? row.gaps.map((gap) => <GapChip key={gap.check} gap={gap} />)
                : row.reason}
            </LedgerCell>
            <LedgerCell as="div" slot="secondary">
              <WorkActions
                actions={row.actions}
                target={{ scope: "item", row }}
              />
            </LedgerCell>
            <LedgerCell as="div" slot="trailing">
              <OwnerPill owners={row.owners} shared={row.shared} />
            </LedgerCell>
          </LedgerRow>
        ))}
      </Ledger>
    </Section>
  );
}
