import {
  workQueueRecordInput,
  type WorkQueueRow,
} from "@cubby/schemas/work-queue";
import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";

import { workQueue } from "~/integrations/tanstack-query/generated/catalog.gen";
import { Ledger, LedgerCell, LedgerRow } from "~/ui/common/ledger";
import { ErrorDisplay } from "~/ui/feedback/error-display";
import { useHydrated } from "~/ui/hooks/useHydrated";
import { SectionHeading } from "~/ui/layout";

import { GapChip, memberOptionsOf, WaitingForPill } from "./work-queue-display";

const EMPTY_ROWS: WorkQueueRow[] = [];

/**
 * The record's own Work queue rows, one line each: failed checks (or the
 * reason), the next action, and who it waits for. Absent rows render nothing;
 * a failed read shows its raw diagnostics.
 */
export function RecordWorkQueue({ id }: { id: string }) {
  const hydrated = useHydrated();
  const input = workQueueRecordInput.safeParse({ id });
  const result = useQuery({
    ...workQueue.forRecord.queryOptions(input.data ?? { id }),
    enabled: hydrated && input.success,
  });
  if (result.isError)
    return <ErrorDisplay error={result.error} title="Work queue" />;
  const rows = result.data?.items ?? EMPTY_ROWS;
  if (rows.length === 0) return null;
  const memberOptions = memberOptionsOf(result.data?.members ?? []);
  return (
    <section aria-label="Work queue" className="min-w-0">
      <SectionHeading
        title="Work queue"
        actions={
          <Link
            to="/work-queue"
            className="text-xs text-muted-foreground underline-offset-2 hover:underline"
          >
            Open queue
          </Link>
        }
      />
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
            <LedgerCell slot="secondary" className="text-muted-foreground">
              {row.nextAction}
            </LedgerCell>
            <LedgerCell as="div" slot="trailing">
              <WaitingForPill
                waitingFor={row.waitingFor}
                memberOptions={memberOptions}
              />
            </LedgerCell>
          </LedgerRow>
        ))}
      </Ledger>
    </section>
  );
}
