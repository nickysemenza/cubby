import { z } from "zod";

/** A Mail search's state in one mailbox: finished, part-way (a finished page or a page token), or untouched. */
export const mailSearchState = z.enum(["not_started", "in_progress", "done"]);
export type MailSearchState = z.infer<typeof mailSearchState>;
export const MAIL_SEARCH_STATE_LABEL = {
  not_started: "Not started",
  in_progress: "In progress",
  done: "Done",
} as const satisfies Record<MailSearchState, string>;
