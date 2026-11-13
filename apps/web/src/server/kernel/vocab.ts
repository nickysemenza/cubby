/**
 * Kernel vocabulary inlined as SQL constants from its schema tuples, so a
 * repeated expression keeps identical text and no literal drifts from the
 * shared values.
 */
import { askState } from "@cubby/schemas/kernel/machinery";
import { kernelStage } from "@cubby/schemas/kernel/stage";

import { sqlEnumConstant } from "~/server/db/sql-enum";

export const ASK = {
  queued: sqlEnumConstant(askState, "queued"),
  sent: sqlEnumConstant(askState, "sent"),
  answered: sqlEnumConstant(askState, "answered"),
  unknown: sqlEnumConstant(askState, "unknown"),
};

export const STAGE = {
  ended: sqlEnumConstant(kernelStage, "ended"),
  stuck: sqlEnumConstant(kernelStage, "stuck"),
  working: sqlEnumConstant(kernelStage, "working"),
  needsYou: sqlEnumConstant(kernelStage, "needs_you"),
  waiting: sqlEnumConstant(kernelStage, "waiting"),
  done: sqlEnumConstant(kernelStage, "done"),
};

/** The `AskScope` kind of a Run that waits on an ask with no scope. */
export const RUN_WAITER = "run";

/** The background drain unit that runs kernel work. */
export const KERNEL_UNIT = "kernel";
