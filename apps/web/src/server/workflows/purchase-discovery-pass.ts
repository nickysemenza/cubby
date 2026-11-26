import { createLogger } from "@cubby/worker-tracing";

import {
  definePass,
  withPassPageTransaction,
  type PassPageTransaction,
} from "~/server/kernel/api";

import {
  discoverPurchases,
  purchaseDiscoveryCursor,
  recoverMissedWork,
} from "./catch-up";
import { reconcileRunPasses } from "./runs/reconcile-pass";

const log = createLogger("catch-up");

/** One bounded admission page; domain repositories retain eligibility and evidence. */
export const purchaseDiscoveryPass = definePass({
  name: "purchase.discovery",
  activeStart: "restart",
  async run(db, raw, claim) {
    await recoverMissedWork(db);
    return discoverPurchases(
      db,
      purchaseDiscoveryCursor.parse(raw ?? {}),
      claim,
    );
  },
});

/** Mailbox admission is independent of either retained census cursor. */
export const mailboxDiscoveryPass = definePass({
  name: "purchase.mailbox-discovery",
  activeStart: "coalesce",
  async run(db, cursor, claim) {
    const { gmailOAuthConfigured } =
      await import("~/server/domains/purchase-import/repo/gmail/provider");
    if (gmailOAuthConfigured()) {
      const pageTransaction: PassPageTransaction = (work) =>
        withPassPageTransaction(db, work, claim);
      // Project terminal execution before checking the mailbox admission slot.
      await reconcileRunPasses(db, pageTransaction);
      const { startMailDiscovery } =
        await import("~/server/domains/purchase-import/operations/gmail/discovery");
      const mail = await startMailDiscovery(db, { pageTransaction });
      log.info("purchase discovery", {
        mailPassesStarted: mail.started,
        mailPassesRunning: mail.running,
      });
    }
    return { cursor, done: true };
  },
});
