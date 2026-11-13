import type { Client } from "pg";

/** Synthetic identities, never copied from household records. */
export const cutoverId = (n: number) =>
  `10000000-0000-4000-8000-${String(n).padStart(12, "0")}`;

export async function seedCutoverPredecessor(client: Client): Promise<void> {
  await client.query(
    `INSERT INTO "user" (id,name,email) VALUES ('synthetic-cutover','Synthetic member','cutover@example.invalid')`,
  );
  await client.query(
    `INSERT INTO "ExternalSource" (slug,label) VALUES ('synthetic','Synthetic source'),('synthetic-other','Synthetic other source')`,
  );
  const identities = [
    [1, "vendor", "VND-CUTOVER"],
    [2, "financialAccount", "FAC-CUTOVER"],
    [3, "financialTransaction", "FTX-CUTOVER"],
    [4, "purchase", "PUR-CUTONE"],
    [5, "purchase", "PUR-CUTTWO"],
    [6, "purchase", "PUR-CUTOLD"],
    [7, "expense", "EXP-CUTONE"],
    [8, "expense", "EXP-CUTCREDIT"],
    [9, "expense", "EXP-CUTDELETED"],
    [10, "ledgerParty", "PTY-CUTONE"],
    [11, "ledgerParty", "PTY-CUTTWO"],
    [12, "ledgerTransfer", "LTX-CUTOVER"],
    [13, "product", "PRD-CUTOVER"],
    [14, "run", "RUN-CUTOVER"],
    [15, "shipment", "SHP-CUTOVER"],
    [16, "email", "EML-CUTOVER"],
    [17, "sourceOccurrence", "SOC-CUTOVER"],
    [18, "sourceOccurrence", "SOC-CUTEMPTY"],
    [19, "sourceTransactionRecord", "STR-CUTOVER"],
    [23, "transactionImport", "IMP-CUTOVER"],
    [56, "financialTransaction", "FTX-OTHER"],
    [62, "purchase", "PUR-LEGACYEMAIL"],
    [63, "sourceOccurrence", "SOC-OTHERSOURCE"],
    [66, "sourceTransactionRecord", "STR-OTHERSOURCE"],
  ];
  // Prefixes come from the declared registry; raw predecessor fixtures bypass writers.
  const { SHORTCODE_PREFIX } = await import("@cubby/shared");
  for (const [n, kind] of identities) {
    const prefix = Object.entries(SHORTCODE_PREFIX).find(
      ([k]) => k === kind,
    )?.[1];
    await client.query(
      `INSERT INTO "Entity" (id,kind,shortcode) VALUES ($1,$2,$3)`,
      [
        cutoverId(Number(n)),
        kind,
        `${prefix}${String(n).replace(/0/g, "A").replace(/1/g, "B").padStart(5, "Z")}`,
      ],
    );
  }
  await client.query(
    `INSERT INTO "Vendor" (id,shortcode,name) SELECT id,shortcode,'Synthetic shop' FROM "Entity" WHERE id=$1`,
    [cutoverId(1)],
  );
  await client.query(
    `INSERT INTO "FinancialAccount" (id,shortcode,name,identity) SELECT id,shortcode,'Synthetic account','{"kind":"bank"}' FROM "Entity" WHERE id=$1`,
    [cutoverId(2)],
  );
  await client.query(
    `INSERT INTO "FinancialTransaction" (id,shortcode,"accountId",kind,status,"amountMinor","transactionDate","postedDate") SELECT id,shortcode,$2,'purchase','posted',10000,'2026-01-02','2026-01-03' FROM "Entity" WHERE id=$1`,
    [cutoverId(3), cutoverId(2)],
  );
  await client.query(
    `INSERT INTO "FinancialTransaction" (id,shortcode,"accountId",kind,status,"amountMinor","transactionDate","postedDate") SELECT id,shortcode,$2,'purchase','posted',2000,'2026-02-02','2026-02-03' FROM "Entity" WHERE id=$1`,
    [cutoverId(56), cutoverId(2)],
  );
  await client.query(
    `INSERT INTO "Purchase" (id,shortcode,"vendorId",date,"statedTotalMinor") SELECT id,shortcode,$1,'2026-01-02',CASE WHEN id=$2 THEN 6000 ELSE 4000 END FROM "Entity" WHERE id IN ($2,$3,$4)`,
    [cutoverId(1), cutoverId(4), cutoverId(5), cutoverId(6)],
  );
  await client.query(
    `INSERT INTO "Purchase" (id,shortcode,"vendorId",date,"statedTotalMinor") SELECT id,shortcode,$2,'2026-01-02',0 FROM "Entity" WHERE id=$1`,
    [cutoverId(62), cutoverId(1)],
  );
  await client.query(
    `UPDATE "Entity" SET "deletedAt"='2026-01-04',"mergedIntoId"=$1 WHERE id=$2`,
    [cutoverId(4), cutoverId(6)],
  );
  await client.query(
    `UPDATE "Purchase" SET "deletedAt"='2026-01-04' WHERE id=$1`,
    [cutoverId(6)],
  );
  await client.query(
    `INSERT INTO "Expense" (id,shortcode,name,"costMinor",date,"costType","purchaseId","deletedAt") SELECT id,shortcode,'Synthetic line',CASE WHEN id=$1 THEN 6000 WHEN id=$2 THEN -1000 ELSE 123 END,'2026-01-02','materials',$4,CASE WHEN id=$3 THEN '2026-01-04'::timestamp END FROM "Entity" WHERE id IN ($1,$2,$3)`,
    [cutoverId(7), cutoverId(8), cutoverId(9), cutoverId(4)],
  );
  await client.query(
    `INSERT INTO "FinancialTransactionAllocation" (id,"transactionId","purchaseId","amountMinor") VALUES ($1,$3,$4,6000),($2,$3,$5,3000)`,
    [cutoverId(20), cutoverId(21), cutoverId(3), cutoverId(4), cutoverId(5)],
  );
  await client.query(
    `INSERT INTO "LedgerParty" (id,shortcode,name,kind) SELECT id,shortcode,'Synthetic party','guest' FROM "Entity" WHERE id IN ($1,$2)`,
    [cutoverId(10), cutoverId(11)],
  );
  await client.query(
    `INSERT INTO "ExpenseAttribution" (id,"expenseId",role,"ledgerPartyId",weight) VALUES ($1,$2,'beneficiary',$3,1)`,
    [cutoverId(22), cutoverId(7), cutoverId(10)],
  );
  await client.query(
    `UPDATE "Purchase" SET "purchaserOverrideId"=$1 WHERE id=$2`,
    [cutoverId(10), cutoverId(4)],
  );
  await client.query(
    `INSERT INTO "LedgerTransfer" (id,shortcode,"fromPartyId","toPartyId","amountMinor",date) SELECT id,shortcode,$2,$3,1000,'2026-01-02' FROM "Entity" WHERE id=$1`,
    [cutoverId(12), cutoverId(10), cutoverId(11)],
  );
  await client.query(
    `INSERT INTO "Product" (id,shortcode,name) SELECT id,shortcode,'Synthetic product' FROM "Entity" WHERE id=$1`,
    [cutoverId(13)],
  );
  await client.query(
    `INSERT INTO "Run" (id,shortcode,"actorName","actorUserId","actorEmail",purpose,trigger,status) SELECT id,shortcode,'Synthetic member','synthetic-cutover','cutover@example.invalid','ai_refresh','manual','completed' FROM "Entity" WHERE id=$1`,
    [cutoverId(14)],
  );
  // Null authority = held; exact automatic = Cubby; disagreement = held with unknown actor.
  await client.query(
    `INSERT INTO "AuditLog" (id,"entityKind","entityId",action,changes,"userId",authority,"createdAt") VALUES
   ($1,'product',$4,'update','{"brandId":{"from":null,"to":null}}','synthetic-cutover',null,'2026-01-01'),
   ($2,'product',$4,'update','{"categoryId":{"from":null,"to":null}}','synthetic-cutover','automatic','2026-01-02'),
   ($3,'product',$4,'update','{"ingredientId":{"from":null,"to":"10000000-0000-4000-8000-000000000099"}}','synthetic-cutover','automatic','2026-01-03')`,
    [cutoverId(30), cutoverId(31), cutoverId(32), cutoverId(13)],
  );
  await client.query(
    `INSERT INTO "AuditLog" (id,"entityKind","entityId",action,changes,"userId",authority,"createdAt") VALUES ($1,'product',$2,'update','{"categoryId":{"from":null,"to":"10000000-0000-4000-8000-000000000099"}}','synthetic-cutover',null,'2026-01-01')`,
    [cutoverId(33), cutoverId(13)],
  );
  await client.query(
    `INSERT INTO "AuditLog" (id,"entityKind","entityId",action,changes,"userId",authority,"createdAt") VALUES
    ($1,'financialTransaction',$3,'update','{"notes":{"from":null,"to":"Synthetic old member note"}}','synthetic-cutover',null,'2026-01-01'),
    ($2,'financialTransaction',$3,'update','{"notes":{"from":"Synthetic old member note","to":null}}','synthetic-cutover','automatic','2026-01-02')`,
    [cutoverId(34), cutoverId(35), cutoverId(56)],
  );
  await client.query(
    `INSERT INTO "AuditLog" (id,"entityKind","entityId",action,changes,"userId",authority,"createdAt") VALUES
    ($1,'financialTransaction',$3,'update','{"amount":{"from":null,"to":19}}','synthetic-cutover',null,'2026-01-01'),
    ($2,'financialTransaction',$3,'update','{"amount":{"from":19,"to":20}}','synthetic-cutover','automatic','2026-01-02')`,
    [cutoverId(36), cutoverId(37), cutoverId(56)],
  );
  for (const [n, result, attempts] of [
    [40, { paid: "retained" }, 1],
    [41, null, 1],
    [42, null, 0],
  ]) {
    await client.query(
      `INSERT INTO "AiEvaluation" (id,"runId","workKey",feature,target,provenance,snapshot,state,result,attempts) VALUES ($1,$2,$3,'field_suggest',$4,'{}','{"legacyInput":true}','queued',$5,$6)`,
      [
        cutoverId(Number(n)),
        cutoverId(14),
        `synthetic:${n}`,
        {
          kind: "field",
          entity: "product",
          recordId: cutoverId(13),
          field: `synthetic${n}`,
        },
        result,
        attempts,
      ],
    );
  }
  const { FIELD_SUGGESTION_FEATURE } =
    await import("../src/server/ai/policy/features");
  for (const n of [69, 79])
    await client.query(
      `INSERT INTO "AiEvaluation" (id,"runId","workKey",feature,target,provenance,snapshot,state,attempts) VALUES ($1,$2,$3,'field_suggest',$4,$5,$6,'queued',0)`,
      [
        cutoverId(n),
        cutoverId(14),
        `synthetic:complete:${n}`,
        {
          kind: "field",
          entity: "product",
          recordId: cutoverId(13),
          field: `ready${n}`,
        },
        { promptVersion: FIELD_SUGGESTION_FEATURE.promptVersion },
        {
          modelInput: {
            kind: "choice",
            model: FIELD_SUGGESTION_FEATURE.model,
            subject: 'Synthetic subject with spaces, brackets [] and quotes "',
            rules: "Synthetic rules",
            choices: ["A", "B"],
            allowNone: true,
          },
        },
      ],
    );
  await client.query(
    `UPDATE "AiEvaluation" SET "leaseToken"=$1,"leaseUntil"=now()+interval '1 hour' WHERE id=$2`,
    [cutoverId(61), cutoverId(41)],
  );
  await client.query(
    `INSERT INTO "AiEvaluationRequest" (id,"evaluationId","runId",receipt,sequence) VALUES ($1,$2,$3,'{"retained":"requester"}',7)`,
    [cutoverId(43), cutoverId(40), cutoverId(14)],
  );
  await client.query(
    `INSERT INTO "AiAnalysis" (id,"entityKind","entityId",feature,model,"promptVersion","inputFingerprint",result,"deletedAt") VALUES ($1,'product',$2,'synthetic-analysis','synthetic-model','synthetic-v1','synthetic-input','{"paid":"analysis"}','2026-01-03')`,
    [cutoverId(44), cutoverId(13)],
  );
  await client.query(
    `INSERT INTO "Suggestion" (id,"publicationKey",family,subject,judgment,entity,"recordId",field,"suggestedValue",model,decisions) VALUES ($1,'synthetic:review','field','{}','{}','product',$2,'brandId','null','synthetic-model',$3)`,
    [
      cutoverId(45),
      cutoverId(13),
      JSON.stringify([
        {
          id: cutoverId(46),
          operationId: "synthetic-review",
          verdict: "correct",
          correction: { present: true, value: null },
          intent: "apply",
          authority: "member",
          actorUserId: "synthetic-cutover",
          createdAt: "2026-01-01T00:00:00.000Z",
        },
      ]),
    ],
  );
  // A corrected proposal vetoes its old candidate independently. A dismissal
  // retains its suppression even when no embedded event survives.
  await client.query(
    `INSERT INTO "Suggestion" (id,"publicationKey",family,subject,judgment,entity,"recordId",field,"suggestedValue",model,decisions,active,status) VALUES ($1,'synthetic:correction','field','{}','{}','product',$2,'brandId','"synthetic-proposal"','synthetic-model',$3,false,'applied')`,
    [
      cutoverId(47),
      cutoverId(13),
      JSON.stringify([
        {
          id: cutoverId(49),
          operationId: "synthetic-correction",
          verdict: "correct",
          correction: { present: true, value: "synthetic-correction" },
          intent: "apply",
          authority: "member",
          actorUserId: "synthetic-cutover",
          createdAt: "2026-01-02T00:00:00.000Z",
        },
      ]),
    ],
  );
  await client.query(
    `INSERT INTO "Suggestion" (id,"publicationKey",family,subject,judgment,entity,"recordId",field,"suggestedValue",model,suppression,active,status) VALUES ($1,'synthetic:suppression','field','{}','{}','product',$2,'brandId','"synthetic-dismissed"','synthetic-model','{"scope":"field","candidateKey":"synthetic-dismissed"}',false,'rejected')`,
    [cutoverId(48), cutoverId(13)],
  );
  await client.query(
    `INSERT INTO "Shipment" (id,shortcode,name,"purchaseId") SELECT id,shortcode,'Synthetic package',$2 FROM "Entity" WHERE id=$1`,
    [cutoverId(15), cutoverId(4)],
  );
  await client.query(
    `INSERT INTO "Email" (id,shortcode,"ledgerPartyId","mailboxId","messageId",checksum,status) SELECT id,shortcode,$2,'synthetic@example.invalid','synthetic-message','synthetic-checksum','pending' FROM "Entity" WHERE id=$1`,
    [cutoverId(16), cutoverId(10)],
  );
  await client.query(
    `INSERT INTO "EmailPurchaseDecision" (id,"eventId","purchaseId",decision,"evidenceChecksum","decidedByUserId",authority,"originalId","emailId") VALUES ($1,$2,$3,'linked','synthetic-checksum','synthetic-cutover','member',$4,$4)`,
    [cutoverId(50), cutoverId(51), cutoverId(4), cutoverId(16)],
  );
  await client.query(
    `INSERT INTO "EmailReview" (id,family,"subjectId","emailId","operationId",verdict,correction,intent,authority,"actorUserId",subject) VALUES ($1,'email_link',$2,$3,'synthetic-review','correct','{"present":false}','apply','member','synthetic-cutover','{}')`,
    [cutoverId(52), cutoverId(50), cutoverId(16)],
  );
  await client.query(
    `INSERT INTO "EmailFinancialAssociation" (id,"emailId","evidenceChecksum","transactionId","reviewedAccountId","sourceAccountLabel","reviewReason","decidedByUserId") VALUES ($1,$2,'synthetic-checksum',$3,$4,'Synthetic account','Synthetic review','synthetic-cutover')`,
    [cutoverId(53), cutoverId(16), cutoverId(3), cutoverId(2)],
  );
  await client.query(
    `INSERT INTO "SourceOccurrence" (id,shortcode,source,"identityKind","identityScope","identityProof","acceptedTransactionId","accountId") SELECT id,shortcode,'synthetic','legacy','synthetic','{}',CASE WHEN id=$1 THEN $3::uuid END,$4 FROM "Entity" WHERE id IN ($1,$2)`,
    [cutoverId(17), cutoverId(18), cutoverId(3), cutoverId(2)],
  );
  await client.query(
    `INSERT INTO "SourceOccurrence" (id,shortcode,source,"identityKind","identityScope","identityProof","acceptedTransactionId","accountId") SELECT id,shortcode,'synthetic-other','legacy','synthetic-other','{}',$2,$3 FROM "Entity" WHERE id=$1`,
    [cutoverId(63), cutoverId(3), cutoverId(2)],
  );
  await client.query(
    `INSERT INTO "Suggestion" (id,"publicationKey",family,subject,judgment,entity,"recordId",field,"suggestedValue",model,decisions) VALUES ($1,'synthetic:kept-transfer','transfer_pair','{}','{}','financialTransaction',$3,'','{}','synthetic-model','[]'),($2,'synthetic:kept-product','product_pair','{}','{}','product',$4,'','{}','synthetic-model','[]')`,
    [cutoverId(64), cutoverId(65), cutoverId(3), cutoverId(13)],
  );
  await client.query(
    `INSERT INTO "TransactionImport" (id,shortcode,source,label,fingerprint) SELECT id,shortcode,'synthetic','Synthetic statement','synthetic-fingerprint' FROM "Entity" WHERE id=$1`,
    [cutoverId(23)],
  );
  await client.query(
    `INSERT INTO "SourceTransactionRecord" (id,shortcode,"occurrenceId","factFingerprint","batchId",source,"accountDescriptor","statementDate","amountMinor","providerAmountMinor","rawDescription") SELECT id,shortcode,$2,'synthetic-fact',$3,'synthetic','Synthetic account','2026-01-02',10000,10000,'Synthetic statement row' FROM "Entity" WHERE id=$1`,
    [cutoverId(19), cutoverId(17), cutoverId(23)],
  );
  await client.query(
    `UPDATE "SourceOccurrence" SET "currentObservationId"=$1 WHERE id=$2`,
    [cutoverId(19), cutoverId(17)],
  );
  await client.query(
    `INSERT INTO "SourceTransactionRecord" (id,shortcode,"occurrenceId","factFingerprint","batchId",source,"accountDescriptor","statementDate","amountMinor","providerAmountMinor","rawDescription") SELECT id,shortcode,$2,'synthetic-other-fact',$3,'synthetic-other','Synthetic account','2026-01-02',10000,10000,'Synthetic same transaction from another source' FROM "Entity" WHERE id=$1`,
    [cutoverId(66), cutoverId(63), cutoverId(23)],
  );
  await client.query(
    `UPDATE "SourceOccurrence" SET "currentObservationId"=$1 WHERE id=$2`,
    [cutoverId(66), cutoverId(63)],
  );
  await client.query(
    `INSERT INTO "Suggestion" (id,"publicationKey",family,subject,judgment,entity,"recordId",field,"suggestedValue",model,decisions,active,status,data) VALUES ($1,'synthetic:statement-application','statement_transaction','{}','{}','sourceTransactionRecord',$2,'',$3,'synthetic-model',$4,false,'applied',$5)`,
    [
      cutoverId(54),
      cutoverId(19),
      JSON.stringify({
        kind: "statement_transaction",
        action: "book",
        kindOverride: "purchase",
        booking: {
          reviewedVendorName: "Synthetic shop",
          costType: "materials",
        },
        rejectedCandidateIds: [cutoverId(56)],
      }),
      JSON.stringify([
        {
          id: cutoverId(55),
          operationId: "synthetic-book",
          verdict: "correct",
          correction: { present: false },
          intent: "apply",
          authority: "member",
          actorUserId: "synthetic-cutover",
          createdAt: "2026-01-05T00:00:00.000Z",
        },
      ]),
      { accountId: cutoverId(2) },
    ],
  );
  await client.query(
    `INSERT INTO "SourceObservationAnnotation" ("observationId","accountId",notes) VALUES ($1,$2,'Synthetic member note')`,
    [cutoverId(19), cutoverId(2)],
  );
  for (const [n, target, verdict] of [
    [67, 4, "correct"],
    [68, 5, "wrong"],
  ]) {
    await client.query(
      `INSERT INTO "Suggestion" (id,"publicationKey",family,subject,judgment,entity,"recordId",field,"suggestedValue",model,evidence,decisions) SELECT $1,$2,'recommendation',jsonb_build_object('kind','recommendation','entity','email','recordId',$3::text,'scope','connection.email-purchase','candidateKey',$2::text),'{}','email',$3::uuid,'','null','rule',jsonb_build_object('candidate',jsonb_build_object('relation','email-purchase','source',jsonb_build_object('entityKind','email','entityId',src.shortcode),'target',jsonb_build_object('entityKind','purchase','entityId',dst.shortcode))),$5 FROM "Entity" src CROSS JOIN "Entity" dst WHERE src.id=$3::uuid AND dst.id=$4::uuid`,
      [
        cutoverId(Number(n)),
        `synthetic:connection:${n}`,
        cutoverId(16),
        cutoverId(Number(target)),
        JSON.stringify([
          {
            verdict,
            correction: { present: false },
            intent: "apply",
            authority: "member",
            actorUserId: "synthetic-cutover",
            createdAt: "2026-01-06T00:00:00.000Z",
          },
        ]),
      ],
    );
  }
}

/** Real runner input, with only an unapplied cutover edited for fault injection. */
export async function withCutoverMigration<T>(
  sql: string,
  work: (folder: string) => Promise<T>,
): Promise<T> {
  const { mkdtemp, readdir, mkdir, copyFile, writeFile, rm } =
    await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { MIGRATIONS_FOLDER } = await import("./db-migrate");
  const folder = await mkdtemp(join(tmpdir(), "cubby-cutover-fault-"));
  try {
    for (const entry of await readdir(MIGRATIONS_FOLDER, {
      withFileTypes: true,
    })) {
      if (entry.isDirectory() && /^\d{14}_/.test(entry.name)) {
        await mkdir(join(folder, entry.name));
        await copyFile(
          join(MIGRATIONS_FOLDER, entry.name, "migration.sql"),
          join(folder, entry.name, "migration.sql"),
        );
      }
    }
    await writeFile(
      join(folder, "20261113185531_accepted_input_cutover", "migration.sql"),
      sql,
    );
    return await work(folder);
  } finally {
    await rm(folder, { recursive: true, force: true });
  }
}
