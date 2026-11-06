import { drizzle } from "drizzle-orm/node-postgres";
import { expect, it } from "vitest";

import { migrateDatabase } from "./db-migrate";
import { withMigrationDatabase } from "./test-database-lease";

// Failure modes: dropping old execution state loses a paid result or pending
// work; rebuilding projections overwrites historical evidence or review authority.
it("carries populated history and pending paid work into the unified job cutover", async () => {
  await withMigrationDatabase(async (client) => {
    const db = drizzle(client);
    await migrateDatabase(db, { through: "0003_explicit_field_publication" });
    const runId = "00000000-0000-4000-8000-000000000901";
    const assessmentId = "00000000-0000-4000-8000-000000000902";
    const evaluationId = "00000000-0000-4000-8000-000000000903";
    const productId = "00000000-0000-4000-8000-000000000904";
    const artifactId = "00000000-0000-4000-8000-000000000905";
    const imageId = "00000000-0000-4000-8000-000000000906";
    const processingId = "00000000-0000-4000-8000-000000000907";
    const oldAttemptId = "00000000-0000-4000-8000-000000000908";
    const retiredArtifactId = "00000000-0000-4000-8000-000000000912";
    const deletedProcessingId = "00000000-0000-4000-8000-000000000913";
    const retiredRunId = "00000000-0000-4000-8000-000000000914";
    const trialId = "00000000-0000-4000-8000-000000000915";
    const activeRunId = "00000000-0000-4000-8000-000000000916";
    const failedArtifactId = "00000000-0000-4000-8000-000000000918";
    const appliedFindingId = "00000000-0000-4000-8000-000000000919";
    const retiredHash = "c".repeat(64);
    const embeddingHash = "a".repeat(64);
    const vectorHash = "b".repeat(64);
    const ledgerPartyId = "00000000-0000-4000-8000-000000000909";
    const findingId = "00000000-0000-4000-8000-000000000910";
    const sampleId = "00000000-0000-4000-8000-000000000911";
    await client.query(`INSERT INTO "user" (id,name,email)
      VALUES ('synthetic-reviewer','Synthetic reviewer','synthetic-reviewer@example.test')`);
    await client.query(
      `INSERT INTO "LedgerParty" (id,shortcode,name,kind)
      VALUES ($1,'LPY-SYNTH909','Synthetic member','member')`,
      [ledgerPartyId],
    );
    await client.query(
      `INSERT INTO "Run"
      (id,shortcode,"actorName",trigger,"actorUserId","actorEmail",purpose)
      VALUES ($1,'RUN-SYNTH901','Synthetic operator','manual','synthetic-reviewer','synthetic-reviewer@example.test','background')`,
      [runId],
    );
    await client.query(
      `INSERT INTO "Product" (id,shortcode,name,manufacturer)
      VALUES ($1,'PRD-SYNTH904','Synthetic retained product','Synthetic maker')`,
      [productId],
    );
    await client.query(
      `INSERT INTO "EntityEmbedding"
      (id,"entityId","entityKind","embeddingText","embeddingHash",provider,model,dimensions,
        "artifactState","artifactHash","vectorHash","submissionId","lastError","visibilityAttempts")
      VALUES ($1,$2,'product','Synthetic retained product',$3,'openai','text-embedding-3-small',1536,
        'submitted',$3,$4,'synthetic-upload-receipt','Synthetic visibility diagnostic',2)`,
      [artifactId, productId, embeddingHash, vectorHash],
    );
    await client.query(
      `INSERT INTO "Image" (id,shortcode,key,filename,size,"contentType")
      VALUES ($1,'IMG-SYNTH906','synthetic/cutover-image','synthetic.png',100,'image/png')`,
      [imageId],
    );
    await client.query(
      `INSERT INTO "ImageProcessingJob"
      (id,shortcode,"imageId",kind,state,"sourceContentHash","processorRevision","runId",
        "attemptId","leaseExpiresAt",attempts,"failuresSinceRetry")
      VALUES ($1,'IPR-SYNTH907',$2,'describe_image','leased',$3,1,$4,$5,now()+interval '1 hour',3,1)`,
      [processingId, imageId, embeddingHash, runId, oldAttemptId],
    );
    await client.query(
      `INSERT INTO "ImageProcessingAttempt" (id,"jobId",number,state)
      VALUES ($1,$2,3,'leased')`,
      [oldAttemptId, processingId],
    );
    await client.query(
      `INSERT INTO "Assessment"
      (id,"publicationKey",family,subject,judgment,evidence)
      VALUES ($1,'synthetic-cutover-history','field',$2,'{"value":"Synthetic proposal"}',
        '{"source":"Synthetic retained evidence"}')`,
      [
        assessmentId,
        JSON.stringify({
          kind: "field",
          entity: "run",
          recordId: runId,
          field: "notes",
        }),
      ],
    );
    await client.query(
      `INSERT INTO "Feedback"
      ("assessmentId","operationId",verdict,correction,intent,authority,"actorUserId",receipt)
      VALUES ($1,'synthetic-evaluation-grade','wrong','{"present":false}','history','evaluation','synthetic-reviewer','{"retained":true}')`,
      [assessmentId],
    );
    await client.query(
      `INSERT INTO "AiEvaluation"
      (id,"runId","workKey",feature,target,provenance,snapshot,state,result,receipt,attempts,"attemptToken")
      VALUES ($1,$2,'synthetic-paid-result','synthetic-feature',$3,$4,'{}','result_ready',
        '{"answer":"Synthetic paid answer"}','{"providerReceipt":"synthetic-receipt"}',2,gen_random_uuid())`,
      [
        evaluationId,
        runId,
        JSON.stringify({
          kind: "field",
          entity: "product",
          recordId: productId,
          field: "notes",
          assessmentIds: [],
        }),
        JSON.stringify({
          dependencies: [],
          inputFingerprint: "synthetic-input",
          optionFingerprint: "synthetic-options",
          model: "synthetic-model",
        }),
      ],
    );
    await client.query(
      `INSERT INTO "DerivedRefreshWork"
      ("entityId","entityKind","inputFingerprint",state)
      VALUES ($1,'run','synthetic-input','pending')`,
      [runId],
    );
    await client.query(
      `INSERT INTO "AssessmentState"
      (id,"runId",entity,"recordId",field,family,"suggestedValue",status)
      VALUES ($1,$2,'run',$2,'notes','field','"Synthetic proposal"','pending')`,
      [assessmentId, runId],
    );
    await client.query(
      `INSERT INTO "RunFinding"
      (id,"runId","ledgerPartyId","entityId","entityKind",kind,summary,"evidenceFingerprint",status,"resolvedAt","resolvedByUserId")
      VALUES ($1,$2,$3,$2,'run','synthetic_review','Synthetic retained finding','synthetic-evidence','dismissed',now(),'synthetic-reviewer')`,
      [findingId, runId, ledgerPartyId],
    );
    await client.query(
      `INSERT INTO "EmailAccuracyEvaluation"
      (id,"ownerUserId","requestedSampleSize","populationCount","sampleSize",roster)
      VALUES ($1,'synthetic-reviewer',1,0,0,'{"version":1,"strata":[],"items":[]}')`,
      [sampleId],
    );
    await client.query(
      `INSERT INTO "EntityEmbedding"
      (id,"entityId","entityKind","embeddingText","embeddingHash",provider,model,dimensions,"artifactState","deletedAt")
      VALUES ($1,$2,'product','Synthetic former text',$3,'openai','text-embedding-3-small',1536,'retired',now())`,
      [retiredArtifactId, productId, retiredHash],
    );
    await client.query(
      `UPDATE "EntityEmbedding" SET "updatedAt"=now()+interval '1 hour' WHERE id=$1`,
      [retiredArtifactId],
    );
    await client.query(
      `INSERT INTO "EntityEmbedding"
      (id,"entityId","entityKind","embeddingText","embeddingHash",provider,model,dimensions,"artifactState","deletedAt","lastError")
      VALUES ($1,$2,'product','Synthetic former text',$3,'openai','text-embedding-3-small',1536,'failed',now(),'Synthetic failed upload')`,
      [failedArtifactId, productId, retiredHash],
    );
    await client.query(
      `INSERT INTO "RunFinding"
      (id,"runId","ledgerPartyId","entityId","entityKind",kind,summary,"evidenceFingerprint",status,"resolvedAt","resolvedByUserId","createdAt")
      VALUES ($1,$2,$3,$2,'run','synthetic_review','Synthetic applied finding','synthetic-evidence','applied',now(),'synthetic-reviewer',now()+interval '1 second')`,
      [appliedFindingId, runId, ledgerPartyId],
    );
    await client.query(
      `INSERT INTO "ImageProcessingJob"
      (id,shortcode,"imageId",kind,state,"sourceContentHash","processorRevision","deletedAt")
      VALUES ($1,'IPR-SYNTH913',$2,'describe_image','pending',$3,1,now())`,
      [deletedProcessingId, imageId, retiredHash],
    );
    await client.query(
      `INSERT INTO "Run"
      (id,shortcode,"actorName",trigger,"actorUserId","actorEmail",purpose,status,"dispatchError")
      VALUES ($1,'RUN-SYNTH914','Synthetic operator','manual','synthetic-reviewer','synthetic-reviewer@example.test','derived_refresh','running','Synthetic retained dispatch error'),
      ($2,'RUN-SYNTH916','Synthetic operator','manual','synthetic-reviewer','synthetic-reviewer@example.test','suggestion_sweep','running',NULL)`,
      [retiredRunId, activeRunId],
    );
    await client.query(
      `INSERT INTO "DerivedRefreshFailure"
      ("entityId","entityKind",phase,fingerprint,attempts,"lastError")
      VALUES ($1,'product','projection','synthetic-failure',3,'Synthetic retained SQLSTATE 08006')`,
      [productId],
    );
    await client.query(
      `UPDATE "DerivedRefreshWork" SET "lastError"='Synthetic retained checkpoint error' WHERE "entityId"=$1`,
      [runId],
    );
    await client.query(
      `INSERT INTO "Assessment"
      (id,"publicationKey",family,subject,judgment,served)
      VALUES ($1,'synthetic-unserved-trial','field',jsonb_build_object('kind','field','entity','run','recordId',$2::text,'field','notes'),'{"value":"Synthetic unserved proposal"}',false)`,
      [trialId, runId],
    );
    await client.query(
      `INSERT INTO "AssessmentState"
      (id,entity,"recordId",field,family,status,"pairKey")
      VALUES ($1,'run',$2,'notes','field','pending','00000000-0000-4000-8000-000000000917')`,
      [trialId, runId],
    );
    const history = (
      await client.query('SELECT * FROM "Assessment" WHERE id=$1', [
        assessmentId,
      ])
    ).rows;
    const feedback = (
      await client.query('SELECT * FROM "Feedback" WHERE "assessmentId"=$1', [
        assessmentId,
      ])
    ).rows;

    // Source identity migration must preserve dismissed ownership while keeping
    // coexisting ID-less physical occurrences independently actionable.
    const evidenceImportId = "00000000-0000-4000-8000-000000000980";
    const evidenceRowId = "00000000-0000-4000-8000-000000000981";
    const evidenceTwinId = "00000000-0000-4000-8000-000000000982";
    const evidenceAssessmentId = "00000000-0000-4000-8000-000000000983";
    const legacyRef = `v1:${"a".repeat(64)}`;
    const observationRef = `v2:${"b".repeat(64)}`;
    const twinRef = `v2:${"c".repeat(64)}`;
    await client.query(
      `INSERT INTO "ExternalSource" (slug,label) VALUES ('synthetic-bank','Synthetic bank')`,
    );
    await client.query(
      `INSERT INTO "StatementImport" (id,source,label,fingerprint) VALUES ($1,'synthetic-bank','Synthetic retained collection','synthetic-retained-collection')`,
      [evidenceImportId],
    );
    for (const [id, ref, position] of [
      [evidenceRowId, observationRef, 1],
      [evidenceTwinId, twinRef, 2],
    ]) {
      await client.query(
        `INSERT INTO "StatementRow" (id,"batchId",source,"externalId","legacyExternalId","rowPosition","accountDescriptor","statementDate",amount,"providerAmount","rawDescription") VALUES ($1,$2,'synthetic-bank',$3,$4,$5,'Synthetic account','2026-05-01',25,-25,'SYNTHETIC SAME PURCHASE')`,
        [id, evidenceImportId, ref, legacyRef, position],
      );
    }
    await client.query(
      `INSERT INTO "Assessment" (id,"publicationKey",family,subject,judgment,evidence) VALUES ($1,'synthetic-evidence-suppression','statement_transaction',$2,'{}','{}')`,
      [
        evidenceAssessmentId,
        JSON.stringify({
          kind: "statement_transaction",
          recordId: evidenceRowId,
          source: "synthetic-bank",
          chargeKey: legacyRef,
        }),
      ],
    );
    await client.query(
      `INSERT INTO "AssessmentState" (id,entity,"recordId",family,status,data,suppression) VALUES ($1,'statementRow',$2,'statement_transaction','rejected',$3,'{"reason":"synthetic-dismissal"}')`,
      [
        evidenceAssessmentId,
        evidenceRowId,
        JSON.stringify({ source: "synthetic-bank", chargeKey: legacyRef }),
      ],
    );
    const retainedEvidence = (
      await client.query(
        `SELECT id,"externalId","legacyExternalId","rowPosition",amount,"providerAmount",disposition FROM "StatementRow" ORDER BY id`,
      )
    ).rows;

    await migrateDatabase(db, { through: "0005_thin_blink" });

    expect(
      (
        await client.query(
          `SELECT id,"externalId","legacyExternalId","rowPosition",amount,"providerAmount",disposition FROM "StatementRow" ORDER BY id`,
        )
      ).rows,
    ).toEqual(retainedEvidence);
    expect(
      (
        await client.query(
          `SELECT "chargeKey",current,"legacyReference" FROM "StatementRow" ORDER BY id`,
        )
      ).rows,
    ).toEqual([
      { chargeKey: observationRef, current: true, legacyReference: legacyRef },
      { chargeKey: twinRef, current: true, legacyReference: null },
    ]);
    expect(
      (
        await client.query(
          `SELECT status,active,suppression,data->>'chargeKey' AS owner FROM "AssessmentState" WHERE id=$1`,
          [evidenceAssessmentId],
        )
      ).rows,
    ).toEqual([
      {
        status: "rejected",
        active: false,
        suppression: { reason: "synthetic-dismissal" },
        owner: observationRef,
      },
    ]);
    expect(
      (
        await client.query(
          `SELECT count(*)::int AS count FROM "StatementImportRow" WHERE "importId"=$1`,
          [evidenceImportId],
        )
      ).rows,
    ).toEqual([{ count: 2 }]);
    expect(
      (
        await client.query(
          `SELECT "completedAt" FROM "StatementImport" WHERE id=$1`,
          [evidenceImportId],
        )
      ).rows,
    ).toEqual([{ completedAt: null }]);

    expect(
      (
        await client.query('SELECT * FROM "Assessment" WHERE id=$1', [
          assessmentId,
        ])
      ).rows,
    ).toEqual(history.map((row) => ({ ...row, projection: null })));
    expect(
      (
        await client.query(
          'SELECT * FROM "Feedback" WHERE "assessmentId"=$1 AND authority=\'evaluation\'',
          [assessmentId],
        )
      ).rows,
    ).toEqual(feedback.map((row) => ({ ...row, projection: null })));
    expect(
      (
        await client.query(
          'SELECT authority,projection FROM "Feedback" WHERE "assessmentId"=$1 AND "operationId"=$2',
          [assessmentId, "legacy-projection"],
        )
      ).rows,
    ).toEqual([
      {
        authority: "unknown",
        projection: expect.objectContaining({
          status: "pending",
          suggestedValue: "Synthetic proposal",
        }),
      },
    ]);
    expect(
      (
        await client.query(
          'SELECT family,status,"ledgerPartyId" FROM "AssessmentState" WHERE id=$1',
          [findingId],
        )
      ).rows,
    ).toEqual([{ family: "run_finding", status: "rejected", ledgerPartyId }]);
    expect(
      (
        await client.query(
          'SELECT authority,"actorUserId",verdict FROM "Feedback" WHERE "assessmentId"=$1 AND authority=$2',
          [findingId, "member"],
        )
      ).rows,
    ).toEqual([
      {
        authority: "member",
        actorUserId: "synthetic-reviewer",
        verdict: "dismissed",
      },
    ]);
    expect(
      (
        await client.query(
          'SELECT family,served,judgment FROM "Assessment" WHERE id=$1',
          [sampleId],
        )
      ).rows,
    ).toEqual([
      {
        family: "evaluation_sample",
        served: false,
        judgment: { version: 1, strata: [], items: [] },
      },
    ]);
    expect(
      (
        await client.query(
          'SELECT state,result,receipt FROM "AiEvaluation" WHERE id=$1',
          [evaluationId],
        )
      ).rows,
    ).toEqual([
      {
        state: "result_ready",
        result: { answer: "Synthetic paid answer" },
        receipt: { providerReceipt: "synthetic-receipt" },
      },
    ]);
    expect(
      (
        await client.query('SELECT kind,state,input FROM "Job" WHERE key=$1', [
          `ai-evaluation:${evaluationId}`,
        ])
      ).rows,
    ).toEqual([
      {
        kind: "ai.evaluation",
        state: "queued",
        input: { evaluationId },
      },
    ]);
    expect(
      (
        await client.query(
          'SELECT 1 FROM "Job" WHERE kind=$1 AND state=$2 LIMIT 1',
          ["refresh.family", "queued"],
        )
      ).rowCount,
    ).toBe(1);
    expect(
      (
        await client.query(
          'SELECT kind,state,input,"runId","leaseToken" FROM "Job" WHERE key=$1',
          [`image-processing:${processingId}`],
        )
      ).rows,
    ).toEqual([
      {
        kind: "image.processing",
        state: "queued",
        input: { processingId },
        runId,
        leaseToken: null,
      },
    ]);
    expect(
      (
        await client.query(
          'SELECT "attemptId",attempts FROM "ImageProcessingJob" WHERE id=$1',
          [processingId],
        )
      ).rows,
    ).toEqual([{ attemptId: oldAttemptId, attempts: 3 }]);
    expect(
      (
        await client.query(
          'SELECT id,number FROM "ImageProcessingAttempt" WHERE id=$1',
          [oldAttemptId],
        )
      ).rows,
    ).toEqual([{ id: oldAttemptId, number: 3 }]);
    expect(
      (
        await client.query(
          'SELECT id,kind,input,cursor,result FROM "Job" WHERE key=$1',
          [`embedding:product:${productId}:${embeddingHash}`],
        )
      ).rows,
    ).toEqual([
      {
        id: artifactId,
        kind: "embedding.refresh",
        input: {
          entityKind: "product",
          entityId: productId,
          hash: embeddingHash,
          text: "Synthetic retained product",
          config: {
            provider: "openai",
            model: "text-embedding-3-small",
            dimensions: 1536,
          },
        },
        cursor: expect.objectContaining({
          hash: vectorHash,
          mutationId: "synthetic-upload-receipt",
        }),
        result: expect.objectContaining({
          legacyArtifact: expect.objectContaining({
            lastError: "Synthetic visibility diagnostic",
            visibilityAttempts: 2,
          }),
        }),
      },
    ]);
    expect(
      (
        await client.query('SELECT key,state FROM "Job" WHERE id=$1', [
          retiredArtifactId,
        ])
      ).rows,
    ).toEqual([
      {
        key: `embedding:product:${productId}:${retiredHash}:retired:${retiredArtifactId}`,
        state: "cancelled",
      },
    ]);
    expect(
      (
        await client.query('SELECT key,state,error FROM "Job" WHERE id=$1', [
          failedArtifactId,
        ])
      ).rows,
    ).toEqual([
      {
        key: `embedding:product:${productId}:${retiredHash}`,
        state: "failed",
        error: "Synthetic failed upload",
      },
    ]);
    expect(
      (
        await client.query(
          'SELECT authority,verdict,intent,receipt FROM "Feedback" WHERE "assessmentId"=$1',
          [appliedFindingId],
        )
      ).rows,
    ).toEqual([
      {
        authority: "member",
        verdict: "correct",
        intent: "apply",
        receipt: { legacy: true },
      },
    ]);
    const findingKeys = (
      await client.query(
        'SELECT id,"publicationKey" FROM "Assessment" WHERE id=ANY($1::uuid[])',
        [[findingId, appliedFindingId]],
      )
    ).rows;
    expect(findingKeys).toEqual(
      expect.arrayContaining([
        { id: findingId, publicationKey: `run_finding:legacy:${findingId}` },
        {
          id: appliedFindingId,
          publicationKey: `run_finding:v1:${ledgerPartyId}:run:${runId}:synthetic_review:synthetic-evidence`,
        },
      ]),
    );
    expect(
      (
        await client.query('SELECT state FROM "Job" WHERE key=$1', [
          `image-processing:${deletedProcessingId}`,
        ])
      ).rows,
    ).toEqual([{ state: "cancelled" }]);
    expect(
      (
        await client.query('SELECT state,input FROM "Job" WHERE key=$1', [
          `run:${activeRunId}`,
        ])
      ).rows,
    ).toEqual([
      {
        state: "queued",
        input: { runId: activeRunId, purpose: "suggestion_sweep" },
      },
    ]);
    expect(
      (
        await client.query(
          'SELECT status,"failureCode" FROM "Run" WHERE id=$1',
          [retiredRunId],
        )
      ).rows,
    ).toEqual([{ status: "failed", failureCode: "retired_execution" }]);
    expect(
      (
        await client.query('SELECT state,result FROM "Job" WHERE key=$1', [
          `retired-derived-run:${retiredRunId}`,
        ])
      ).rows,
    ).toEqual([
      {
        state: "cancelled",
        result: expect.objectContaining({
          legacyExecution: expect.objectContaining({
            status: "running",
            dispatchError: "Synthetic retained dispatch error",
          }),
        }),
      },
    ]);
    const diagnostics = (
      await client.query(
        `SELECT result FROM "Job" WHERE key='refresh:legacy-diagnostics'`,
      )
    ).rows[0]?.result;
    expect(diagnostics).toMatchObject({
      legacyRefresh: {
        failures: [
          expect.objectContaining({
            lastError: "Synthetic retained SQLSTATE 08006",
            attempts: 3,
          }),
        ],
        work: [
          expect.objectContaining({
            lastError: "Synthetic retained checkpoint error",
          }),
        ],
      },
    });
    expect(
      (
        await client.query(
          'SELECT status,active FROM "AssessmentState" WHERE id=$1',
          [trialId],
        )
      ).rows,
    ).toEqual([{ status: "superseded", active: false }]);
    expect(
      (
        await client.query('SELECT origin FROM "Assessment" WHERE id=$1', [
          trialId,
        ])
      ).rows,
    ).toEqual([
      { origin: { trialPairKey: "00000000-0000-4000-8000-000000000917" } },
    ]);
    expect(
      (
        await client.query(`SELECT tgname FROM pg_trigger
      WHERE NOT tgisinternal AND tgrelid IN (
        SELECT oid FROM pg_class WHERE relnamespace='public'::regnamespace
      )`)
      ).rows,
    ).toEqual([]);
  });
});
