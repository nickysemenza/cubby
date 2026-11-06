import type { EntityRef } from "@cubby/schemas/entity";
import type { SearchableEntity } from "@cubby/schemas/search";
import { moneyToMinor } from "@cubby/shared";
import { fromPartial } from "@total-typescript/shoehorn";
import { eq, inArray, sql } from "drizzle-orm";
import { createRepoEntity } from "tooling/factories/repo";
import { withTestDb } from "tooling/test-setup";
import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";

import { markAiEvaluationWork } from "~/server/ai/evaluation/repo/ai-evaluation-work";
import {
  aiEvaluationItem,
  updateAiEvaluationWork,
  drainAiEvaluations,
} from "~/server/ai/evaluation/service/ai-evaluation-drain.fixtures";
import * as productIdentity from "~/server/ai/product-identity";
import { activateAiRefresh } from "~/server/ai/repo/ai-refresh";
import { setCfEnv } from "~/server/cf-env";
import { getDb } from "~/server/db/helpers";
import {
  aiEvaluation,
  email,
  expense,
  financialTransaction,
  purchase as purchaseTable,
  orderMailEvent,
  run,
} from "~/server/db/schema";
import * as connectionRepo from "~/server/domains/connection/repo/entity-connections";
import { readEntityConnections } from "~/server/domains/connection/repo/entity-connections";
import * as connectionService from "~/server/domains/connection/service/entity-connections";
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
import {
  drainDerivedRefreshFrontier,
  reconcileDerivedRefreshInputs,
} from "~/server/testing/background-queue";
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
// page path; a source spends attempts and paid stages on coverage upstream
// work still owes.
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

  function semanticEnvironment() {
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
    return { index, config, values };
  }

  /** Records each paid decision request; embedding requests stay unrecorded. */
  function decisionEnvironment() {
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
    const embed = async (
      refs: readonly { entityKind: SearchableEntity; entityId: string }[],
    ) => {
      for (const ref of refs) {
        const text = await getSearchDocumentEmbeddingText(
          ctx.db,
          ref.entityKind,
          ref.entityId,
        );
        if (!text) throw new Error("Synthetic search document missing");
        const id = await seedEntityEmbedding(ctx.db, {
          ...text,
          config,
          values,
        });
        await index.upsert([
          { id, values, metadata: { entityType: ref.entityKind } },
        ]);
      }
    };
    return { requests, embed };
  }

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
    expect(new Set(await drainAiEvaluations(ctx.db, page))).toEqual(
      new Set(["succeeded"]),
    );
    expect(new Set(await states(page))).toEqual(new Set(["completed"]));
  });

  it("publishes Expense acquisition candidates for every source on a page", async () => {
    await setup();
    const { index, config, values } = semanticEnvironment();
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
    const sources = await createExpenses(9, "batch");
    const ids = (await scheduleSources(sources)).filter(
      (id) => !single.includes(id),
    );
    const prepare = connectionService.prepareEntityConnectionSources;
    const expected = await prepare(ctx.db, sources);
    const captured: typeof expected = new Map();
    vi.spyOn(
      connectionService,
      "prepareEntityConnectionSources",
    ).mockImplementation(async (db, wave) => {
      const result = await prepare(db, wave);
      for (const [id, value] of result)
        captured.set(id, structuredClone(value));
      return result;
    });
    expect(new Set(await drainAiEvaluations(ctx.db, ids))).toEqual(
      new Set(["succeeded"]),
    );
    expect(captured).toEqual(expected);
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
    semanticEnvironment();
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
    const project = await createRepoEntity(ctx, "project", {
      name: "Synthetic isolation project",
      defaultTrade: "electrical",
    });
    const history = await createRepoEntity(ctx, "expense", {
      name: "Synthetic isolation history",
      date: "2026-10-01",
      trade: "electrical",
      cost: 10,
      costType: "materials",
      projectId: project.output.id,
    });
    const line = await createRepoEntity(ctx, "expense", {
      name: "Synthetic isolation source",
      date: "2026-10-01",
      trade: "electrical",
      cost: 24,
      costType: "materials",
    });
    sources.push({ entityKind: "expense", entityId: line.output.id });
    const ids = await scheduleSources(sources);
    const capture = connectionRepo.prepareEntityConnectionEvidence;
    const expenseFallback: Awaited<ReturnType<typeof capture>> = [];
    let injected = false;
    // Inject the deletion precisely between retrieval and evidence capture.
    vi.spyOn(
      connectionRepo,
      "prepareEntityConnectionEvidence",
    ).mockImplementation(async (db, candidates, expenseProjects) => {
      if (!injected) {
        injected = true;
        const first = candidates[0];
        if (!first) throw new Error("Synthetic bulk capture has no candidates");
        const id = await resolveOrThrow(
          db,
          "financialTransaction",
          first.source.entityId,
        );
        await getDb(db)
          .update(financialTransaction)
          .set({ deletedAt: new Date() })
          .where(eq(financialTransaction.id, id));
        await getDb(db)
          .update(expense)
          .set({ date: "2026-10-02" })
          .where(eq(expense.id, history.entityId));
      }
      const prepared = await capture(db, candidates, expenseProjects);
      if (!expenseProjects)
        expenseFallback.push(
          ...prepared.filter(
            (entry) => entry.candidate.source.entityId === line.output.id,
          ),
        );
      return prepared;
    });
    await runPage(ids);
    expect(
      (await states(ids)).filter((state) => state === "completed"),
    ).toHaveLength(2);
    expect(expenseFallback.length).toBeGreaterThan(0);
    expect(expenseFallback).toEqual(
      await capture(
        ctx.db,
        expenseFallback.map((entry) => entry.candidate),
      ),
    );
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
    await updateAiEvaluationWork(ctx.db, ids, { attempts: 2 });
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
    const { requests, embed } = decisionEnvironment();
    const products: Awaited<ReturnType<typeof createProductIdentityFixture>>[] =
      [];
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
    await embed(refs);
    const ids = await scheduleSources(
      products.map((item) => ({ entityKind: "product", entityId: item.id })),
    );
    const prepare = productIdentity.prepareProductIdentityPage;
    const targets = Array.from({ length: 9 }, (_, index) => ({
      key: `synthetic-catalog-${index}`,
      kind: "product" as const,
      recordId: products[index % products.length]!.entityId,
    }));
    const expected = await prepare(ctx.db, targets);
    const captured = [
      ...(await prepare(ctx.db, targets.slice(0, 8))),
      ...(await prepare(ctx.db, targets.slice(8))),
    ];
    // Preparation size must preserve complete pairs, neighbors and fences.
    expect(captured).toEqual(expected);
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

  it("holds a source on pending coverage before paid stages while its healthy sibling finishes, then resumes", async () => {
    const base = await setup();
    const { requests, embed } = decisionEnvironment();
    const [source, other] = [
      await createProductIdentityFixture(
        ctx.db,
        makeProductInput({ name: "Synthetic basil alpha" }),
        ctx.actor,
      ),
      await createProductIdentityFixture(
        ctx.db,
        makeProductInput({ name: "Synthetic basil beta" }),
        ctx.actor,
      ),
    ];
    const charge = await createRepoEntity(ctx, "expense", {
      name: "Synthetic basil alpha charge",
      cost: 24,
      date: "2026-10-01",
      trade: "other",
      costType: "materials",
    });
    const products = [source, other].map((item) => ({
      entityKind: "product" as const,
      entityId: item.entityId,
    }));
    const chargeRef = {
      entityKind: "expense" as const,
      entityId: charge.entityId,
    };
    for (const ref of [...products, chargeRef])
      await refreshSearchDocument(ctx.db, ref.entityKind, ref.entityId);
    await reconcileDerivedRefreshInputs(ctx.db);
    // Expenses have no selected embeddings; a missing eligible document holds coverage.
    await embed(products);
    const [sibling] = await emails(base, 1, "pending-sibling");
    if (!sibling) throw new Error("Synthetic sibling Email missing");
    const ids = await scheduleSources([
      { entityKind: "product", entityId: source.id },
      { entityKind: "email", entityId: sibling.message.shortcode },
    ]);
    const rows = await getDb(ctx.db)
      .select({
        id: aiEvaluation.id,
        state: aiEvaluation.state,
        target: aiEvaluation.target,
      })
      .from(aiEvaluation)
      .where(inArray(aiEvaluation.id, ids));
    const evaluationFor = (recordId: string) => {
      const found = rows.find(
        (row) =>
          typeof row.target === "object" &&
          row.target !== null &&
          "recordId" in row.target &&
          row.target.recordId === recordId,
      );
      if (!found) throw new Error("Synthetic evaluation missing");
      return found.id;
    };
    const waitingId = evaluationFor(source.entityId);
    const siblingId = evaluationFor(sibling.message.id);
    const productRef = { entityKind: "product" as const, entityId: source.id };
    await updateAiEvaluationWork(ctx.db, [waitingId], {
      attempts: 1,
      error: "Synthetic earlier failure",
    });
    await getDb(ctx.db).execute(
      sql`UPDATE "SearchDocument" SET "deletedAt" = now() WHERE "entityId" = ${charge.entityId}::uuid`,
    );

    expect(await runPage(ids)).toBe("succeeded");

    expect(await states([siblingId])).toEqual(["completed"]);
    expect(await states([waitingId])).toEqual(["queued"]);
    const waiting = await aiEvaluationItem(ctx.db, waitingId);
    expect(waiting).toMatchObject({
      attempts: 1,
      lastError: "Synthetic earlier failure",
      waitCause: "search_coverage",
    });
    expect(requests).toEqual([]);
    expect(await readEntityConnections(ctx.db, productRef)).toEqual([]);

    // A fresh mark clears the wait with a new attempt budget.
    await markAiEvaluationWork(ctx.db, [waitingId]);
    const remarked = await aiEvaluationItem(ctx.db, waitingId);
    expect(remarked).toMatchObject({
      attempts: 0,
      lastError: null,
      waitCause: null,
    });

    await drainDerivedRefreshFrontier(ctx.db);
    await refreshSearchDocument(ctx.db, "expense", charge.entityId);
    expect(await runPage([waitingId])).toBe("succeeded");

    expect(await states([waitingId])).toEqual(["completed"]);
    expect(await aiEvaluationItem(ctx.db, waitingId)).toBeUndefined();
    expect(
      requests.some((request) => request.operation === "product-identity"),
    ).toBe(true);
    expect(await readEntityConnections(ctx.db, productRef)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ relation: "product-expense" }),
      ]),
    );
  });

  it("publishes a source's candidates and retires a deleted source without writes", async () => {
    const base = await setup();
    const purchase = await insertWithShortcode(ctx.db, "purchase", {
      vendorId: base.vendor.id,
      orderId: "SYNTHETIC-PAGE-ORDER",
      date: "2026-10-01",
      statedTotal: moneyToMinor(24),
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
