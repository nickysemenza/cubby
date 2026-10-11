import { z } from "zod";

/** Retained content never grants import authorization. Historical policy stays unknown. */
export const emailExecutionPolicy = z.enum(["classification_only", "import"]);
export type EmailExecutionPolicy = z.infer<typeof emailExecutionPolicy>;

/** Search-cache expiry is explicit, independent of unrelated metadata updates. */
export const emailSearchOrigin = z.enum(["member_search", "discovery"]);
export type EmailSearchOrigin = z.infer<typeof emailSearchOrigin>;
