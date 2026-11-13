import { z } from "zod";

import { definePass } from "~/server/kernel/api";

import { discoverPurchases, recoverMissedWork } from "./catch-up";

const cursorSchema = z.object({
  senderAfter: z
    .object({ mailboxId: z.string(), afterId: z.string() })
    .nullable()
    .default(null),
});

/** One bounded admission page; domain repositories retain eligibility and evidence. */
export const purchaseDiscoveryPass = definePass({
  name: "purchase.discovery",
  async run(db, raw) {
    const cursor = cursorSchema.parse(raw ?? {});
    await recoverMissedWork(db);
    const next = await discoverPurchases(db, cursor);
    return { cursor: { senderAfter: next.senderAfter }, done: !next.more };
  },
});
