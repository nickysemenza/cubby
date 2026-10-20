import type { suggestionRecordCountsOut } from "@cubby/schemas/automatic-decision";
import type { Entity } from "@cubby/schemas/entity";
import { entitySummary } from "@cubby/schemas/entity-summary";
import { parseShortcode } from "@cubby/shared";
import { countLabel } from "@cubby/shared/pluralize";
import { useQueries, type UseQueryResult } from "@tanstack/react-query";
import { chunk } from "es-toolkit";
import {
  createContext,
  useContext,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import { z } from "zod";

import { RecordProposals } from "~/entity/suggestions/queue/record-proposals";
import { suggestions } from "~/integrations/tanstack-query/generated/catalog.gen";
import { ErrorDisplay } from "~/ui/feedback/error-display";
import { Button } from "~/ui/primitives/button";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "~/ui/primitives/popover";

const identity = z.object({ id: z.string() });
const Context = createContext<{
  counts: ReadonlyMap<string, number>;
  error: unknown;
} | null>(null);
const combine = (
  queries: UseQueryResult<z.infer<typeof suggestionRecordCountsOut>>[],
) => ({
  records: queries.flatMap((query) => query.data?.records ?? []),
  error: queries.find((query) => query.error)?.error,
});

/** One bounded roster read per table batch, shared by every row. */
export function ProposalCountProvider({
  entity,
  records,
  children,
}: {
  entity: Entity | undefined;
  records: readonly unknown[];
  children: ReactNode;
}) {
  const batches = useMemo(
    () =>
      chunk(
        records.flatMap((record) => {
          const row = identity.safeParse(record);
          const code = row.success ? parseShortcode(row.data.id) : null;
          return code && code.type === entity ? [code.shortcode] : [];
        }),
        250,
      ),
    [records, entity],
  );
  const result = useQueries({
    queries: batches.map((recordIds) =>
      suggestions.recordCounts.queryOptions({ recordIds }),
    ),
    combine,
  });
  const context = useMemo(
    () => ({
      counts: new Map(result.records.map((row) => [row.id, row.pending])),
      error: result.error,
    }),
    [result.records, result.error],
  );
  return <Context value={context}>{children}</Context>;
}

export function ProposalCount({
  record,
  field,
  children,
}: {
  record: unknown;
  field?: string;
  children?: ReactNode;
}) {
  const context = useContext(Context);
  const [open, setOpen] = useState(false);
  const row = identity.safeParse(record);
  const code = row.success ? parseShortcode(row.data.id) : null;
  if (
    !code ||
    (field !== undefined && field !== entitySummary[code.type].titleField)
  )
    return children;
  const count = context?.counts.get(code.shortcode) ?? 0;
  return (
    <span className="inline-flex min-w-0 items-center gap-1">
      <span className="min-w-0">{children}</span>
      {context?.error ? (
        <ErrorDisplay error={context.error} title="pending suggestions" />
      ) : null}
      {count > 0 ? (
        <Popover open={open} onOpenChange={setOpen}>
          <PopoverTrigger
            render={
              <Button
                size="xs"
                variant="outline"
                className="relative z-[1] shrink-0 tabular-nums"
                aria-label={countLabel(count, "pending suggestion")}
                onClick={(event) => event.stopPropagation()}
              />
            }
          >
            {count}
          </PopoverTrigger>
          <PopoverContent
            className="max-h-[70vh] w-[min(56rem,calc(100vw-2rem))] overflow-y-auto"
            onClick={(event) => event.stopPropagation()}
          >
            {open ? <RecordProposals id={code.shortcode} /> : null}
          </PopoverContent>
        </Popover>
      ) : null}
    </span>
  );
}
