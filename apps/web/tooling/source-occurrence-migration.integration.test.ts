import { drizzle } from "drizzle-orm/node-postgres";
import { expect, it } from "vitest";
import { sourceTransactionRecordOccurrenceId } from "../src/server/domains/transaction-import/repo/source-transaction-record-identity";
import { migrateDatabase } from "./db-migrate";
import { withMigrationDatabase } from "./test-database-lease";

// The predecessor includes equal genuine positions, scoped revisions, missing proof,
// ambiguous ownership and a deleted frontier. All original evidence must survive.
it("promotes only proven occurrence identity and retains unresolved history without money effects", async () => {
  await withMigrationDatabase(async (client) => {
    const db = drizzle(client);
    await migrateDatabase(db, { through: "0097_ledger_transfer_minor_units" });
    await client.query(
      `INSERT INTO "ExternalSource" (slug,label) VALUES ('monarch','Synthetic bank')`,
    );
    const batchId = "00000000-0000-4000-8000-000000000101";
    await client.query(
      `INSERT INTO "Entity" (id,kind,shortcode) VALUES ($1,'transactionImport','TIM-ABCDE')`,
      [batchId],
    );
    await client.query(
      `INSERT INTO "TransactionImport" (id,shortcode,source,label,fingerprint) VALUES ($1,'TIM-ABCDE','monarch','Synthetic collection','synthetic-original')`,
      [batchId],
    );
    const accountId = "00000000-0000-4000-8000-000000000102";
    const transactionIds = [
      "00000000-0000-4000-8000-000000000103",
      "00000000-0000-4000-8000-000000000104",
    ];
    await client.query(
      `INSERT INTO "Entity" (id,kind,shortcode) VALUES ($1,'financialAccount','FAC-ABCDE')`,
      [accountId],
    );
    await client.query(
      `INSERT INTO "FinancialAccount" (id,shortcode,name,identity) VALUES ($1,'FAC-ABCDE','Synthetic cash','{"kind":"cash"}')`,
      [accountId],
    );
    for (const [index, id] of transactionIds.entries()) {
      await client.query(
        `INSERT INTO "Entity" (id,kind,shortcode) VALUES ($1,'financialTransaction',$2)`,
        [id, `FTX-ABCDE${index}`],
      );
      await client.query(
        `INSERT INTO "FinancialTransaction" (id,shortcode,"accountId",kind,status,amount) VALUES ($1,$2,$3,'purchase','observed',10.01)`,
        [id, `FTX-ABCDE${index}`, accountId],
      );
    }
    const evidence = [
      {
        pos: 1,
        provider: null,
        account: null,
        data: null,
        current: true,
        deleted: false,
        note: "First identical genuine row",
      },
      {
        pos: 2,
        provider: null,
        account: null,
        data: null,
        current: true,
        deleted: false,
        note: "Second identical genuine row",
      },
      {
        pos: 3,
        provider: "synthetic-event",
        account: "synthetic-account",
        data: {
          transaction: {
            id: "synthetic-event",
            account_id: "synthetic-account",
          },
          account: { id: "synthetic-account" },
        },
        current: false,
        deleted: false,
        note: "Original annotation",
      },
      {
        pos: 4,
        provider: "synthetic-event",
        account: "synthetic-account",
        data: { id: "synthetic-event", account_id: "synthetic-account" },
        current: true,
        deleted: false,
        note: "Later annotation",
      },
      {
        pos: null,
        provider: null,
        account: null,
        data: null,
        current: true,
        deleted: false,
        note: "No source proof",
      },
      {
        pos: 6,
        provider: null,
        account: null,
        data: null,
        current: true,
        deleted: true,
        note: "Retired position",
      },
    ];
    for (const [index, row] of evidence.entries()) {
      const id = `00000000-0000-4000-8000-${String(index + 201).padStart(12, "0")}`;
      const code = `STR-ABCDE${index}`;
      const external =
        row.pos === null
          ? "v1:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
          : await sourceTransactionRecordOccurrenceId(
              "monarch",
              "synthetic-original",
              row.pos,
            );
      await client.query(
        `INSERT INTO "Entity" (id,kind,shortcode,"deletedAt") VALUES ($1,'sourceTransactionRecord',$2,CASE WHEN $3 THEN now() END)`,
        [id, code, row.deleted],
      );
      await client.query(
        `INSERT INTO "SourceTransactionRecord" (id,shortcode,"batchId",source,"externalId","legacyExternalId","chargeKey","rowPosition","providerTransactionId","providerAccountId","providerData","accountDescriptor","statementDate",amount,"providerAmount","rawDescription",current,notes,"deletedAt") VALUES ($1,$2,$3,'monarch',$4,'v1:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',$4,$5,$6,$7,$8,'Synthetic account','2026-01-02',10.01,-10.01,'Synthetic purchase',$9,$10,CASE WHEN $11 THEN now() END)`,
        [
          id,
          code,
          batchId,
          external,
          row.pos,
          row.provider,
          row.account,
          row.data,
          row.current,
          row.note,
          row.deleted,
        ],
      );
      if (row.provider)
        await client.query(
          `UPDATE "SourceTransactionRecord" SET "accountId"=$1,"legacyExternalId"='v1:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc' WHERE id=$2`,
          [accountId, id],
        );
      await client.query(
        `INSERT INTO "TransactionImportRecord" ("importId","statementRowId") VALUES ($1,$2)`,
        [batchId, id],
      );
    }
    const direct = await sourceTransactionRecordOccurrenceId(
      "monarch",
      "synthetic-original",
      4,
    );
    for (const [ref, index] of [
      [direct, 0],
      [
        "v1:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc",
        0,
      ],
      [
        "v1:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
        1,
      ],
    ] as const) {
      await client.query(
        `INSERT INTO "EntityExternalId" ("entityId","entityKind",source,kind,"externalId") VALUES ($1,'financialTransaction','monarch','settlement_ref',$2)`,
        [transactionIds[index], ref],
      );
    }
    await client.query(`INSERT INTO "Suggestion" ("publicationKey",family,subject,judgment,entity,data,decisions,suppression)
      VALUES ('synthetic-machine','statement_transaction','{}','{}','sourceTransactionRecord','{"source":"monarch","chargeKey":"legacy-machine"}','[]',NULL),
        ('synthetic-member','statement_transaction','{}','{}','sourceTransactionRecord','{"source":"monarch","chargeKey":"legacy-member"}','[{"action":"dismiss"}]','{"reason":"member decision"}'),
        ('synthetic-transfer','transfer_pair','{}','{"outflow":{"charge":{"source":"monarch","chargeKey":"legacy-machine"}}}','financialTransaction','{}','[]',NULL),
        ('synthetic-transaction-only','transfer_pair','{}','{"outflow":{"transactionId":"synthetic"}}','financialTransaction','{}','[]',NULL)`);
    const memberSuggestionBefore = (
      await client.query(
        `SELECT to_jsonb(s) AS row FROM "Suggestion" s WHERE "publicationKey"='synthetic-member'`,
      )
    ).rows[0].row;
    const financialBefore = (
      await client.query(
        `SELECT jsonb_agg(to_jsonb(r) ORDER BY id) AS rows FROM "FinancialTransaction" r`,
      )
    ).rows[0].rows;
    const cancelledRun = "00000000-0000-4000-8000-000000000301";
    await client.query(
      `INSERT INTO "user" (id,name,email) VALUES ('occurrence-migration','Synthetic member','occurrence@example.test')`,
    );
    await client.query(
      `INSERT INTO "Entity" (id,kind,shortcode) VALUES ($1,'run','RUN-SYNOCCURRENCE')`,
      [cancelledRun],
    );
    await client.query(
      `INSERT INTO "Run" (id,shortcode,"actorName",trigger,purpose,"actorUserId","actorEmail",status,"failureCode","endedAt") VALUES ($1,'RUN-SYNOCCURRENCE','Synthetic member','manual','sweep','occurrence-migration','occurrence@example.test','failed','user_cancelled',now())`,
      [cancelledRun],
    );
    await client.query(
      `INSERT INTO "RunStep" ("runId",key,label,position,state,cursor,done,skipped,failed,errors) VALUES ($1,'statement_generate','Synthetic cancelled scan',0,'running','{"after":"legacy-machine"}',1,2,1,'[{"ref":"legacy-machine","message":"Synthetic retained failure"}]')`,
      [cancelledRun],
    );
    await client.query(
      `INSERT INTO "Job" (key,kind,state,"runId",input) VALUES ('synthetic-occurrence-cancel','run.execute','queued',$1,'{}')`,
      [cancelledRun],
    );
    await expect(
      migrateDatabase(db, { through: "0098_source_occurrence_ownership" }),
    ).rejects.toThrow("Financial refresh has unfinished steps");
    await client.query(
      `UPDATE "Job" SET state='cancelled' WHERE key='synthetic-occurrence-cancel'`,
    );
    await client.query(
      `UPDATE "SourceTransactionRecord" SET amount=10.010000000000002,"providerAmount"=-10.010000000000002 WHERE "rowPosition"=1`,
    );
    await expect(
      migrateDatabase(db, { through: "0098_source_occurrence_ownership" }),
    ).rejects.toThrow("independent IEEE");
    expect(
      (
        await client.query(
          `SELECT to_regclass('public."SourceOccurrence"') AS owner`,
        )
      ).rows[0].owner,
    ).toBeNull();
    await client.query(
      `UPDATE "SourceTransactionRecord" SET amount=10.01,"providerAmount"=-10.01 WHERE "rowPosition"=1`,
    );
    const before = (
      await client.query(
        `SELECT jsonb_agg(to_jsonb(r) ORDER BY id) AS rows FROM "SourceTransactionRecord" r`,
      )
    ).rows[0].rows;
    await migrateDatabase(db, { through: "0098_source_occurrence_ownership" });
    expect(
      (
        await client.query(
          `SELECT state,cursor,done,skipped,failed,errors FROM "RunStep" WHERE "runId"=$1`,
          [cancelledRun],
        )
      ).rows[0],
    ).toEqual({
      state: "running",
      cursor: null,
      done: 1,
      skipped: 2,
      failed: 1,
      errors: [
        { ref: "legacy-machine", message: "Synthetic retained failure" },
      ],
    });
    expect(
      (
        await client.query(
          `SELECT cursor FROM archive."RunStep_occurrence_cursor_preimage" WHERE "runId"=$1`,
          [cancelledRun],
        )
      ).rows[0],
    ).toEqual({ cursor: { after: "legacy-machine" } });

    expect(
      (
        await client.query(
          `SELECT "publicationKey",status,active FROM "Suggestion" ORDER BY "publicationKey"`,
        )
      ).rows,
    ).toEqual([
      {
        publicationKey: "synthetic-machine",
        status: "pending",
        active: true,
      },
      { publicationKey: "synthetic-member", status: "pending", active: true },
      {
        publicationKey: "synthetic-transaction-only",
        status: "pending",
        active: true,
      },
      {
        publicationKey: "synthetic-transfer",
        status: "pending",
        active: true,
      },
    ]);
    expect(
      (
        await client.query(
          `SELECT to_jsonb(s) AS row FROM "Suggestion" s WHERE "publicationKey"='synthetic-member'`,
        )
      ).rows[0].row,
    ).toEqual(memberSuggestionBefore);
    expect(
      (
        await client.query(
          `SELECT count(*)::int AS count FROM "Suggestion" WHERE status='pending' AND active`,
        )
      ).rows[0].count,
    ).toBe(4);
    const counts = (
      await client.query(
        `SELECT count(*)::int AS observations,count("occurrenceId")::int AS proven,count(*) FILTER(WHERE "amountMinor"=1001 AND "providerAmountMinor"=-1001)::int AS exact FROM "SourceTransactionRecord"`,
      )
    ).rows[0];
    expect(counts).toEqual({ observations: 6, proven: 5, exact: 6 });
    expect(
      (
        await client.query(
          `SELECT count(*)::int AS count FROM "SourceOccurrence"`,
        )
      ).rows[0].count,
    ).toBe(4);
    expect(
      (
        await client.query(
          `SELECT jsonb_agg(to_jsonb(r) ORDER BY id) AS rows FROM archive."SourceTransactionRecord_occurrence_preimage" r`,
        )
      ).rows[0].rows,
    ).toEqual(before);
    expect(
      (
        await client.query(
          `SELECT count(*)::int AS count FROM "SourceObservationAnnotation" WHERE notes IS NOT NULL`,
        )
      ).rows[0].count,
    ).toBe(6);
    expect(
      (
        await client.query(
          `SELECT count(*)::int AS count FROM "SourceOccurrence" WHERE "acceptedTransactionId" IS NOT NULL`,
        )
      ).rows[0].count,
    ).toBe(1);
    expect(
      (
        await client.query(
          `SELECT count(*)::int AS count FROM "FinancialEvidenceAlias" WHERE "provenanceKey" LIKE 'binding:%'`,
        )
      ).rows[0].count,
    ).toBe(3);
    expect(
      (
        await client.query(
          `SELECT jsonb_agg(to_jsonb(r) ORDER BY id) AS rows FROM "FinancialTransaction" r`,
        )
      ).rows[0].rows,
    ).toEqual(financialBefore);
    expect(
      (
        await client.query(
          `SELECT count(*)::int AS count FROM "SourceOccurrence" WHERE "deletedAt" IS NOT NULL AND "currentObservationId" IS NULL`,
        )
      ).rows[0].count,
    ).toBe(1);
    await expect(
      client.query(`UPDATE "SourceTransactionRecord" SET amount=99`),
    ).rejects.toThrow('column "amount"');
    await expect(
      client.query(
        `UPDATE "SourceOccurrence" owner SET "currentObservationId"=(SELECT id FROM "SourceTransactionRecord" WHERE "occurrenceId" IS DISTINCT FROM owner.id LIMIT 1)`,
      ),
    ).rejects.toThrow("SourceOccurrence_head_membership_fk");
  });
});

it("gives unproven bank records one held owner without changing evidence or financial decisions", async () => {
  await withMigrationDatabase(async (client) => {
    const db = drizzle(client);
    await migrateDatabase(db, {
      through: "0106_transaction_amount_minor_units",
    });
    await client.query(
      `INSERT INTO "ExternalSource" (slug,label) VALUES ('monarch','Synthetic bank')`,
    );
    await client.query(`INSERT INTO "Entity" (id,kind,shortcode) VALUES
      ('00000000-0000-4000-8000-000000000801','transactionImport','TIM-ZZZZZ'),
      ('00000000-0000-4000-8000-000000000802','sourceTransactionRecord','STR-ZZZZZ')`);
    await client.query(`INSERT INTO "TransactionImport" (id,shortcode,source,label,fingerprint)
      VALUES ('00000000-0000-4000-8000-000000000801','TIM-ZZZZZ','monarch','Synthetic collection','synthetic-unproven')`);
    await client.query(`INSERT INTO "SourceTransactionRecord" (id,shortcode,"batchId",source,"factFingerprint","accountDescriptor","statementDate","amountMinor","providerAmountMinor","rawDescription")
      VALUES ('00000000-0000-4000-8000-000000000802','STR-ZZZZZ','00000000-0000-4000-8000-000000000801','monarch',repeat('a',64),'Synthetic card','2026-05-04',1001,-1001,'SYNTHETIC BANK RECORD')`);
    await client.query(`INSERT INTO "SourceObservationAnnotation" ("observationId",disposition,"dispositionReason","dispositionNote",notes)
      VALUES ('00000000-0000-4000-8000-000000000802','ignored','not_modeled','Explicit financial decision','Original local note')`);
    await client.query(`INSERT INTO "TransactionImportRecord" ("importId","statementRowId") VALUES
      ('00000000-0000-4000-8000-000000000801','00000000-0000-4000-8000-000000000802')`);
    const annotations = (
      await client.query(`SELECT * FROM "SourceObservationAnnotation"`)
    ).rows;
    await client.query(`INSERT INTO "Suggestion" ("publicationKey",family,subject,judgment,entity,"recordId",active,status,fingerprint,suppression,data)
      VALUES ('synthetic-current-dismissal','statement_transaction','{}','{}','sourceTransactionRecord','00000000-0000-4000-8000-000000000802',true,'resolved',repeat('b',64),'{"scope":"statement_transaction","candidateKey":"synthetic-current","fingerprint":null}','{}'),
      ('synthetic-retired-dismissal','transfer_pair','{}','{}','sourceTransactionRecord','00000000-0000-4000-8000-000000000802',false,'resolved',repeat('c',64),'{"scope":"transfer_pair","candidateKey":"synthetic-retired","fingerprint":null}','{}')`);
    const memberships = (
      await client.query(`SELECT * FROM "TransactionImportRecord"`)
    ).rows;
    await migrateDatabase(db, {
      through: "0107_source_judgment_owner_cutover",
    });
    const { rows: owners } =
      await client.query(`SELECT o.shortcode,o."identityKind",o."reviewState",o.disposition,o."dispositionNote",o."acceptedTransactionId"
      FROM "SourceTransactionRecord" r JOIN "SourceOccurrence" o ON o.id=r."occurrenceId"`);
    expect(
      (
        await client.query(
          `SELECT "publicationKey",suppression FROM "Suggestion" ORDER BY "publicationKey"`,
        )
      ).rows,
    ).toEqual([
      {
        publicationKey: "synthetic-current-dismissal",
        suppression: {
          scope: "statement_transaction",
          candidateKey: "synthetic-current",
          fingerprint: "b".repeat(64),
        },
      },
      { publicationKey: "synthetic-retired-dismissal", suppression: null },
    ]);
    expect(owners).toEqual([
      expect.objectContaining({
        identityKind: "unproven",
        reviewState: "unproven",
        disposition: "ignored",
        dispositionNote: "Explicit financial decision",
        acceptedTransactionId: null,
        shortcode: expect.stringMatching(
          /^SOC-[23456789ABCDEFGHJKMNPQRSTUVWXYZ]{5}$/,
        ),
      }),
    ]);
    expect(
      (await client.query(`SELECT * FROM "SourceObservationAnnotation"`)).rows,
    ).toEqual(annotations);
    expect(
      (await client.query(`SELECT * FROM "TransactionImportRecord"`)).rows,
    ).toEqual(memberships);
    expect(
      (await client.query(`SELECT count(*)::int n FROM "FinancialTransaction"`))
        .rows,
    ).toEqual([{ n: 0 }]);
    await expect(
      client.query(`UPDATE "SourceOccurrence" SET "reviewState"='ready'`),
    ).rejects.toThrow(/SourceOccurrence_unproven_check/);
    await expect(
      client.query(`UPDATE "SourceTransactionRecord" SET "occurrenceId"=NULL`),
    ).rejects.toThrow(/not-null/);
    await migrateDatabase(db, {
      through: "0107_source_judgment_owner_cutover",
    });
    expect(
      (await client.query(`SELECT count(*)::int n FROM "SourceOccurrence"`))
        .rows,
    ).toEqual([{ n: 1 }]);
  });
});
