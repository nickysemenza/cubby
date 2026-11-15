import { devicePushRegistration } from "@cubby/schemas/device-fields";
import { entitySchema, type Entity } from "@cubby/schemas/entity";
import {
  backgroundResultAlertPolicies,
  entityRoster,
} from "@cubby/schemas/entity-roster";
import {
  parseEntityId,
  userId,
  type DeviceId,
} from "@cubby/schemas/identifiers";
import type { KernelJson } from "@cubby/schemas/kernel/machinery";
import { APPLE_APP_IDENTITIES } from "@cubby/shared/apple-app-identity";
import { and, eq, inArray, sql } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import { z } from "zod";

import { analysisImageUrl, transformWidth } from "~/lib/image-url";
import { formatCurrency } from "~/lib/number-format";
import { getApnsCredentials } from "~/server/cf-env";
import type { Database } from "~/server/db";
import { session } from "~/server/db/auth.schema";
import {
  getDb,
  notDeleted,
  withTransactionDatabase,
} from "~/server/db/helpers";
import { outer } from "~/server/db/helpers/related";
import {
  auditLog,
  device,
  deviceAlertDelivery,
  ledgerParty,
} from "~/server/db/schema";
import { resolveEntityDisplayCovers } from "~/server/entity-kernel/repo/entity-display-image";
import { kernelScaffold } from "~/server/entity-kernel/scaffolds";
import { wakeAt } from "~/server/workflows/background-tasks/publish";

import {
  apnsJwt,
  fetchApns,
  DEAD_TOKEN_REASONS,
  redactPushToken,
  withTokensScrubbed,
  type ApnsTransport,
  type ApnsCredentials,
} from "./apns";

const resultRecord = z.object({ id: z.string() }).catchall(z.unknown());
const alertPolicy = z.object({
  amountField: z.string().optional(),
  group: z.object({ entity: entitySchema, field: z.string() }).optional(),
});
const policies = z
  .record(z.string(), alertPolicy)
  .parse(backgroundResultAlertPolicies);
type PushPorts = {
  transport?: ApnsTransport;
  credentials?: ApnsCredentials;
  requireEnabled?: boolean;
  expectedRegistration?: string;
};
const claimRow = z.object({
  id: z.uuid(),
  deviceId: z.uuid().transform((id) => parseEntityId("device", id)),
  auditId: z.uuid(),
  registration: z.uuid(),
  batchId: z.uuid(),
});

/** Session and current owner must still match the login which registered the credential. */
export async function livePushDevice(db: Database, id: DeviceId) {
  const [row] = await getDb(db)
    .select()
    .from(device)
    .where(and(eq(device.id, id), notDeleted(device)));
  if (!row || !row.ledgerPartyId) return null;
  const parsed = devicePushRegistration.safeParse(row.pushRegistration);
  if (!parsed.success) return null;
  const registration = parsed.data;
  const [owner] = await getDb(db)
    .select({ id: ledgerParty.id })
    .from(ledgerParty)
    .where(
      and(
        eq(ledgerParty.id, row.ledgerPartyId),
        eq(ledgerParty.userId, userId.parse(registration.userId)),
        notDeleted(ledgerParty),
      ),
    );
  const [login] = await getDb(db)
    .select({ id: session.id })
    .from(session)
    .where(
      and(
        eq(session.id, registration.sessionId),
        eq(session.userId, registration.userId),
        sql`${session.expiresAt} > now()`,
      ),
    );
  return owner && login ? { row, registration } : null;
}

export async function sendDeviceAlert(
  db: Database,
  id: DeviceId,
  body: KernelJson,
  collapseId: string,
  ports: PushPorts = {},
) {
  const current = await livePushDevice(db, id);
  if (
    !current ||
    (ports.requireEnabled && !current.row.backgroundAlerts) ||
    (current &&
      ports.expectedRegistration !== undefined &&
      current.registration.generation !== ports.expectedRegistration)
  )
    return {
      accepted: false,
      error: "This device has no active notification registration.",
    };
  const { registration } = current;
  const credentials = ports.credentials ?? getApnsCredentials();
  let error: string | null = null;
  let dead = false;
  let accepted = false;
  try {
    if (!credentials) throw new Error("APNs credentials are not configured.");
    const authorization = `bearer ${await apnsJwt(credentials, Math.floor(Date.now() / 1000))}`;
    const outcome = await withTokensScrubbed([registration.token], () =>
      (ports.transport ?? fetchApns)({
        environment: registration.environment,
        pushToken: registration.token,
        headers: {
          authorization,
          "apns-topic":
            APPLE_APP_IDENTITIES[registration.appIdentity].bundleIdentifier,
          "apns-push-type": "alert",
          "apns-priority": "10",
          "apns-collapse-id": collapseId,
          "apns-expiration": String(Math.floor(Date.now() / 1000) + 86400),
        },
        body: JSON.stringify(body),
      }),
    );
    accepted = outcome.status === 200;
    dead =
      outcome.status === 410 ||
      (outcome.reason !== null && DEAD_TOKEN_REASONS.has(outcome.reason));
    if (!accepted)
      error = `APNs ${outcome.status}: ${outcome.reason ?? "request refused"}`;
  } catch (cause) {
    error = redactPushToken(
      cause instanceof Error ? cause.message : String(cause),
      registration.token,
    );
  }
  if (error) error = redactPushToken(error, registration.token);
  // A late refusal must never retire a rotated token or a different login's registration.
  await getDb(db)
    .update(device)
    .set({
      pushLastError: error,
      ...(dead ? { pushRegistration: null, backgroundAlerts: false } : {}),
    })
    .where(
      and(
        eq(device.id, current.row.id),
        sql`${device.pushRegistration}->>'generation' = ${registration.generation}`,
      ),
    );
  return { accepted, error, registration: registration.generation };
}

async function resultContent(
  db: Database,
  receipts: readonly { entityKind: Entity; entityId: string }[],
) {
  const groups = new Map<
    string,
    {
      entity: Entity;
      id: string;
      title: string;
      detail: string;
      internalId: string;
      imageEntity: Entity;
    }
  >();
  for (const receipt of receipts) {
    const scaffold = kernelScaffold(receipt.entityKind);
    if (!scaffold) continue;
    const read = await scaffold.getByIds(db, [receipt.entityId]);
    const parsed = resultRecord.safeParse(read.data[0]);
    if (!parsed.success) continue;
    let record = parsed.data;
    let entity = receipt.entityKind;
    const group = policies[entity]?.group;
    const parentCode = group ? record[group.field] : null;
    if (group && typeof parentCode === "string") {
      const parent = await kernelScaffold(group.entity)?.get(db, [parentCode]);
      const parsedParent = resultRecord.safeParse(parent?.data[0]);
      if (parsedParent.success) {
        record = parsedParent.data;
        entity = group.entity;
      }
    }
    const amountField = policies[entity]?.amountField;
    const amount = amountField ? record[amountField] : null;
    const titleField = entityRoster[entity].titleField;
    const title = String(
      record[titleField] ??
        record.name ??
        record.title ??
        entityRoster[entity].singular,
    ).slice(0, 100);
    groups.set(`${entity}:${record.id}`, {
      entity,
      id: record.id,
      title,
      detail: typeof amount === "number" ? formatCurrency(amount) : "",
      internalId: receipt.entityId,
      imageEntity: receipt.entityKind,
    });
  }
  const results = [...groups.values()];
  const first = results[0];
  if (!first) return null;
  let imageUrl: string | undefined;
  try {
    const covers = await resolveEntityDisplayCovers(db, [
      { entityKind: first.imageEntity, entityId: first.internalId },
    ]);
    const image = [...covers.displayCovers.values()][0]?.image;
    if (image) {
      imageUrl = analysisImageUrl(image.url, transformWidth(240));
      if (imageUrl.length > 768) imageUrl = undefined;
    }
  } catch {
    // SILENT: Image availability never prevents the complete text alert.
  }
  return {
    aps: {
      alert: {
        title:
          results.length === 1
            ? `Added ${entityRoster[first.entity].singular}`
            : `Cubby added ${results.length} results`,
        body: results
          .slice(0, 3)
          .map((r) => [r.title, r.detail].filter(Boolean).join(" · "))
          .join("; ")
          .slice(0, 600),
      },
      sound: "default",
      ...(imageUrl ? { "mutable-content": 1 } : {}),
    },
    ...(results.length === 1
      ? { entity: first.entity, entityId: first.id }
      : {}),
    backgroundResults: true,
    ...(imageUrl ? { imageUrl } : {}),
  };
}

/** Frozen batch membership and a fenced lease survive a crash before or after APNs acceptance. */
export async function dispatchBackgroundAlerts(
  db: Database,
  ports: PushPorts = {},
) {
  for (let page = 0; page < 8; page++) {
    const token = crypto.randomUUID();
    const claimed = await withTransactionDatabase(db, async (tx) => {
      const result = await getDb(tx).execute<z.input<typeof claimRow>>(sql`
        WITH candidate AS (
          SELECT d.id FROM "Device" d WHERE ${notDeleted(alias(device, "d"))} AND d."backgroundAlerts"
          AND (SELECT a."availableAt" FROM "DeviceAlertDelivery" a
            WHERE a."deviceId" = d.id AND a."acceptedAt" IS NULL
            ORDER BY a."createdAt", a.id LIMIT 1) <= now()
          ORDER BY d.id FOR UPDATE SKIP LOCKED LIMIT 1
        ), first_batch AS (
          SELECT a."batchId", a."createdAt" + interval '2 minutes' AS cutoff FROM "DeviceAlertDelivery" a JOIN candidate c ON c.id = a."deviceId"
          WHERE a."acceptedAt" IS NULL ORDER BY a."createdAt", a.id LIMIT 1
        )
        UPDATE "DeviceAlertDelivery" a SET "batchId" = coalesce((SELECT "batchId" FROM first_batch), ${crypto.randomUUID()}::uuid),
          "claimToken" = ${token}::uuid, "availableAt" = now() + interval '5 minutes'
        FROM candidate c WHERE a."deviceId" = c.id AND a."acceptedAt" IS NULL
          AND ((a."batchId" = (SELECT "batchId" FROM first_batch)) OR ((SELECT "batchId" FROM first_batch) IS NULL AND a."batchId" IS NULL AND a."createdAt" <= (SELECT cutoff FROM first_batch)))
          AND NOT EXISTS (SELECT 1 FROM "DeviceAlertDelivery" busy WHERE busy."deviceId" = c.id AND busy."claimToken" IS NOT NULL AND busy."availableAt" > now() AND busy."acceptedAt" IS NULL)
        RETURNING a.id, a."deviceId", a."auditId", a."batchId", a.registration`);
      return z.array(claimRow).parse(result.rows);
    });
    const first = claimed[0];
    if (!first) break;
    const current = await livePushDevice(db, first.deviceId);
    const receipts = await getDb(db)
      .select({ entityKind: auditLog.entityKind, entityId: auditLog.entityId })
      .from(auditLog)
      .where(
        inArray(
          auditLog.id,
          claimed.map((row) => row.auditId),
        ),
      );
    const content = current
      ? await resultContent(
          db,
          receipts.map((r) => ({
            ...r,
            entityKind: entitySchema.parse(r.entityKind),
          })),
        )
      : null;
    const outcome = content
      ? await sendDeviceAlert(db, first.deviceId, content, first.batchId, {
          ...ports,
          requireEnabled: true,
          expectedRegistration: first.registration,
        })
      : { accepted: true, error: null };
    await getDb(db)
      .update(deviceAlertDelivery)
      .set({
        claimToken: null,
        lastError: outcome.error,
        availableAt: new Date(Date.now() + 60_000),
        ...(outcome.accepted ? { acceptedAt: new Date() } : {}),
      })
      .where(
        and(
          inArray(
            deviceAlertDelivery.id,
            claimed.map((r) => r.id),
          ),
          eq(deviceAlertDelivery.claimToken, token),
        ),
      );
  }
  // An unbatched arrival cannot advance a frozen batch's retry or claim deadline.
  const next = await getDb(db)
    .select({
      at: sql<Date | null>`min((SELECT a."availableAt" FROM "DeviceAlertDelivery" a
        WHERE a."deviceId" = ${outer(device.id)} AND a."acceptedAt" IS NULL
        ORDER BY a."createdAt", a.id LIMIT 1))`.mapWith(
        deviceAlertDelivery.availableAt,
      ),
    })
    .from(device)
    .where(and(eq(device.backgroundAlerts, true), notDeleted(device)));
  if (next[0]?.at) await wakeAt(next[0].at, { source: "push.results.retry" });
}
