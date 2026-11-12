import {
  LIST_BATCH_COMMAND_LIMIT,
  type ListBatch,
} from "@cubby/schemas/pagination";
import { useMemo } from "react";

import type { ActionVerbId } from "~/entity/actions/action-verbs";
import type { BulkActionResult } from "~/ui/data-table/bulk-actions.types";

/** Reads a batch's unfinished members: the `batch` scope under the active phase. */
export type BatchMemberReader<TRow> = (
  batch: ListBatch,
  signal: AbortSignal,
) => Promise<readonly TRow[]>;

/** One declared record command a batch row offers for all its members. */
export interface BatchCommand {
  id: string;
  verb: ActionVerbId;
  /** Hidden commands are not offered on a batch row. */
  hidden: boolean;
  run: (batch: ListBatch, signal: AbortSignal) => Promise<BatchCommandResult>;
}

/** How many members the command reached, of the active members read. */
export interface BatchCommandResult extends BulkActionResult {
  done: number;
  total: number;
}

/**
 * Runs one record command over a batch. A batch row carries the same commands
 * as its members: it reads the members still active (at most
 * `LIST_BATCH_COMMAND_LIMIT`; a larger batch is acted on from its opened
 * member list) and sends the existing per-record command to each in turn, so
 * every write takes the ordinary action path and its checks.
 */
async function runBatchCommand<TRow>({
  batch,
  readMembers,
  run,
  signal,
}: {
  batch: ListBatch;
  readMembers: BatchMemberReader<TRow>;
  run: (rows: readonly TRow[]) => Promise<BulkActionResult>;
  signal: AbortSignal;
}): Promise<BatchCommandResult> {
  const members = (await readMembers(batch, signal)).slice(
    0,
    LIST_BATCH_COMMAND_LIMIT,
  );
  let done = 0;
  for (const member of members) {
    if (signal.aborted) break;
    if ((await run([member])).success) done += 1;
  }
  return { success: done > 0, done, total: members.length };
}

/** A list's selection commands as batch commands over its batch members. */
export function useBatchCommands<TRow>(
  commands: readonly {
    id: string;
    verb: ActionVerbId;
    availability: (rows: readonly TRow[]) => { status: string };
    run: (rows: readonly TRow[]) => Promise<BulkActionResult>;
  }[],
  readMembers: BatchMemberReader<TRow> | undefined,
): readonly BatchCommand[] | undefined {
  return useMemo(
    () =>
      readMembers
        ? commands.map((command) => ({
            id: command.id,
            verb: command.verb,
            hidden: command.availability([]).status === "hidden",
            run: (batch: ListBatch, signal: AbortSignal) =>
              runBatchCommand({
                batch,
                readMembers,
                run: command.run,
                signal,
              }),
          }))
        : undefined,
    [commands, readMembers],
  );
}
