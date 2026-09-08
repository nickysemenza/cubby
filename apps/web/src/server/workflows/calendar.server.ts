import type { CalendarRangeInput } from "@cubby/schemas/calendar";
import type { UserId } from "@cubby/schemas/identifiers";

import { calendarFeedStateFor } from "~/server/calendar/client";
import type { Database } from "~/server/db";
import { getCalendarRange } from "~/server/repo/calendar";
export const getCalendarRangeWorkflow = async (
  db: Database,
  input: CalendarRangeInput,
) => await getCalendarRange(db, input);

export const getCalendarFeedWorkflow = async (origin: string) => ({
  token: await (await calendarFeedStateFor(origin)).getToken(),
});

export const inspectCalendarFeedWorkflow = async (origin: string) =>
  await (await calendarFeedStateFor(origin)).inspect();

export const rotateCalendarFeedWorkflow = async (origin: string) => ({
  token: await (await calendarFeedStateFor(origin)).rotate(),
});

export const getCalendarCredentialWorkflow = async (
  origin: string,
  userId: UserId,
) => await (await calendarFeedStateFor(origin)).getCalendarCredential(userId);

export const rotateCalendarCredentialWorkflow = async (
  origin: string,
  userId: UserId,
) =>
  await (await calendarFeedStateFor(origin)).rotateCalendarCredential(userId);

export const revokeCalendarCredentialWorkflow = async (
  origin: string,
  userId: UserId,
) => {
  await (await calendarFeedStateFor(origin)).revokeCalendarCredential(userId);
  return { revoked: true };
};

export const clearCalendarUncertainWriteWorkflow = async (
  origin: string,
  input: {
    collection: import("~/server/calendar/caldav-types").CalDavCollection;
    filename: string;
  },
) => {
  await (
    await calendarFeedStateFor(origin)
  ).clearUncertainWrite(input.collection, input.filename);
  return { cleared: true };
};
