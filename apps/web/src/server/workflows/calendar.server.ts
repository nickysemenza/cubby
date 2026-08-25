import {
  type CalendarRangeInput,
  calendarFeedOut,
  calendarRangeInput,
  calendarRangeOut,
  calendarRotateFeedOut,
} from "@cubby/schemas/calendar";
import type { UserId } from "@cubby/schemas/identifiers";
import type { Database } from "~/server/db";
import { getCalendarRange } from "~/server/repo/calendar";
import {
  getCalendarFeedToken,
  rotateCalendarFeedToken,
} from "~/server/repo/calendar-feed";

export {
  calendarFeedOut,
  calendarRangeInput,
  calendarRangeOut,
  calendarRotateFeedOut,
};

export const getCalendarRangeWorkflow = async (
  db: Database,
  input: CalendarRangeInput,
) => await getCalendarRange(db, input);

export const getCalendarFeedWorkflow = async (
  db: Database,
  userId: UserId,
) => ({
  token: await getCalendarFeedToken(db, userId),
});

export const rotateCalendarFeedWorkflow = async (
  db: Database,
  userId: UserId,
) => ({ token: await rotateCalendarFeedToken(db, userId) });
