import type { EntityRef } from "@cubby/schemas/entity";
import { fromPartial } from "@total-typescript/shoehorn";
import { eq, inArray } from "drizzle-orm";
import { createRepoEntity } from "tooling/factories/repo";
import { withTestDb } from "tooling/test-setup";
import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";

import { drainAiEvaluations } from "~/server/ai/evaluation/service/ai-evaluation-drain.fixtures";
import { activateAiRefresh } from "~/server/ai/repo/ai-refresh";
import { setCfEnv } from "~/server/cf-env";
import { getDb } from "~/server/db/helpers";
import {
  aiEvaluation,
  email,
  financialTransaction,
  purchase as purchaseTable,
  workItem,
  orderMailEvent,
  run,
} from "~/server/db/schema";
import * as connectionRepo from "~/server/domains/connection/repo/entity-connections";
import { readEntityConnections } from "~/server/domains/connection/repo/entity-connections";
import { syntheticRetainedMail } from "~/server/domains/purchase-import/service/gmail/retained-mail.fixtures";
import { scheduleConnectionRefresh } from "~/server/domains/run/repo/connection-refresh";
import { seedEntityEmbedding } from "~/server/generic/embedding/repo/entity-embedding";
import { getSemanticEmbeddingConfig } from "~/server/generic/embedding/service/semantic/config";
import { createInMemoryVectorizeIndex } from "~/server/generic/embedding/service/semantic/vector-store";
import { readRunEvaluationsByCode } from "~/server/generic/run-detail/repo/run-evaluations";
import {
  refreshSearchDocument,
  getSearchDocumentEmbeddingText,
} from "~/server/generic/search/repo/search-document";
import { resolveOrThrow } from "~/server/generic/shortcode/repo/shortcode-resolver";
import { insertWithShortcode } from "~/server/generic/shortcode/repo/shortcode-utils";
import { reconcileDerivedRefreshInputs } from "~/server/testing/background-queue";
import {
  createIngredientFixture,
  createPlantFixture,
  createProductIdentityFixture,
  createProductFixture,
  makeProductInput,
} from "~/server/testing/repo.fixtures";

// Failure modes: each connection evaluation pays its own claim, guard and
// settlement (a sweep of ~55k sources took days); a page publishes a source
// that changed after its evaluation was queued; a candidate is lost on the
// page path.
describe("connection evaluation pages", () => {
  const ctx = withTestDb();
  afterEach(() => {
    vi.restoreAllMocks();
    setCfEnv(undefined);
    vi.unstubAllEnvs();
  });

  async function setup() {
    await activateAiRefresh(ctx.db, "synthetic-connection-page", {
      enabled: true,
    });
    const party = await insertWithShortcode(ctx.db, "ledgerParty", {
      name: "Synthetic page member",
      kind: "member",
      userId: ctx.actor.userId,
    });
    const vendor = await insertWithShortcode(ctx.db, "vendor", {
      name: "Synthetic page merchant",
    });
    return { party, vendor };
  }

  async function emails(
    { party, vendor }: Awaited<ReturnType<typeof setup>>,
    count: number,
    prefix: string,
  ) {
    const created = [];
    for (let index = 0; index < count; index++) {
      const mail = await syntheticRetainedMail(ctx.db, {
        ledgerPartyId: party.id,
        mailboxId: "synthetic-page-mailbox",
        messageId: `${prefix}-${index}`,
        vendorId: vendor.id,
        sender: "orders@example.test",
        subject: `Synthetic page receipt ${prefix} ${index}`,
        receivedAt: new Date("2026-10-01T12:00:00Z"),
        rawChecksum: `${prefix}${index}`.padEnd(64, "0").slice(0, 64),
        content: {
          bodyText: "Synthetic receipt",
          bodyHtml: null,
          snippet: null,
        },
      });
      const [message] = await getDb(ctx.db)
        .select()
        .from(email)
        .where(eq(email.orderMailId, mail.id));
      if (!message) throw new Error("Synthetic retained Email missing");
      created.push({ mail, message });
    }
    return created;
  }

  async function schedule(messages: readonly { shortcode: string }[]) {
    return scheduleSources(
      messages.map((message) => ({
        entityKind: "email",
        entityId: message.shortcode,
      })),
    );
  }

  async function scheduleSources(sources: readonly EntityRef[]) {
    await reconcileDerivedRefreshInputs(ctx.db);
    const ids: string[] = [];
    for (const source of sources) {
      const { runId } = await scheduleConnectionRefresh(ctx.db, source);
      if (!runId) throw new Error("Synthetic connection was not scheduled");
    }
    const rows = await getDb(ctx.db)
      .select({ id: aiEvaluation.id })
      .from(aiEvaluation)
      .where(eq(aiEvaluation.feature, "entity-connections"));
    ids.push(...rows.map((row) => row.id));
    return ids;
  }

  async function runPage(evaluationIds: readonly string[]) {
    const result = await drainAiEvaluations(
      ctx.db,
      evaluationIds,
      {},
      { pages: 1 },
    );
    return result[0];
  }

  const states = async (ids: readonly string[]) =>
    (
      await getDb(ctx.db)
        .select({ state: aiEvaluation.state })
        .from(aiEvaluation)
        .where(inArray(aiEvaluation.id, [...ids]))
    ).map((row) => row.state);

  it("settles a single source and a page of sources", async () => {
    const base = await setup();
    const single = await schedule(
      (await emails(base, 1, "single")).map((entry) => entry.message),
    );
    expect(await runPage(single)).toBe("succeeded");
    expect(await states(single)).toEqual(["completed"]);

    const created = await emails(base, 20, "page");
    const all = await schedule(created.map((entry) => entry.message));
    const page = all.filter((id) => !single.includes(id));
    expect(page).toHaveLength(20);
    expect(await runPage(page)).toBe("succeeded");
    expect(new Set(await states(page))).toEqual(new Set(["completed"]));
  });

  it("publishes Expense acquisition candidates for every source on a page", async () => {
    await setup();
    const index = createInMemoryVectorizeIndex();
    const config = getSemanticEmbeddingConfig();
    const values = Array.from({ length: config.dimensions }, (_, axis) =>
      axis === 0 ? 1 : 0,
    );
    setCfEnv(
      fromPartial<Env & { CUBBY_TEST_AI_GATEWAY: { fetch: typeof fetch } }>({
        VECTORIZE: index,
        BACKGROUND_QUEUE: { sendBatch: async () => {} },
        CUBBY_TEST_AI_GATEWAY: {
          fetch: async () =>
            Response.json({ data: [{ index: 0, embedding: values }] }),
        },
      }),
    );
    const item = await createProductFixture(
      ctx.db,
      makeProductInput({ name: "Synthetic page anvil" }),
      ctx.actor,
    );
    await refreshSearchDocument(ctx.db, "product", item.entityId);
    await reconcileDerivedRefreshInputs(ctx.db);
    const text = await getSearchDocumentEmbeddingText(
      ctx.db,
      "product",
      item.entityId,
    );
    if (!text) throw new Error("Synthetic Product search document missing");
    const embeddingId = await seedEntityEmbedding(ctx.db, {
      ...text,
      config,
      values,
    });
    await index.upsert([
      { id: embeddingId, values, metadata: { entityType: "product" } },
    ]);
    const createExpenses = async (count: number, prefix: string) => {
      const sources: EntityRef[] = [];
      for (let i = 0; i < count; i++) {
        const payment = await createRepoEntity(ctx, "expense", {
          name: `Synthetic page anvil ${prefix} ${i}`,
          cost: 24,
          date: "2026-10-01",
          trade: "other",
          costType: "materials",
        });
        sources.push({ entityKind: "expense", entityId: payment.output.id });
      }
      return sources;
    };
    const singleSources = await createExpenses(1, "single");
    const single = await scheduleSources(singleSources);
    expect(await runPage(single)).toBe("succeeded");
    expect(await states(single)).toEqual(["completed"]);
    const sources = await createExpenses(8, "batch");
    const ids = (await scheduleSources(sources)).filter(
      (id) => !single.includes(id),
    );
    expect(await runPage(ids)).toBe("succeeded");
    expect(new Set(await states(ids))).toEqual(new Set(["completed"]));
    for (const source of [...singleSources, ...sources]) {
      const proposals = await readEntityConnections(ctx.db, source);
      expect(proposals).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            relation: "product-expense",
            source: { entityKind: "product", entityId: item.id },
            target: source,
          }),
        ]),
      );
    }
  });

  it("completes other sources when a candidate disappears during shared evidence capture", async () => {
    await setup();
    const account = await createRepoEntity(ctx, "financialAccount", {
      name: "Synthetic isolation card",
      identity: { kind: "cash" },
    });
    const vendor = await createRepoEntity(ctx, "vendor", {
      name: "Synthetic isolation vendor",
    });
    await createRepoEntity(ctx, "purchase", {
      vendorId: vendor.output.id,
      date: "2026-10-01",
      statedTotal: 24,
    });
    const sources: EntityRef[] = [];
    for (let i = 0; i < 2; i++) {
      const payment = await createRepoEntity(ctx, "financialTransaction", {
        accountId: account.output.id,
        kind: "purchase",
        status: "posted",
        amount: 24,
        transactionDate: "2026-10-01",
        postedDate: "2026-10-01",
        sourceRefs: [
          { source: "synthetic-isolation", externalId: `payment-${i}` },
        ],
      });
      sources.push({
        entityKind: "financialTransaction",
        entityId: payment.output.id,
      });
    }
    const ids = await scheduleSources(sources);
    const capture = connectionRepo.prepareEntityConnectionEvidence;
    // Inject the deletion precisely between retrieval and evidence capture.
    vi.spyOn(
      connectionRepo,
      "prepareEntityConnectionEvidence",
    ).mockImplementationOnce(async (db, candidates) => {
      expect(candidates.length).toBeGreaterThan(0);
      const id = await resolveOrThrow(
        db,
        "financialTransaction",
        candidates[0]!.source.entityId,
      );
      await getDb(db)
        .update(financialTransaction)
        .set({ deletedAt: new Date() })
        .where(eq(financialTransaction.id, id));
      return capture(db, candidates);
    });
    await runPage(ids);
    expect(
      (await states(ids)).filter((state) => state === "completed"),
    ).toHaveLength(1);
  });

  it("settles invalidated connection evidence as obsolete on the final attempt", async () => {
    const base = await setup();
    const created = await createRepoEntity(ctx, "purchase", {
      vendorId: base.vendor.shortcode,
      orderId: "SYNTHETIC-FINAL-ATTEMPT",
      date: "2026-10-01",
      statedTotal: 24,
    });
    const order = { id: created.entityId, orderId: created.output.orderId };
    const [message] = await emails(base, 1, "final-attempt");
    if (!message) throw new Error("Synthetic Email missing");
    await getDb(ctx.db).insert(orderMailEvent).values({
      orderMailId: message.mail.id,
      event: "placed",
      orderId: order.orderId,
      sourceKey: "synthetic-final-event",
    });
    const ids = await schedule([message.message]);
    await getDb(ctx.db)
      .update(workItem)
      .set({ attempts: 2 })
      .where(inArray(workItem.ref, ids));
    const publish = connectionRepo.publishPreparedEntityConnections;
    vi.spyOn(
      connectionRepo,
      "publishPreparedEntityConnections",
    ).mockImplementationOnce(async (db, prepared) => {
      await getDb(db)
        .update(purchaseTable)
        .set({ statedTotal: 99 })
        .where(eq(purchaseTable.id, order.id));
      return publish(db, prepared);
    });
    await runPage(ids);
    expect(await states(ids)).toEqual(["obsolete"]);
  });

  it("publishes FinancialTransaction settlement candidates for every source on a page", async () => {
    await setup();
    const account = await createRepoEntity(ctx, "financialAccount", {
      name: "Synthetic page card",
      identity: { kind: "credit_card", network: "visa" },
    });
    const vendor = await createRepoEntity(ctx, "vendor", {
      name: "Synthetic page settlement vendor",
    });
    await createRepoEntity(ctx, "purchase", {
      vendorId: vendor.output.id,
      date: "2026-10-01",
      statedTotal: 24,
    });
    const sources: EntityRef[] = [];
    for (let i = 0; i < 8; i++) {
      const payment = await createRepoEntity(ctx, "financialTransaction", {
        accountId: account.output.id,
        kind: "purchase",
        status: "posted",
        amount: 24,
        transactionDate: "2026-10-01",
        postedDate: "2026-10-01",
        sourceRefs: [{ source: "synthetic-page", externalId: `payment-${i}` }],
      });
      sources.push({
        entityKind: "financialTransaction",
        entityId: payment.output.id,
      });
    }
    const ids = await scheduleSources(sources);
    expect(await runPage(ids)).toBe("succeeded");
    expect(new Set(await states(ids))).toEqual(new Set(["completed"]));
    for (const source of sources)
      expect(await readEntityConnections(ctx.db, source)).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ relation: "transaction-purchase", source }),
        ]),
      );
  });

  it("packs Product identity and field questions across the page at the gateway", async () => {
    await setup();
    const index = createInMemoryVectorizeIndex();
    const config = getSemanticEmbeddingConfig();
    const values = Array.from({ length: config.dimensions }, (_, axis) =>
      axis === 0 ? 1 : 0,
    );
    const requests: { operation: string; questions: number }[] = [];
    setCfEnv(
      fromPartial<Env & { CUBBY_TEST_AI_GATEWAY: { fetch: typeof fetch } }>({
        VECTORIZE: index,
        BACKGROUND_QUEUE: { sendBatch: async () => {} },
        CUBBY_TEST_AI_GATEWAY: {
          fetch: async (
            _url: Parameters<typeof fetch>[0],
            init?: RequestInit,
          ) => {
            if (!init?.body) return Response.json({});
            const body = JSON.parse(String(init.body));
            if (!body.questions)
              return Response.json({ data: [{ index: 0, embedding: values }] });
            const questions = z
              .record(
                z.string(),
                z.object({ criteria: z.record(z.string(), z.string()) }),
              )
              .parse(body.questions);
            const metadata = z
              .object({ operation: z.string() })
              .parse(
                JSON.parse(
                  new Headers(init?.headers).get("cf-aig-metadata") ?? "{}",
                ),
              );
            requests.push({
              operation: metadata.operation,
              questions: Object.keys(questions).length,
            });
            return Response.json({
              result: {
                answers: Object.fromEntries(
                  Object.entries(questions).map(([key, question]) => {
                    const choices = Object.keys(question.criteria);
                    const selected = choices.includes("none")
                      ? "none"
                      : choices.at(-1);
                    return [
                      key,
                      {
                        type: "choice",
                        choice: selected,
                        confidence: 0.9,
                        probabilities: Object.fromEntries(
                          choices.map((choice) => [
                            choice,
                            choice === selected
                              ? 0.9
                              : 0.1 / Math.max(1, choices.length - 1),
                          ]),
                        ),
                      },
                    ];
                  }),
                ),
              },
            });
          },
        },
      }),
    );
    const products = [];
    for (const suffix of ["alpha", "beta", "gamma", "delta"])
      products.push(
        await createProductIdentityFixture(
          ctx.db,
          makeProductInput({ name: `Synthetic basil ${suffix}` }),
          ctx.actor,
        ),
      );
    const ingredient = await createIngredientFixture(
      ctx.db,
      { name: "Synthetic basil", aliases: [] },
      ctx.actor,
    );
    const plant = await createPlantFixture(
      ctx.db,
      { name: "Synthetic basil" },
      ctx.actor,
    );
    const refs = [
      ...products.map((item) => ({
        entityKind: "product" as const,
        entityId: item.entityId,
      })),
      { entityKind: "ingredient" as const, entityId: ingredient.entityId },
      {
        entityKind: "plant" as const,
        entityId: await resolveOrThrow(ctx.db, "plant", plant.id),
      },
    ];
    for (const ref of refs)
      await refreshSearchDocument(ctx.db, ref.entityKind, ref.entityId);
    await reconcileDerivedRefreshInputs(ctx.db);
    for (const ref of refs) {
      const text = await getSearchDocumentEmbeddingText(
        ctx.db,
        ref.entityKind,
        ref.entityId,
      );
      if (!text) throw new Error("Synthetic search document missing");
      const id = await seedEntityEmbedding(ctx.db, { ...text, config, values });
      await index.upsert([
        { id, values, metadata: { entityType: ref.entityKind } },
      ]);
    }
    const ids = await scheduleSources(
      products.map((item) => ({ entityKind: "product", entityId: item.id })),
    );
    expect(await runPage(ids)).toBe("succeeded");
    expect(new Set(await states(ids))).toEqual(new Set(["completed"]));
    // A port bypasses DecisionRequestBatch. Inspect actual gateway requests
    // instead, so separate per-source usage objects cannot silently regress it.
    for (const operation of [
      "product-identity",
      "suggestFields.product.ingredientId",
      "suggestFields.product.growsPlantId",
    ])
      expect(
        requests
          .filter((request) => request.operation === operation)
          .some((request) => request.questions >= 2),
      ).toBe(true);
  });

  it("publishes a source's candidates and retires a deleted source without writes", async () => {
    const base = await setup();
    const purchase = await insertWithShortcode(ctx.db, "purchase", {
      vendorId: base.vendor.id,
      orderId: "SYNTHETIC-PAGE-ORDER",
      date: "2026-10-01",
      statedTotal: 24,
    });
    const [withEvidence, deleted] = await emails(base, 2, "evidence");
    if (!withEvidence || !deleted) throw new Error("Synthetic Emails missing");
    await getDb(ctx.db).insert(orderMailEvent).values({
      orderMailId: withEvidence.mail.id,
      event: "placed",
      orderId: purchase.orderId,
      sourceKey: "synthetic-page-event",
    });
    const ids = await schedule([withEvidence.message, deleted.message]);
    await getDb(ctx.db)
      .update(email)
      .set({ deletedAt: new Date() })
      .where(eq(email.id, deleted.message.id));

    expect(await runPage(ids)).toBe("succeeded");

    const rows = await getDb(ctx.db)
      .select({ state: aiEvaluation.state, target: aiEvaluation.target })
      .from(aiEvaluation)
      .where(inArray(aiEvaluation.id, ids));
    const stateOf = (recordId: string) =>
      rows.find(
        (row) =>
          typeof row.target === "object" &&
          row.target !== null &&
          "recordId" in row.target &&
          row.target.recordId === recordId,
      )?.state;
    expect(stateOf(withEvidence.message.id)).toBe("completed");
    expect(stateOf(deleted.message.id)).toBe("obsolete");
    const proposals = await readEntityConnections(ctx.db, {
      entityKind: "purchase",
      entityId: purchase.shortcode,
    });
    expect(proposals.map((proposal) => proposal.source)).toEqual([
      { entityKind: "email", entityId: withEvidence.message.shortcode },
    ]);
    const [evaluationRun] = await getDb(ctx.db)
      .select({ code: run.shortcode })
      .from(run)
      .innerJoin(aiEvaluation, eq(aiEvaluation.runId, run.id))
      .where(inArray(aiEvaluation.id, ids))
      .limit(1);
    if (!evaluationRun?.code) throw new Error("Synthetic Run missing");
    const summary = await readRunEvaluationsByCode(
      ctx.db,
      evaluationRun.code,
      false,
    );
    expect(
      summary.recent.map((outcome) => [
        outcome.recordCode,
        outcome.state,
        outcome.candidates,
      ]),
    ).toEqual(
      expect.arrayContaining([
        [withEvidence.message.shortcode, "completed", 1],
        [deleted.message.shortcode, "obsolete", null],
      ]),
    );
    expect(summary.byKind).toEqual([
      expect.objectContaining({ entity: "email", completed: 1, obsolete: 1 }),
    ]);
  });
});
