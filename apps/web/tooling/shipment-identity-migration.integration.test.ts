import { drizzle } from "drizzle-orm/node-postgres";
import { expect, it } from "vitest";

import { migrateDatabase } from "./db-migrate";
import { withMigrationDatabase } from "./test-database-lease";

// Identity enforcement must not erase pre-existing duplicates or their reviewed evidence.
it("preserves populated duplicate shipment evidence when installing identity enforcement", async () => {
  await withMigrationDatabase(async (client) => {
    const db = drizzle({ client: client, paramsInErrors: true });
    await migrateDatabase(db, {
      through: "20261030032333_0062_source_claim_family_fanout",
    });
    const id = (n: number) =>
      `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
    await client.query(
      `INSERT INTO "user" (id,name,email) VALUES ('shipment-migration','Synthetic member','shipment@example.test')`,
    );
    await client.query(
      `INSERT INTO "ShipmentSourceCapture" (id,"sourceKey",checksum,source,"actorUserId")
      VALUES ($1,'synthetic-source','synthetic-checksum',$2,'shipment-migration')`,
      [
        id(10),
        {
          kind: "tracking_page",
          url: "https://tracking.example/package",
          externalKey: "synthetic-source",
          capturedAt: "2026-06-03T09:00:00Z",
          content: "Synthetic retained evidence",
        },
      ],
    );
    for (const n of [1, 2, 3]) {
      const code = ["SHIP-23456", "SHIP-23457", "SHIP-23458"][n - 1];
      await client.query(
        `INSERT INTO "Entity" (id,kind,shortcode) VALUES ($1,'shipment',$2)`,
        [id(n), code],
      );
      await client.query(
        `INSERT INTO "Shipment" (id,shortcode,name,"trackingNumber",notes)
        VALUES ($1,$2,'Synthetic duplicate package','EXAMPLE-MIGRATION','Synthetic retained note')`,
        [id(n), code],
      );
      await client.query(
        `INSERT INTO "ShipmentSourcePackage" (id,"shipmentId","sourceKey","packageKey")
        VALUES ($1,$2,'synthetic-source',$3)`,
        [id(20 + n), id(n), `package-${n}`],
      );
      await client.query(
        `INSERT INTO "ShipmentObservation"
        (id,"shipmentId","sourceCaptureId","sourcePackageId","sourceKey","occurrenceKey",fingerprint,event,"memberReviewed","firstSeenAt","lastSeenAt")
        VALUES ($1,$2,$3,$4,'synthetic-source','synthetic-occurrence','synthetic-fingerprint',$5,true,'2026-06-03','2026-06-03')`,
        [
          id(30 + n),
          id(n),
          id(10),
          id(20 + n),
          {
            kind: "delivered",
            time:
              n === 3
                ? { kind: "unknown" }
                : { kind: "date", value: "2026-06-03" },
            trackingNumber: "EXAMPLE-MIGRATION",
            rawStatus: "Synthetic delivered",
            carrierId: null,
            carrierName: null,
            location: null,
            sourceEventKey: null,
          },
        ],
      );
      await client.query(
        `INSERT INTO "ShipmentObservationCapture" ("observationId","captureId","firstSeenAt","lastSeenAt")
        VALUES ($1,$2,'2026-06-03','2026-06-03')`,
        [id(30 + n), id(10)],
      );
    }
    await client.query(
      `INSERT INTO "ShipmentObservation"
      (id,"shipmentId","sourceCaptureId","sourcePackageId","sourceKey","occurrenceKey",fingerprint,event,"memberReviewed","firstSeenAt","lastSeenAt")
      SELECT $1,"shipmentId","sourceCaptureId","sourcePackageId","sourceKey",'distant-event','distant-fingerprint',
        jsonb_set(event,'{time,value}','"2026-09-03"'::jsonb),false,"firstSeenAt","lastSeenAt"
      FROM "ShipmentObservation" WHERE id=$2`,
      [id(99), id(31)],
    );
    const snapshot = async () => {
      const values = [];
      for (const table of [
        "Shipment",
        "ShipmentSourceCapture",
        "ShipmentSourcePackage",
        "ShipmentObservation",
        "ShipmentObservationCapture",
      ])
        values.push(
          (
            await client.query(
              `SELECT jsonb_agg(to_jsonb(t) ORDER BY to_jsonb(t)::text) AS rows FROM "${table}" t`,
            )
          ).rows,
        );
      return values;
    };
    const before = await snapshot();
    await migrateDatabase(db, {
      through: "20261103160623_0063_shipment_tracking_identity",
    });
    expect(await snapshot()).toEqual(before);
    const triggers =
      await client.query(`SELECT count(*)::int AS count FROM pg_trigger
      WHERE tgname IN ('Shipment_tracking_period_unique','ShipmentObservation_tracking_period_unique') AND tgdeferrable AND tginitdeferred`);
    expect(triggers.rows[0].count).toBe(2);
    await client.query(
      `UPDATE "Shipment" SET notes='Synthetic corrected note',purpose='incoming'`,
    );
    expect(
      (
        await client.query(
          `SELECT count(*)::int AS count FROM "Shipment" WHERE notes='Synthetic corrected note'`,
        )
      ).rows[0].count,
    ).toBe(3);
    await expect(
      client.query(
        `UPDATE "Shipment" SET "trackingNumber"='EXAMPLE-NEW' WHERE id=$1`,
        [id(3)],
      ),
    ).rejects.toMatchObject({ constraint: "Shipment_tracking_period_check" });
  });
});
