import { SHORTCODE_PREFIX } from "@cubby/shared";
import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { drizzle } from "drizzle-orm/node-postgres";
import { Client } from "pg";
import { expect, it } from "vitest";
import { MIGRATIONS_FOLDER, migrateDatabase } from "./db-migrate";
import { testServiceConfig } from "./test-service-config";

// Failure modes: expansion mistaken for preservation; intervening old writes
// lost; ambiguous labels invented; corrected null erased; frozen roster,
// suppression scope or application receipts changed; retired work refs survive.
// The latest predecessor's explicit/inherited ownership, Expense role and Image evidence
// must survive both online expansion and the quiesced copy/trigger cutover.
it("reconciles every legacy review family after an intervening writer without losing immutable history", async () => {
  const service = testServiceConfig();
  const adminUrl = `postgresql://postgres:password@${service.host}:${service.port}/postgres`;
  const name = `cubby_shared_reviews_${randomBytes(4).toString("hex")}`;
  const admin = new Client({ connectionString: adminUrl });
  await admin.connect();
  let created = false;
  try {
    await admin.query(`CREATE DATABASE "${name}"`);
    created = true;
    const url = new URL(adminUrl);
    url.pathname = `/${name}`;
    const client = new Client({ connectionString: url.href });
    await client.connect();
    try {
      const journal = JSON.parse(
        readFileSync(join(MIGRATIONS_FOLDER, "meta/_journal.json"), "utf8"),
      );
      const index = journal.entries.findIndex((entry: { tag: string }) =>
        entry.tag.endsWith("_shared_assessment_expansion"),
      );
      if (index < 1)
        throw new Error("Shared Assessment expansion has no predecessor");
      await migrateDatabase(drizzle(client), {
        through: journal.entries[index - 1].tag,
      });
      await client.query(
        `INSERT INTO "user" (id,name,email) VALUES ('synthetic-review-member','Synthetic member','review@example.invalid')`,
      );
      const run = (
        await client.query(
          `INSERT INTO "Run" (shortcode,"actorName","actorUserId","actorEmail",purpose,trigger,status) VALUES ('RUN-4K7M','Synthetic member','synthetic-review-member','review@example.invalid','ai_suggest','manual','completed') RETURNING id`,
        )
      ).rows[0].id;
      const party = (
        await client.query(
          `INSERT INTO "LedgerParty" (shortcode,name,kind,"userId") VALUES ('${SHORTCODE_PREFIX.ledgerParty}-4K7M','Synthetic member','member','synthetic-review-member') RETURNING id`,
        )
      ).rows[0].id;
      const product = (
        await client.query(
          `INSERT INTO "Product" (shortcode,name,manufacturer) VALUES ('PRD-4K7M','Synthetic lamp','Example maker') RETURNING id`,
        )
      ).rows[0].id;
      const other = (
        await client.query(
          `INSERT INTO "Product" (shortcode,name,manufacturer) VALUES ('PRD-4K7N','Synthetic lamp alias','Example maker') RETURNING id`,
        )
      ).rows[0].id;
      const location = (
        await client.query(
          `INSERT INTO "Location" (shortcode,name,type) VALUES ('${SHORTCODE_PREFIX.location}-4K7M','Synthetic preservation shelf','room') RETURNING id`,
        )
      ).rows[0].id;
      await client.query(
        `INSERT INTO "InventoryEntry" (shortcode,"productId","locationId","amountValue","amountUnit","ownershipMode","ownerLedgerPartyId") VALUES ('${SHORTCODE_PREFIX.inventory}-4K7M',$1,$2,2,'each','explicit',$3),('${SHORTCODE_PREFIX.inventory}-4K7N',$1,$2,3,'each','explicit',NULL),('${SHORTCODE_PREFIX.inventory}-4K7P',$1,$2,5,'each','inherit',NULL)`,
        [product, location, party],
      );
      const stockBefore = (
        await client.query(
          `SELECT id,"productId","locationId","amountValue","amountUnit","ownershipMode","ownerLedgerPartyId" FROM "InventoryEntry" ORDER BY shortcode`,
        )
      ).rows;
      expect(stockBefore.map((row) => row.ownershipMode)).toEqual([
        "explicit",
        "explicit",
        "inherit",
      ]);
      const picture = (
        await client.query(
          `INSERT INTO "Image" (shortcode,key,filename,size,"contentType") VALUES ('${SHORTCODE_PREFIX.image}-4K7M','synthetic/image.jpg','synthetic.jpg',1,'image/jpeg') RETURNING id`,
        )
      ).rows[0].id;
      const sourceEvidence = {
        basis: "decision",
        feature: "image-provenance-classification",
        promptVersion: "synthetic-source-policy",
        model: "typesafe/jev",
        runId: "RUN-4K7M",
        confidence: "high",
        probability: 0.98,
        evidenceFingerprint: "e".repeat(64),
        value: "catalog",
      };
      await client.query(`UPDATE "Image" SET "sourceEvidence"=$1 WHERE id=$2`, [
        sourceEvidence,
        picture,
      ]);
      const expense = (
        await client.query(
          `INSERT INTO "Expense" (shortcode,name,"costType",trade,cost,date) VALUES ('EXP-4K7M','Synthetic unresolved line','materials','other',-2.13,'2026-01-02') RETURNING id,"lineKind"`,
        )
      ).rows[0];
      expect(expense.lineKind).toBe("unclassified");
      const original = (
        await client.query(
          `INSERT INTO "OrderMail" ("ledgerPartyId","rawChecksum") VALUES ($1,'synthetic-checksum') RETURNING id`,
          [party],
        )
      ).rows[0].id;
      const email = (
        await client.query(
          `INSERT INTO "Email" (shortcode,"ledgerPartyId","mailboxId","messageId",checksum,"orderMailId",classification,"classificationStage",status) VALUES ('${SHORTCODE_PREFIX.email}-4K7M',$1,'synthetic-mailbox','synthetic-message','synthetic-checksum',$2,'related','resolution','completed') RETURNING id`,
          [party, original],
        )
      ).rows[0].id;
      const vendor = (
        await client.query(
          `INSERT INTO "Vendor" (shortcode,name) VALUES ('${SHORTCODE_PREFIX.vendor}-4K7M','Synthetic vendor') RETURNING id`,
        )
      ).rows[0].id;
      const purchase = (
        await client.query(
          `INSERT INTO "Purchase" (shortcode,"vendorId",date) VALUES ('${SHORTCODE_PREFIX.purchase}-4K7M',$1,'2026-01-01') RETURNING id`,
          [vendor],
        )
      ).rows[0].id;
      const event = (
        await client.query(
          `INSERT INTO "OrderMailEvent" ("orderMailId",event,"sourceKey") VALUES ($1,'ordered','synthetic-event') RETURNING id`,
          [original],
        )
      ).rows[0].id;
      await client.query(
        `INSERT INTO "OrderMailCandidateDecision" ("eventId","purchaseId",decision,"evidenceChecksum","decidedByUserId","proposedBy") VALUES ($1,$2,'linked','synthetic-checksum','synthetic-review-member','member')`,
        [event, purchase],
      );
      // Legacy event authority is valid even when no Email was materialized.
      const orphanOriginal = (
        await client.query(
          `INSERT INTO "OrderMail" ("ledgerPartyId","rawChecksum") VALUES ($1,'synthetic-orphan-checksum') RETURNING id`,
          [party],
        )
      ).rows[0].id;
      const orphanEvent = (
        await client.query(
          `INSERT INTO "OrderMailEvent" ("orderMailId",event,"sourceKey") VALUES ($1,'ordered','synthetic-orphan-event') RETURNING id`,
          [orphanOriginal],
        )
      ).rows[0].id;
      await client.query(
        `INSERT INTO "OrderMailCandidateDecision" ("eventId","purchaseId",decision,"evidenceChecksum","decidedByUserId","proposedBy") VALUES ($1,$2,'dismissed','synthetic-orphan-checksum','synthetic-review-member','member')`,
        [orphanEvent, purchase],
      );
      const observation = (
        await client.query(
          `INSERT INTO "EmailClassificationObservation" ("emailId",checksum,classification,stage) VALUES ($1,'synthetic-checksum','unrelated',NULL) RETURNING id`,
          [email],
        )
      ).rows[0].id;
      const label = (
        await client.query(
          `INSERT INTO "EmailClassificationLabel" ("predictionId",classification,reason,"actorUserId") VALUES ($1,'related','Synthetic member review','synthetic-review-member') RETURNING id`,
          [observation],
        )
      ).rows[0].id;
      const roster = {
        version: 1,
        memberEmailCount: 1,
        unpredictedEmailCount: 0,
        strata: [
          {
            id: "synthetic-stratum",
            stage: null,
            classification: "unrelated",
            model: null,
            populationCount: 1,
            sampleCount: 1,
            inclusionProbability: 1,
          },
        ],
        items: [
          {
            predictionId: observation,
            emailId: email,
            checksum: "synthetic-checksum",
            stratumId: "synthetic-stratum",
            classification: "unrelated",
            stage: null,
            model: null,
            classificationVersion: null,
            promptVersion: null,
            operation: null,
            predictedAt: "2026-01-01T00:00:00.000Z",
          },
        ],
      };
      const evaluation = (
        await client.query(
          `INSERT INTO "EmailAccuracyEvaluation" ("ownerUserId","requestedSampleSize","populationCount","sampleSize",roster) VALUES ('synthetic-review-member',1,1,1,$1) RETURNING id`,
          [roster],
        )
      ).rows[0].id;
      await client.query(
        `INSERT INTO "EmailAccuracyGrade" ("evaluationId","predictionId",grade,reason,"reviewedChecksum","reviewedLabelId") VALUES ($1,$2,'related','Synthetic grade','synthetic-checksum',$3)`,
        [evaluation, observation, label],
      );
      await client.query(
        `INSERT INTO "ImageDescriptionCorrection" ("imageId",description) VALUES ($1,'Confirmed synthetic lamp')`,
        [picture],
      );
      await client.query(
        `INSERT INTO "ProductMatchCandidate" ("productAId","productBId",source,state,evidence) VALUES ($1,$2,'detector','dismissed','Synthetic evidence')`,
        [[product, other].sort()[0], [product, other].sort()[1]],
      );
      await client.query(
        `INSERT INTO "SuggestionDismissal" ("entityKind","entityId","suggestionKind","candidateKey") VALUES ('product',$1,'product.duplicate','opaque-synthetic-group')`,
        [product],
      );
      const suggestion = (
        await client.query(
          `INSERT INTO "Suggestion" ("runId",entity,"recordId",field,"suggestedValue",confidence,model,kind) VALUES ($1,'product',$2,'notes','"Synthetic proposal"',0.9,'typesafe/jev','addition') RETURNING id`,
          [run, product],
        )
      ).rows[0].id;
      await client.query(
        `INSERT INTO "AiEvaluation" ("runId",feature,"workKey",target,provenance,snapshot) VALUES ($1,'field-suggestion','synthetic-work',$2,$3,$4)`,
        [
          run,
          {
            kind: "field",
            entity: "product",
            recordId: product,
            field: "notes",
            suggestionIds: [suggestion],
          },
          {
            dependencies: [],
            inputFingerprint: "synthetic-current-evidence",
            optionFingerprint: "synthetic-options",
            model: null,
          },
          { suggestionIds: [suggestion] },
        ],
      );
      const rawTarget = (
        await client.query(
          `INSERT INTO "Suggestion" ("runId",entity,"recordId",field,"suggestedValue",confidence,model,kind) VALUES ($1,'product',$2,'tags','"Synthetic tag"',0.9,'typesafe/jev','correction') RETURNING id`,
          [run, product],
        )
      ).rows[0].id;
      expect(journal.entries[index].tag).toBe(
        "0068_shared_assessment_expansion",
      );
      await migrateDatabase(drizzle(client), {
        through: journal.entries[index].tag,
      });
      // Online expansion must leave old field invalidation writing its old ledger.
      await client.query(
        `UPDATE "Product" SET tags=ARRAY['Synthetic member edit'] WHERE id=$1`,
        [product],
      );
      const rawSupersession = (
        await client.query(
          `SELECT status,"supersessionReceipt" FROM "Suggestion" WHERE id=$1`,
          [rawTarget],
        )
      ).rows[0];
      expect(rawSupersession.status).toBe("superseded");
      expect(rawSupersession.supersessionReceipt).toEqual(
        expect.objectContaining({ reason: "target_changed" }),
      );
      // This write is later than expansion and must be represented at cutover.
      await client.query(
        `UPDATE "Suggestion" SET status='rejected',"correctValue"='null'::jsonb WHERE id=$1`,
        [suggestion],
      );
      await migrateDatabase(drizzle(client));
      expect(
        (
          await client.query(
            `SELECT id,"productId","locationId","amountValue","amountUnit","ownershipMode","ownerLedgerPartyId" FROM "InventoryEntry" ORDER BY shortcode`,
          )
        ).rows,
      ).toEqual(stockBefore);
      expect(
        (
          await client.query(
            `SELECT "sourceEvidence" FROM "Image" WHERE id=$1`,
            [picture],
          )
        ).rows[0].sourceEvidence,
      ).toEqual(sourceEvidence);
      expect(
        (
          await client.query(`SELECT "lineKind" FROM "Expense" WHERE id=$1`, [
            expense.id,
          ])
        ).rows[0].lineKind,
      ).toBe("unclassified");
      expect(
        (
          await client.query(
            `INSERT INTO "Expense" (shortcode,name,"costType") VALUES ('EXP-4K7N','Synthetic later unresolved line','materials') RETURNING "lineKind"`,
          )
        ).rows[0].lineKind,
      ).toBe("unclassified");
      const originTables = [
        "Suggestion",
        "EmailClassificationObservation",
        "ImageDescriptionCorrection",
        "ProductMatchCandidate",
        "SuggestionDismissal",
        "OrderMailCandidateDecision",
      ];
      for (const table of originTables)
        expect(
          (
            await client.query(
              `SELECT count(*)::int AS count FROM "Assessment" WHERE origin->>'table'=$1`,
              [table],
            )
          ).rows[0].count,
        ).toBe(
          ["Suggestion", "OrderMailCandidateDecision"].includes(table) ? 2 : 1,
        );
      expect(
        (
          await client.query(
            `SELECT status,"supersessionReceipt" FROM "AssessmentState" WHERE id=$1`,
            [rawTarget],
          )
        ).rows[0],
      ).toEqual(rawSupersession);
      const orphanState = (
        await client.query(
          `SELECT s.entity,s."recordId",a.subject,a.producer FROM "AssessmentState" s JOIN "Assessment" a USING(id) WHERE a.family='email_link' AND a.subject->>'eventId'=$1`,
          [orphanEvent],
        )
      ).rows[0];
      expect(orphanState).toEqual(
        expect.objectContaining({
          entity: "orderMailEvent",
          recordId: orphanEvent,
          producer: null,
          subject: expect.objectContaining({
            recordId: null,
            originalId: orphanOriginal,
            eventId: orphanEvent,
          }),
        }),
      );
      expect(
        (
          await client.query(
            `SELECT decision FROM "AssessmentEmailLink" WHERE "eventId"=$1`,
            [orphanEvent],
          )
        ).rows,
      ).toEqual([{ decision: "dismissed" }]);
      // Exercise the actual active indexes using independent immutable histories.
      const duplicate = (
        await client.query(
          `INSERT INTO "Assessment" ("publicationKey",family,subject,judgment) SELECT 'synthetic:duplicate-event','email_link',subject,judgment FROM "Assessment" WHERE subject->>'eventId'=$1 RETURNING id`,
          [orphanEvent],
        )
      ).rows[0].id;
      await expect(
        client.query(
          `INSERT INTO "AssessmentState" (id,family,entity,"recordId",data) SELECT $1,'email_link','orderMailEvent',$2,data FROM "AssessmentState" WHERE data->>'eventId'=$3`,
          [duplicate, orphanEvent, orphanEvent],
        ),
      ).rejects.toMatchObject({
        code: "23505",
        constraint: "AssessmentState_email_event_purchase_key",
      });
      const extraPurchase = (
        await client.query(
          `INSERT INTO "Purchase" (shortcode,"vendorId",date) VALUES ('${SHORTCODE_PREFIX.purchase}-4K7N',$1,'2026-01-01') RETURNING id`,
          [vendor],
        )
      ).rows[0].id;
      await expect(
        client.query(
          `INSERT INTO "AssessmentState" (id,family,entity,"recordId",data) SELECT $1,'email_link','orderMailEvent',$2,jsonb_set(data,'{purchaseId}',to_jsonb($3::text)) FROM "AssessmentState" WHERE data->>'eventId'=$4`,
          [duplicate, event, extraPurchase, event],
        ),
      ).rejects.toMatchObject({
        code: "23505",
        constraint: "AssessmentState_email_one_link_key",
      });
      // Actual Email deletion preserves its link and retires relevance only.
      await client.query(`UPDATE "Email" SET "deletedAt"=now() WHERE id=$1`, [
        email,
      ]);
      expect(
        (
          await client.query(
            `SELECT entity,"recordId",active FROM "AssessmentState" WHERE family='email_link' AND data->>'eventId'=$1`,
            [event],
          )
        ).rows[0],
      ).toEqual({ entity: "orderMailEvent", recordId: event, active: true });
      expect(
        (
          await client.query(
            `SELECT decision FROM "AssessmentEmailLink" WHERE "eventId"=$1`,
            [event],
          )
        ).rows,
      ).toEqual([{ decision: "linked" }]);
      expect(
        (
          await client.query(
            `SELECT active FROM "AssessmentState" WHERE family='email_relevance'`,
          )
        ).rows,
      ).toEqual([{ active: false }]);
      await client.query(
        `UPDATE "OrderMailEvent" SET "supersededAt"=now() WHERE id=$1`,
        [orphanEvent],
      );
      expect(
        (
          await client.query(
            `SELECT * FROM "AssessmentEmailLink" WHERE "eventId"=$1`,
            [orphanEvent],
          )
        ).rows,
      ).toEqual([]);
      await client.query(`DELETE FROM "OrderMailEvent" WHERE id=$1`, [event]);
      expect(
        (
          await client.query(
            `SELECT * FROM "AssessmentEmailLink" WHERE "eventId"=$1`,
            [event],
          )
        ).rows,
      ).toEqual([]);
      expect(
        (
          await client.query(
            `SELECT count(*)::int AS count FROM "Assessment" WHERE family='email_link' AND origin IS NOT NULL`,
          )
        ).rows[0].count,
      ).toBe(2);
      const outcome = (
        await client.query(
          `SELECT verdict,correction FROM "Feedback" WHERE "assessmentId"=$1`,
          [suggestion],
        )
      ).rows[0];
      expect(outcome).toEqual({
        verdict: "wrong",
        correction: { present: true, value: null },
      });
      expect(
        (
          await client.query(
            `SELECT suppression FROM "AssessmentState" WHERE id=$1`,
            [suggestion],
          )
        ).rows[0].suppression.scope,
      ).toBe("field_value");
      expect(
        (
          await client.query(
            `SELECT roster FROM "EmailAccuracyEvaluation" WHERE id=$1`,
            [evaluation],
          )
        ).rows[0].roster,
      ).toEqual(roster);
      expect(
        (
          await client.query(
            `SELECT target,snapshot FROM "AiEvaluation" WHERE "workKey"='synthetic-work'`,
          )
        ).rows[0],
      ).toEqual({
        target: {
          kind: "field",
          entity: "product",
          recordId: product,
          field: "notes",
          assessmentIds: [suggestion],
        },
        snapshot: { assessmentIds: [suggestion] },
      });
      expect(
        (
          await client.query(
            `SELECT "confirmedValue",fingerprint FROM "AssessmentState" WHERE family='image_description'`,
          )
        ).rows[0],
      ).toEqual({
        confirmedValue: { present: true, value: "Confirmed synthetic lamp" },
        fingerprint: null,
      });
      expect(
        (
          await client.query(
            `SELECT verdict FROM "Feedback" JOIN "Assessment" a ON a.id="Feedback"."assessmentId" WHERE a.family='product_pair'`,
          )
        ).rows[0].verdict,
      ).toBe("ungraded");
      await expect(
        client.query(`UPDATE "Assessment" SET judgment='{}' WHERE id=$1`, [
          suggestion,
        ]),
      ).rejects.toThrow(/immutable/);
      for (const table of [
        ...originTables.filter(
          (table) => table !== "EmailClassificationObservation",
        ),
        "EmailClassificationLabel",
        "EmailAccuracyGrade",
        "OrderMailCandidateDecision",
      ])
        expect(
          (
            await client.query(`SELECT to_regclass($1) AS table`, [
              `"${table}"`,
            ])
          ).rows[0].table,
        ).toBeNull();
    } finally {
      await client.end();
    }
  } finally {
    if (created) await admin.query(`DROP DATABASE "${name}" WITH (FORCE)`);
    await admin.end();
  }
});
