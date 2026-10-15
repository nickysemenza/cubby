import type { LedgerPartyId } from "@cubby/schemas/identifiers";

import type { Database } from "~/server/db";
import {
  readRecordWorkQueueWith,
  readWorkQueueWith,
} from "~/server/generic/work-queue/repo/work-queue";

import { additionalWorkProblemSelections } from "./work-queue-problems";

/** The household work queue, including diagnostic-backed problem branches. */
export const readWorkQueue = (
  db: Database,
  currentPartyId: LedgerPartyId | null,
  input: Parameters<typeof readWorkQueueWith>[3],
  memberOnly: boolean,
) =>
  readWorkQueueWith(
    additionalWorkProblemSelections,
    db,
    currentPartyId,
    input,
    memberOnly,
  );

/** One record's rows of the same projection and routing. */
export const readRecordWorkQueue = (
  db: Database,
  currentPartyId: LedgerPartyId | null,
  id: string,
  memberOnly: boolean,
) =>
  readRecordWorkQueueWith(
    additionalWorkProblemSelections,
    db,
    currentPartyId,
    id,
    memberOnly,
  );
