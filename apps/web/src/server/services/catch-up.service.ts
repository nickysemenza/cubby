import { publishBackgroundTasks } from "~/server/background-tasks/publish";
import {
  getGmailOAuthCredentials,
  getPurchaseAgentQueue,
  getPurchaseImportNamespace,
  isCloudflareRuntime,
} from "~/server/cf-env";
import type { Database } from "~/server/db";
import {
  claimCatchUp,
  releaseCatchUpClaim,
} from "~/server/repo/catch-up-claim";

export { claimCatchUp } from "~/server/repo/catch-up-claim";

export async function requestCatchUp(
  db: Database,
): Promise<{ status: "queued" | "recent" }> {
  const claimedAt = new Date();
  if (!(await claimCatchUp(db, claimedAt))) return { status: "recent" };
  try {
    await publishBackgroundTasks(
      db,
      [
        { kind: "maintenance.recover", requestedAt: claimedAt.toISOString() },
        {
          kind: "maintenance.purchase-discovery",
          requestedAt: claimedAt.toISOString(),
        },
      ],
      { source: "maintenance.app-open" },
    );
  } catch (error) {
    await releaseCatchUpClaim(db, claimedAt);
    throw error;
  }
  return { status: "queued" };
}

export async function recoverMissedWork(db: Database) {
  const [
    { repairImageProcessingWork },
    { expireOfflineImportRuns, expireStaleImportRuns },
  ] = await Promise.all([
    import("~/server/repo/image-processing-maintenance"),
    import("~/server/purchase-import/run-service"),
  ]);
  const namespace = getPurchaseImportNamespace();
  const [image, offlineResult, staleResult] = await Promise.allSettled([
    repairImageProcessingWork(db),
    expireOfflineImportRuns(db),
    namespace
      ? expireStaleImportRuns(db, namespace)
      : isCloudflareRuntime()
        ? Promise.reject(new Error("PURCHASE_IMPORT binding is unavailable"))
        : Promise.resolve(null),
  ]);
  const errors = [image, offlineResult, staleResult]
    .filter((result) => result.status === "rejected")
    .map((result) => String(result.reason));
  const offline =
    offlineResult.status === "fulfilled" ? offlineResult.value : null;
  const stale = staleResult.status === "fulfilled" ? staleResult.value : null;
  console.log("[catch-up] purchase runs expired", { offline, stale });
  errors.push(...(stale?.failures.map(({ error }) => error) ?? []));
  if (errors.length) throw new Error(errors.join("; "));
  return { offline, stale };
}

async function gmailCredentials() {
  const worker = getGmailOAuthCredentials();
  if (worker) return worker;
  const { env } = await import("~/env");
  return {
    clientId: env.GOOGLE_CLIENT_ID,
    clientSecret: env.GOOGLE_CLIENT_SECRET,
  };
}

export async function discoverPurchases(db: Database) {
  const [
    { runGmailHourlySync },
    { createBetterAuthGmailAccountStore },
    { createGmailProviderFactory },
    { listGmailSyncTargets },
    { discoverImportHunts, dispatchImportHunts },
    { processOrderMails },
  ] = await Promise.all([
    import("~/server/purchase-import/gmail/hourly"),
    import("~/server/purchase-import/gmail/persistence"),
    import("~/server/purchase-import/gmail/tokens"),
    import("~/server/purchase-import/gmail/targets"),
    import("~/server/purchase-import/hunts"),
    import("~/server/purchase-import/gmail/process"),
  ]);
  const { clientId, clientSecret } = await gmailCredentials();
  if (!clientId || !clientSecret)
    console.log(
      "[catch-up] Gmail discovery skipped: Google OAuth is not configured",
    );
  const [huntResult, gmailResult] = await Promise.allSettled([
    discoverImportHunts(db),
    clientId && clientSecret
      ? runGmailHourlySync({
          db,
          listTargets: () => listGmailSyncTargets(db),
          providerForUser: createGmailProviderFactory({
            store: createBetterAuthGmailAccountStore(db),
            clientId,
            clientSecret,
          }),
          includeAttachmentData: true,
          processMessages: processOrderMails,
        })
      : Promise.resolve(null),
  ]);
  const queue = getPurchaseAgentQueue();
  const dispatchResult = await Promise.allSettled([
    queue
      ? dispatchImportHunts(db, queue)
      : isCloudflareRuntime()
        ? Promise.reject(
            new Error("PURCHASE_AGENT_QUEUE binding is unavailable"),
          )
        : Promise.resolve(0),
  ]);
  const huntsCreated =
    huntResult.status === "fulfilled" ? huntResult.value : null;
  const summary = gmailResult.status === "fulfilled" ? gmailResult.value : null;
  const huntsDispatched =
    dispatchResult[0]?.status === "fulfilled" ? dispatchResult[0].value : 0;
  console.log("[catch-up] purchase discovery", {
    huntsCreated,
    huntsDispatched,
    summary,
  });
  const errors = [huntResult, gmailResult, ...dispatchResult]
    .filter((result) => result.status === "rejected")
    .map((result) => String(result.reason));
  errors.push(...(summary?.failures.map(({ error }) => error) ?? []));
  if (errors.length) throw new Error(errors.join("; "));
  return { huntsCreated, huntsDispatched, summary };
}
