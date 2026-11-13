import { z } from "zod";

import { calendarFeedStateFor } from "~/server/domains/calendar/repo/client";
import { definePass } from "~/server/kernel/api";

const cursorSchema = z.object({ origin: z.url(), reason: z.string() });

/** Durable retry for a post-commit dirty mark; the normal fast path stays db-less. */
export const calendarInvalidatePass = definePass({
  name: "calendar.invalidate",
  async run(_db, raw) {
    const cursor = cursorSchema.parse(raw);
    await (await calendarFeedStateFor(cursor.origin)).markDirty(cursor.reason);
    return { cursor, done: true };
  },
});
