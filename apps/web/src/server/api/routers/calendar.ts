import { calendarRangeInput, calendarRangeOut } from "@cubby/schemas/calendar";
import { z } from "zod";
import { getCalendarRange } from "~/server/repo/calendar";
import { rotateCalendarFeedToken } from "~/server/repo/calendar-feed";
import { createTRPCRouter, protectedProcedure, strictOutput } from "../trpc";

export const calendarRouter = createTRPCRouter({
  range: protectedProcedure
    .input(calendarRangeInput)
    .output(strictOutput(calendarRangeOut))
    .query(({ ctx, input }) => getCalendarRange(ctx.db, input)),

  /**
   * Mint (or replace) this user's published-feed token and return it.
   *
   * There is no matching `get`: the token is a better-auth `additionalField`, so
   * it already rides on `session.user`. It's returned here because that copy is
   * served from a signed cookie cache for up to `session.cookieCache.maxAge`
   * (5 min) — right after a rotate it still holds the *dead* token, so the UI
   * must render this value, not re-read the session.
   */
  rotateFeed: protectedProcedure
    .output(strictOutput(z.object({ token: z.string() })))
    .mutation(async ({ ctx }) => ({
      token: await rotateCalendarFeedToken(ctx.db, ctx.actorContext.userId),
    })),
});
