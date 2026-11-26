import { definePass } from "~/server/kernel/api";

import { discoverPurchases, purchaseDiscoveryCursor } from "./catch-up";

/** One bounded admission page; domain repositories retain eligibility and evidence. */
export const purchaseDiscoveryPass = definePass({
  name: "purchase.discovery",
  async run(db, raw) {
    return discoverPurchases(db, purchaseDiscoveryCursor.parse(raw ?? {}));
  },
});
