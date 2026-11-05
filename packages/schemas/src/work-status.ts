import { z } from "zod";

/** One thing that stopped, in member language; `key` is its Job kind or subject. */
const workStuckItem = z.object({
  key: z.string(),
  title: z.string(),
  body: z.string(),
  since: z.iso.datetime(),
  action: z.discriminatedUnion("type", [
    z.object({
      type: z.literal("retry"),
      kinds: z.array(z.string()).min(1),
      /** Narrows Retry to failed work, leaving healthy waits in the kind alone. */
      needsAttention: z.boolean().optional(),
    }),
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
 * The one background verdict: whether work is moving and what needs a member.
 * It carries no queue sizes, because none of them tells a member what to do.
 */
export const workStatus = z.object({
  readAt: z.iso.datetime(),
  needsYou: z.object({
    count: z.int().nonnegative(),
    /** False while a queue source is unavailable: the count is known work only. */
    complete: z.boolean(),
  }),
  lastFinishedAt: z.iso.datetime().nullable(),
  /** Work has waited a while but is still finishing. */
  behind: z.boolean(),
  stuck: z.array(workStuckItem),
});
export type WorkStatus = z.infer<typeof workStatus>;
