import type { CalendarRangeInput } from "@cubby/schemas/calendar";
import type { UserId } from "@cubby/schemas/identifiers";

import type { CalDavCollection } from "~/server/calendar/caldav-types";
import { calendarFeedStateFor } from "~/server/calendar/client";
import type { Database } from "~/server/db";
import { getCalendarRange } from "~/server/repo/calendar";
import {
  bindWorkflow,
  callStep,
  committedCallStep,
  defineWorkflow,
  defineWorkflowFunction,
  defineWorkflowOperation,
  workflowValue,
} from "~/server/workflow-runtime";

type CalendarClient = Awaited<ReturnType<typeof calendarFeedStateFor>>;
type Invocation<Input> = { client: CalendarClient; input: Input };
const resolveCalendar = defineWorkflowFunction<string, void, CalendarClient>(
  "calendar.resolveClient",
  async ({ context }) => calendarFeedStateFor(context),
);

/** Calendar application actions share client resolution; the DO retains
 * protocol state and owns each awaited write's commit boundary. */
function calendarOperation<Input, Output, Args extends readonly unknown[]>(
  name: string,
  kind: "read" | "write",
  run: (client: CalendarClient, input: Input) => Promise<Output>,
  prepare: (...args: Args) => { context: string; input: Input },
) {
  const client = callStep({
    name: "client",
    fn: resolveCalendar,
    input: workflowValue<Input, void>([], () => undefined),
  });
  const rpc = defineWorkflowFunction<string, Invocation<Input>, Output>(
    `${name}.rpc`,
    async (_, value) => run(value.client, value.input),
  );
  const invoke = (kind === "write" ? committedCallStep : callStep)({
    name: "invoke",
    fn: rpc,
    input: workflowValue<Input, Invocation<Input>>(
      ["$input", "client"],
      (state) => ({ client: client.output.resolve(state), input: state.input }),
    ),
  });
  return bindWorkflow(
    defineWorkflow({ name, steps: [client, invoke], output: invoke.output }),
    prepare,
  );
}

export const getCalendarRangeWorkflow = defineWorkflowOperation(
  "calendar.range",
  (db: Database, input: CalendarRangeInput) => getCalendarRange(db, input),
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
