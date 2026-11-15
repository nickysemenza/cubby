import {
  apnsJwt,
  fetchApns,
  withTokensScrubbed,
  redactPushToken,
  DEAD_TOKEN_REASONS,
  type ApnsOutcome,
  type ApnsEnvironment,
  type ApnsCredentials,
  type ApnsTransport,
} from "~/server/generic/push/repo/apns";
export type { ApnsTransport } from "~/server/generic/push/repo/apns";
import type { ActorContext } from "@cubby/schemas/context";
import type { RunId } from "@cubby/schemas/identifiers";
import { runShortcode } from "@cubby/schemas/identifiers";
import {
  photoRunLiveActivityContentState,
  type PhotoRunLifecycle,
  type PhotoRunLiveActivityContentState,
  type PhotoRunPushAppIdentity,
  type photoRunLiveActivityEndInput,
  type photoRunLiveActivityRegisterInput,
  type photoRunNotificationEndInput,
  type photoRunNotificationRegisterInput,
} from "@cubby/schemas/photo-import-run";
import { APPLE_APP_IDENTITIES } from "@cubby/shared/apple-app-identity";
import { and, eq, isNull, sql, type AnyColumn } from "drizzle-orm";
import { z } from "zod";

import { getApnsCredentials } from "~/server/cf-env";
import type { Database } from "~/server/db";
import { getDb } from "~/server/db/helpers";
import { run as runTable, runPushRegistration } from "~/server/db/schema";

/** A build's standard alerts use its bundle id as the APNs topic. */
const apnsAlertTopic = (identity: PhotoRunPushAppIdentity) =>
  APPLE_APP_IDENTITIES[identity].bundleIdentifier;
/** Live Activities exist only in the production app (iOS). */
const APNS_LIVE_ACTIVITY_TOPIC = `${APPLE_APP_IDENTITIES.production.bundleIdentifier}.push-type.liveactivity`;

type PushKind = (typeof runPushRegistration.$inferSelect)["kind"];

/**
 * Only the Run's initiating install (`Run.deviceId`, from `X-Cubby-Device`
 * on createRun) may register; executors and other devices never receive this
 * Run's pushes. Re-registering replaces the token (ActivityKit and APNs
 * rotate them) and reopens an ended registration.
 */
async function registerRunPush(
  db: Database,
  actor: ActorContext,
  input: {
    runId: string;
    pushToken: string;
    apnsEnvironment: ApnsEnvironment;
    appIdentity: PhotoRunPushAppIdentity;
    kind: PushKind;
  },
) {
  const what = input.kind === "alert" ? "notifications" : "a Live Activity";
  // Only the production app has the Live Activity extension and its topic.
  if (input.kind === "live_activity" && input.appIdentity !== "production")
    throw new Error(
      "Live Activities are only supported in the production Cubby app",
    );
  if (!actor.deviceId)
    throw new Error(
      `Registering ${what} needs this install's X-Cubby-Device header`,
    );
  const [run] = await getDb(db)
    .select({ id: runTable.id, deviceId: runTable.deviceId })
    .from(runTable)
    .where(eq(runTable.shortcode, runShortcode.parse(input.runId)))
    .limit(1);
  if (!run) throw new Error(`Run ${input.runId} was not found`);
  if (run.deviceId !== actor.deviceId)
    throw new Error(
      `Run ${input.runId} was started on another device; only that device receives its ${what}`,
    );
  const deviceId = actor.deviceId;
  const now = new Date();
  // Replaying the same token, app build and APNs environment keeps its delivery
  // state, so a re-registration never repeats an alert or Activity update
  // already delivered; a changed registration starts clean.
  const keepIfSameToken = <T extends AnyColumn>(column: T) =>
    sql`CASE WHEN ${runPushRegistration.pushToken} = excluded."pushToken" AND ${runPushRegistration.appIdentity} = excluded."appIdentity" AND ${runPushRegistration.apnsEnvironment} = excluded."apnsEnvironment" THEN ${column} END`;
  await withTokensScrubbed([input.pushToken], () =>
    getDb(db)
      .insert(runPushRegistration)
      .values({
        runId: run.id,
        deviceId,
        kind: input.kind,
        pushToken: input.pushToken,
        apnsEnvironment: input.apnsEnvironment,
        appIdentity: input.appIdentity,
        updatedAt: now,
      })
      .onConflictDoUpdate({
        target: [
          runPushRegistration.runId,
          runPushRegistration.deviceId,
          runPushRegistration.kind,
        ],
        set: {
          pushToken: input.pushToken,
          apnsEnvironment: input.apnsEnvironment,
          appIdentity: input.appIdentity,
          lastStateKey: keepIfSameToken(runPushRegistration.lastStateKey),
          lastError: keepIfSameToken(runPushRegistration.lastError),
          endedAt: null,
          updatedAt: now,
        },
      }),
  );
  const { advancePhotoRun } = await import("./lifecycle");
  await advancePhotoRun(db, input.runId);
  return { registered: true as const };
}

async function endRunPush(
  db: Database,
  actor: ActorContext,
  input: { runId: string; kind: PushKind },
) {
  if (!actor.deviceId) return { ended: false };
  const [run] = await getDb(db)
    .select({ id: runTable.id })
    .from(runTable)
    .where(eq(runTable.shortcode, runShortcode.parse(input.runId)))
    .limit(1);
  if (!run) return { ended: false };
  const ended = await getDb(db)
    .update(runPushRegistration)
    .set({ endedAt: new Date(), updatedAt: new Date() })
    .where(
      and(
        eq(runPushRegistration.runId, run.id),
        eq(runPushRegistration.deviceId, actor.deviceId),
        eq(runPushRegistration.kind, input.kind),
        isNull(runPushRegistration.endedAt),
      ),
    )
    .returning({ id: runPushRegistration.id });
  return { ended: ended.length > 0 };
}

export const registerPhotoRunLiveActivity = (
  db: Database,
  actor: ActorContext,
  input: z.output<typeof photoRunLiveActivityRegisterInput>,
) => registerRunPush(db, actor, { ...input, kind: "live_activity" });

export const endPhotoRunLiveActivity = (
  db: Database,
  actor: ActorContext,
  input: z.output<typeof photoRunLiveActivityEndInput>,
) => endRunPush(db, actor, { ...input, kind: "live_activity" });

/** Opt-in alerts: a standard APNs device token, independent of any Activity. */
export const registerPhotoRunNotification = (
  db: Database,
  actor: ActorContext,
  input: z.output<typeof photoRunNotificationRegisterInput>,
) =>
  registerRunPush(db, actor, {
    runId: input.runId,
    pushToken: input.deviceToken,
    apnsEnvironment: input.apnsEnvironment,
    appIdentity: input.appIdentity,
    kind: "alert",
  });

export const endPhotoRunNotification = (
  db: Database,
  actor: ActorContext,
  input: z.output<typeof photoRunNotificationEndInput>,
) => endRunPush(db, actor, { ...input, kind: "alert" });

/** What the Activity shows for a lifecycle; keys match the Swift ContentState. */
function photoRunActivityContent(
  lifecycle: PhotoRunLifecycle,
): PhotoRunLiveActivityContentState {
  const planned = lifecycle.plannedImageCount ?? lifecycle.finalizedImageCount;
  const describeTotal =
    lifecycle.describedImageCount +
    lifecycle.failedImageIds.length +
    Math.max(
      0,
      lifecycle.finalizedImageCount -
        lifecycle.skippedImageCount -
        lifecycle.describedImageCount -
        lifecycle.failedImageIds.length,
    );
  const base = { needsAttention: false };
  switch (lifecycle.phase) {
    case "waiting_for_upload":
      return {
        ...base,
        phase: "waiting_for_upload",
        title: "Uploading photos",
        detail: `${lifecycle.finalizedImageCount} of ${planned} uploaded`,
        completed: lifecycle.finalizedImageCount,
        total: planned,
      };
    case "describing":
      return {
        ...base,
        phase: "describing",
        title: "Describing photos",
        detail: `${lifecycle.describedImageCount} of ${describeTotal} described`,
        completed: lifecycle.describedImageCount,
        total: describeTotal,
      };
    case "needs_attention":
      return {
        phase: "needs_attention",
        title: "Photo import needs attention",
        detail: lifecycle.failedImageIds.length
          ? `${lifecycle.failedImageIds.length} photo descriptions failed`
          : (lifecycle.dispatchError ??
            "Grouping stopped before every photo was resolved; open the Run"),
        completed: lifecycle.describedImageCount,
        total: describeTotal,
        needsAttention: true,
      };
    case "grouping":
      return {
        ...base,
        phase: "grouping",
        title: "Grouping photos",
        detail: `Cubby is grouping ${lifecycle.describedImageCount} photos`,
        completed: lifecycle.describedImageCount,
        total: describeTotal,
      };
    case "ready_for_handoff":
      return {
        ...base,
        phase: "ready_for_handoff",
        title: "Ready for Claude or Codex",
        detail: "Copy the handoff prompt to group these photos",
        completed: lifecycle.describedImageCount,
        total: describeTotal,
      };
    case "ready_for_review":
      return {
        ...base,
        phase: "ready_for_review",
        title: "Ready to review",
        detail: `${lifecycle.proposedGroupCount} groups to approve`,
        completed: lifecycle.committedGroupCount,
        total: lifecycle.committedGroupCount + lifecycle.proposedGroupCount,
      };
    case "completed":
      return {
        ...base,
        phase: "completed",
        title: "Photo import complete",
        detail: `${lifecycle.committedGroupCount} groups approved`,
        completed: lifecycle.committedGroupCount,
        total: lifecycle.committedGroupCount,
      };
  }
}

const ALERT_PHASES = new Set([
  "needs_attention",
  "ready_for_review",
  "ready_for_handoff",
]);
const ENDING_PHASES = new Set([
  "ready_for_review",
  "ready_for_handoff",
  "completed",
]);
/**
 * Push the Run's current state to each open registration: a Live Activity
 * update whose content differs, or one alert per entry into an alerting
 * phase. Never throws: a missing credential or APNs refusal is kept verbatim
 * (token scrubbed) in `lastError` and retried on the next change or sweep.
 */
export async function pushPhotoRunRegistrations(
  db: Database,
  runId: RunId,
  publicId: string,
  lifecycle: PhotoRunLifecycle,
  transport: ApnsTransport = fetchApns,
  credentials: ApnsCredentials | undefined = getApnsCredentials(),
) {
  const rows = await getDb(db)
    .select({
      id: runPushRegistration.id,
      kind: runPushRegistration.kind,
      pushToken: runPushRegistration.pushToken,
      apnsEnvironment: runPushRegistration.apnsEnvironment,
      appIdentity: runPushRegistration.appIdentity,
      lastStateKey: runPushRegistration.lastStateKey,
    })
    .from(runPushRegistration)
    .where(
      and(
        eq(runPushRegistration.runId, runId),
        isNull(runPushRegistration.endedAt),
      ),
    );
  if (!rows.length) return { sent: 0 };
  return withTokensScrubbed(
    rows.map((row) => row.pushToken),
    () =>
      deliverPhotoRunPushes(
        db,
        rows,
        publicId,
        lifecycle,
        transport,
        credentials,
      ),
  );
}

async function deliverPhotoRunPushes(
  db: Database,
  rows: readonly {
    id: string;
    kind: PushKind;
    pushToken: string;
    apnsEnvironment: ApnsEnvironment;
    appIdentity: PhotoRunPushAppIdentity;
    lastStateKey: string | null;
  }[],
  publicId: string,
  lifecycle: PhotoRunLifecycle,
  transport: ApnsTransport,
  credentials: ApnsCredentials | undefined,
) {
  const content = photoRunLiveActivityContentState.parse(
    photoRunActivityContent(lifecycle),
  );
  const stateKey = JSON.stringify(content);
  // The Activity tracks uploads → descriptions → grouping and ends on the
  // first resting state; manual review happens in the app. A later batch
  // registers a fresh Activity token, which reopens the row. Alerts never
  // end on a phase: they stay registered until the member opts out.
  const ending = ENDING_PHASES.has(content.phase);
  let sent = 0;
  for (const row of rows) {
    const now = new Date();
    // A late response must not end or overwrite a corrected registration,
    // even when its token remains unchanged.
    const sameToken = and(
      eq(runPushRegistration.id, row.id),
      eq(runPushRegistration.pushToken, row.pushToken),
      eq(runPushRegistration.appIdentity, row.appIdentity),
      eq(runPushRegistration.apnsEnvironment, row.apnsEnvironment),
    );
    // A phase can recur after a batch completes. Its cumulative planned count
    // fences responses from a previous batch even after the phase recurs.
    const key =
      row.kind === "alert"
        ? JSON.stringify([
            lifecycle.phase,
            lifecycle.plannedImageCount ?? lifecycle.finalizedImageCount,
          ])
        : stateKey;
    if (row.lastStateKey === key) continue;
    // Arbitration: a write lands only on the registration's observed token
    // and delivery state, so overlapping advances cannot both send one state.
    const observed = and(
      sameToken,
      row.lastStateKey === null
        ? isNull(runPushRegistration.lastStateKey)
        : eq(runPushRegistration.lastStateKey, row.lastStateKey),
    );
    const claimed = and(sameToken, eq(runPushRegistration.lastStateKey, key));
    if (row.kind === "alert" && !ALERT_PHASES.has(lifecycle.phase)) {
      // Remember the quiet phase so re-entering an alerting one alerts again.
      await getDb(db)
        .update(runPushRegistration)
        .set({ lastStateKey: key, updatedAt: now })
        .where(observed);
      continue;
    }
    if (!credentials) {
      await getDb(db)
        .update(runPushRegistration)
        .set({
          lastError:
            "APNs credentials are not configured (APNS_KEY_ID, APNS_TEAM_ID, APNS_PRIVATE_KEY)",
          updatedAt: now,
        })
        .where(sameToken);
      continue;
    }
    // Claim this state before sending; the advance that loses the claim
    // skips. A failed or ambiguous send releases it below so a later advance
    // retries — at least once, never a promise of exactly once.
    const [claim] = await getDb(db)
      .update(runPushRegistration)
      .set({ lastStateKey: key, updatedAt: now })
      .where(observed)
      .returning({ id: runPushRegistration.id });
    if (!claim) continue;
    const timestamp = Math.floor(now.getTime() / 1000);
    const request =
      row.kind === "alert"
        ? {
            pushType: "alert",
            topic: apnsAlertTopic(row.appIdentity),
            priority: "10",
            body: {
              aps: {
                alert: { title: content.title, body: content.detail },
                sound: "default",
                "thread-id": publicId,
              },
              runId: publicId,
            },
          }
        : {
            pushType: "liveactivity",
            topic: APNS_LIVE_ACTIVITY_TOPIC,
            priority: ALERT_PHASES.has(content.phase) || ending ? "10" : "5",
            body: {
              aps: {
                timestamp,
                event: ending ? "end" : "update",
                "content-state": content,
                // An Activity not updated for an hour shows as stale.
                "stale-date": timestamp + 60 * 60,
                ...(ending ? { "dismissal-date": timestamp + 15 * 60 } : {}),
                ...(ALERT_PHASES.has(content.phase)
                  ? { alert: { title: content.title, body: content.detail } }
                  : {}),
              },
            },
          };
    let outcome: ApnsOutcome;
    try {
      outcome = await transport({
        environment: row.apnsEnvironment,
        pushToken: row.pushToken,
        headers: {
          authorization: `bearer ${await apnsJwt(credentials, timestamp)}`,
          "apns-push-type": request.pushType,
          "apns-topic": request.topic,
          "apns-priority": request.priority,
        },
        body: JSON.stringify(request.body),
      });
    } catch (error) {
      outcome = { status: 0, reason: String(error) };
    }
    const delivered = outcome.status === 200;
    const dead =
      outcome.status === 410 ||
      (outcome.reason !== null && DEAD_TOKEN_REASONS.has(outcome.reason));
    await getDb(db)
      .update(runPushRegistration)
      .set({
        lastStateKey: delivered ? key : row.lastStateKey,
        lastSentAt: delivered ? now : undefined,
        lastError: delivered
          ? null
          : redactPushToken(
              `APNs ${outcome.status}: ${outcome.reason ?? "no reason"}`,
              row.pushToken,
            ),
        endedAt:
          (delivered && ending && row.kind === "live_activity") || dead
            ? now
            : undefined,
        updatedAt: now,
      })
      .where(claimed);
    if (delivered) sent += 1;
  }
  return { sent };
}
