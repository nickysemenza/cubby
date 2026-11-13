import { z } from "zod";

/** One thing that stopped, in member language; `key` is its record shortcode. */
const workStuckItem = z.object({
  key: z.string(),
  title: z.string(),
  body: z.string(),
  since: z.iso.datetime(),
  action: z.discriminatedUnion("type", [
    z.object({
      type: z.literal("link"),
      label: z.string(),
      href: z.string(),
    }),
    z.object({ type: z.literal("none") }),
  ]),
  /** The stored failure verbatim, for Technical details and for pasting to an agent. */
  diagnostic: z.string().nullable(),
});
export type WorkStuckItem = z.infer<typeof workStuckItem>;

/**
 * The one background verdict: whether work is moving and what stopped. The
 * Needs-you count is the Work queue's own total, never a copy kept here.
 */
export const workStatus = z.object({
  readAt: z.iso.datetime(),
  lastFinishedAt: z.iso.datetime().nullable(),
  /** Work has waited a while but is still finishing. */
  behind: z.boolean(),
  stuck: z.array(workStuckItem),
});
export type WorkStatus = z.infer<typeof workStatus>;
