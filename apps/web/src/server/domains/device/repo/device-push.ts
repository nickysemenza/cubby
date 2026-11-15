import type { ActorContext } from "@cubby/schemas/context";
import { devicePushRegistration } from "@cubby/schemas/device-fields";
import { and, eq, sql } from "drizzle-orm";
import type { z } from "zod";

import type { Database } from "~/server/db";
import {
  getDb,
  notDeleted,
  withTransactionDatabase,
} from "~/server/db/helpers";
import { device, deviceAlertDelivery } from "~/server/db/schema";
import { currentMemberLedgerParty } from "~/server/domains/ledger-party/repo/current-member-party";
import { withTokensScrubbed } from "~/server/generic/push/repo/apns";
import { sendDeviceAlert } from "~/server/generic/push/repo/delivery";
import { resolveOrThrow } from "~/server/generic/shortcode/repo/shortcode-resolver";

type Registration = z.infer<typeof devicePushRegistration>;
export async function registerDevicePush(
  db: Database,
  actor: ActorContext,
  sessionId: string | null,
  input: Pick<Registration, "token" | "environment" | "appIdentity"> & {
    enabled: boolean;
  },
) {
  if (!actor.deviceId || !sessionId)
    throw new Error(
      "Notification registration requires this install and an active app login.",
    );
  const owner = await currentMemberLedgerParty(db, actor);
  if (!owner)
    throw new Error(
      "Link this login to a household member before enabling notifications.",
    );
  return withTokensScrubbed([input.token], () =>
    withTransactionDatabase(db, async (tx) => {
      const [existing] = await getDb(tx)
        .select()
        .from(device)
        .where(
          and(
            eq(device.id, actor.deviceId!),
            eq(device.ledgerPartyId, owner.id),
            notDeleted(device),
          ),
        )
        .for("update");
      if (!existing)
        throw new Error("This install must belong to the signed-in member.");
      const previous = devicePushRegistration.safeParse(
        existing.pushRegistration,
      ).data;
      const same =
        previous &&
        previous.token === input.token &&
        previous.userId === actor.userId &&
        previous.sessionId === sessionId &&
        previous.environment === input.environment &&
        previous.appIdentity === input.appIdentity;
      const registration = devicePushRegistration.parse({
        ...input,
        userId: actor.userId,
        sessionId,
        generation: same ? previous.generation : crypto.randomUUID(),
      });
      await getDb(tx)
        .update(device)
        .set({
          pushRegistration: registration,
          backgroundAlerts: input.enabled,
          pushLastError: null,
        })
        .where(eq(device.id, existing.id));
      // Turning off or changing login/token never transfers a queued digest to another registration.
      if (!same && previous?.userId === actor.userId && input.enabled) {
        await getDb(tx)
          .update(deviceAlertDelivery)
          .set({ registration: registration.generation, claimToken: null })
          .where(
            and(
              eq(deviceAlertDelivery.deviceId, existing.id),
              sql`${deviceAlertDelivery.acceptedAt} IS NULL`,
            ),
          );
      } else if (!same || !input.enabled)
        await getDb(tx)
          .delete(deviceAlertDelivery)
          .where(
            and(
              eq(deviceAlertDelivery.deviceId, existing.id),
              sql`${deviceAlertDelivery.acceptedAt} IS NULL`,
            ),
          );
      return { registered: true };
    }),
  );
}
export async function endDevicePush(db: Database, actor: ActorContext) {
  if (!actor.deviceId) return { registered: false };
  await withTransactionDatabase(db, async (tx) => {
    const updated = await getDb(tx)
      .update(device)
      .set({ pushRegistration: null, backgroundAlerts: false })
      .where(
        and(
          eq(device.id, actor.deviceId!),
          sql`${device.pushRegistration}->>'userId' = ${actor.userId}`,
        ),
      )
      .returning({ id: device.id });
    if (!updated.length) return;
    await getDb(tx)
      .delete(deviceAlertDelivery)
      .where(
        and(
          eq(deviceAlertDelivery.deviceId, actor.deviceId!),
          sql`${deviceAlertDelivery.acceptedAt} IS NULL`,
        ),
      );
  });
  return { registered: false };
}
export async function testDevicePush(db: Database, code: string) {
  return sendDeviceAlert(
    db,
    await resolveOrThrow(db, "device", code),
    {
      aps: {
        alert: {
          title: "Cubby test notification",
          body: "Notifications are working on this device.",
        },
        sound: "default",
      },
      backgroundResults: true,
    },
    crypto.randomUUID(),
  );
}
