import { calendarRangeInput, calendarRangeOut } from "@cubby/schemas/calendar";
import { getCalendarRange } from "~/server/repo/calendar";
import { createTRPCRouter, protectedProcedure } from "../trpc";

export const calendarRouter = createTRPCRouter({
  range: protectedProcedure
    .input(calendarRangeInput)
    .output(calendarRangeOut)
    .query(({ ctx, input }) => getCalendarRange(ctx.db, input)),
});
