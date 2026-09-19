import { z } from "zod";

export const vendorAccountCursor = z.object({
  newestOrderAt: z.iso.datetime().nullable(),
  orderIdsOnNewestDate: z.array(z.string().min(1)).max(500),
  backfillBeforeOrderAt: z.iso.datetime().nullable(),
  earliestAvailableOrderAt: z.iso.datetime().nullable(),
});

export const vendorAccountStatus = z.enum([
  "active",
  "paused_auth",
  "paused_offline",
  "disabled",
]);

export const vendorAccountBrowser = z.enum(["chrome", "safari"]);
