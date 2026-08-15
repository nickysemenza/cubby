import { calendarRangeInput, calendarRangeOut } from "@cubby/schemas/calendar";
import { z } from "zod";
import { getCalendarRange } from "~/server/repo/calendar";
import {
  getCalendarFeedToken,
  rotateCalendarFeedToken,
} from "~/server/repo/calendar-feed";
import { createTRPCRouter, protectedProcedure, strictOutput } from "../trpc";

export const calendarRouter = createTRPCRouter({
  range: protectedProcedure
    .input(calendarRangeInput)
    .output(strictOutput(calendarRangeOut))
    .query(({ ctx, input }) => getCalendarRange(ctx.db, input)),

  /**
   * The current feed token, or null if none has been minted.
   *
   * This exists despite the token also riding on `session.user`: that copy is
   * served from a signed cookie cache for up to `session.cookieCache.maxAge`
   * (5 min), so within that window it reports a stale value — including `null`
   * for a feed that was just created. Trusting it made the dialog offer "Create
   * feed" for an existing feed, and taking that offer rotates the token and
   * silently breaks any live subscription. Read through here instead.
   */
  getFeed: protectedProcedure
    .output(strictOutput(z.object({ token: z.string().nullable() })))
    .query(async ({ ctx }) => ({
      token: await getCalendarFeedToken(ctx.db, ctx.actorContext.userId),
    })),

  /** Mint (or replace) this user's published-feed token and return it. */
  rotateFeed: protectedProcedure
    .output(strictOutput(z.object({ token: z.string() })))
    .mutation(async ({ ctx }) => ({
      token: await rotateCalendarFeedToken(ctx.db, ctx.actorContext.userId),
    })),
});
