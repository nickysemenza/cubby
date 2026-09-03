import type { CalendarRangeInput } from "@cubby/schemas/calendar";

import { calendarFeedStateFor } from "~/server/calendar/client";
import type { Database } from "~/server/db";
import { getCalendarRange } from "~/server/repo/calendar";
export const getCalendarRangeWorkflow = async (
  db: Database,
  input: CalendarRangeInput,
) => await getCalendarRange(db, input);

export const getCalendarFeedWorkflow = async (
  db: Database,
  origin: string,
) => ({
  token: await (await calendarFeedStateFor(origin, db)).getToken(),
});

export const inspectCalendarFeedWorkflow = async (origin: string) =>
  await (await calendarFeedStateFor(origin)).inspect();

export const rotateCalendarFeedWorkflow = async (
  db: Database,
  origin: string,
) => ({ token: await (await calendarFeedStateFor(origin, db)).rotate() });
