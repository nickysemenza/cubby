import type { CalendarRangeInput } from "@cubby/schemas/calendar";
import type { UserId } from "@cubby/schemas/identifiers";

import type { CalDavCollection } from "~/server/calendar/caldav-types";
import { calendarFeedStateFor } from "~/server/calendar/client";
import type { Database } from "~/server/db";
import { getCalendarRange, getCalendarSchedule } from "~/server/repo/calendar";
import {
  bindWorkflow,
  defineWorkflowOperation,
  workflow,
} from "~/server/workflow-runtime";

type CalendarClient = Awaited<ReturnType<typeof calendarFeedStateFor>>;

/** Calendar application actions share client resolution; the DO retains
 * protocol state and owns each awaited write's commit boundary. */
function calendarOperation<Input, Output, Args extends readonly unknown[]>(
  name: string,
  kind: "read" | "write",
  run: (client: CalendarClient, input: Input) => Promise<Output>,
  prepare: (...args: Args) => { context: string; input: Input },
) {
  const graph = workflow<string, Input>(name).call(
    "client",
    async ({ context }) => calendarFeedStateFor(context),
  );
  const withInvoke =
    kind === "write"
      ? graph.commit("invoke", async (_, { input, client }) =>
          run(client, input),
        )
      : graph.call("invoke", async (_, { input, client }) =>
          run(client, input),
        );
  return bindWorkflow(
    withInvoke.output(({ invoke }) => invoke),
    prepare,
  );
}

export const getCalendarRangeWorkflow = defineWorkflowOperation(
  "calendar.range",
  (db: Database, input: CalendarRangeInput) => getCalendarRange(db, input),
);
export const getCalendarScheduleWorkflow = defineWorkflowOperation(
  "calendar.schedule",
  (db: Database, input: CalendarRangeInput) => getCalendarSchedule(db, input),
);
export const getCalendarFeedWorkflow = calendarOperation(
  "calendar.feed",
  "read",
  async (client) => ({ token: await client.getToken() }),
  (origin: string) => ({ context: origin, input: undefined }),
);
export const inspectCalendarFeedWorkflow = calendarOperation(
  "calendar.feed.inspect",
  "read",
  (client) => client.inspect(),
  (origin: string) => ({ context: origin, input: undefined }),
);
export const rotateCalendarFeedWorkflow = calendarOperation(
  "calendar.feed.rotate",
  "write",
  async (client) => ({ token: await client.rotate() }),
  (origin: string) => ({ context: origin, input: undefined }),
);
export const getCalendarCredentialWorkflow = calendarOperation(
  "calendar.credential.get",
  "read",
  (client, userId: UserId) => client.getCalendarCredential(userId),
  (origin: string, userId: UserId) => ({ context: origin, input: userId }),
);
export const rotateCalendarCredentialWorkflow = calendarOperation(
  "calendar.credential.rotate",
  "write",
  (client, userId: UserId) => client.rotateCalendarCredential(userId),
  (origin: string, userId: UserId) => ({ context: origin, input: userId }),
);
export const revokeCalendarCredentialWorkflow = calendarOperation(
  "calendar.credential.revoke",
  "write",
  async (client, userId: UserId) => {
    await client.revokeCalendarCredential(userId);
    return { revoked: true };
  },
  (origin: string, userId: UserId) => ({ context: origin, input: userId }),
);
export const clearCalendarUncertainWriteWorkflow = calendarOperation(
  "calendar.uncertainWrite.clear",
  "write",
  async (client, input: { collection: CalDavCollection; filename: string }) => {
    await client.clearUncertainWrite(input.collection, input.filename);
    return { cleared: true };
  },
  (
    origin: string,
    input: { collection: CalDavCollection; filename: string },
  ) => ({ context: origin, input }),
);
