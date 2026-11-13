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

/** Durable queue diagnostics; retries name one exhausted item. */
export const workRetryTarget = z.discriminatedUnion("type", [
  z.object({ type: z.literal("scope"), kind: z.string(), key: z.string() }),
  z.object({ type: z.literal("ask"), id: z.uuid() }),
  z.object({ type: z.literal("pass"), kind: z.string(), key: z.string() }),
]);
export const workDiagnostics = z.object({
  groups: z.array(
    z.object({
      type: z.enum(["scope", "ask", "pass"]),
      kind: z.string(),
      due: z.number(),
      claimed: z.number(),
      waiting: z.number(),
      stuck: z.number(),
      oldestWaiting: z.iso.datetime().nullable(),
    }),
  ),
  failures: z.array(
    z.object({
      target: workRetryTarget,
      error: z.string(),
      at: z.iso.datetime(),
    }),
  ),
});
export type WorkDiagnostics = z.infer<typeof workDiagnostics>;
