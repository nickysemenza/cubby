/**
 * Caller-owned product enrichment through the production MCP transport: a
 * member's own MCP client (no browser device, no coordinator) discovers a
 * Product's purchase source, starts a run, captures a vendor page over HTTP,
 * commits proven identity, and finishes. Synthetic vendor pages are served by
 * a local HTTP server; R2 is an in-memory object store behind the same fetch.
 *
 * Failure modes this guards, each asserted below:
 * - the start queues a coordinator or holds the vendor account;
 * - a run-delegated coordinator starts or works a caller-owned run;
 * - another member reads or writes the run;
 * - a capture leaves the vendor (URL or redirect), accepts a sign-in page,
 *   or accepts a page that does not show exactly one Product variant;
 * - a commit trusts missing, foreign, or wrong-variant evidence, a stale
 *   target fingerprint, or overwrites a populated field;
 * - a replayed capture or commit writes twice;
 * - a finished run still accepts captures, commits, or skips;
 * - the coordinator recovery paths (agent re-authorization, resume, retry
 *   dispatch) pick a caller-owned run up.
 */
import { createServer, type Server } from "node:http";

import type { UserId } from "@cubby/schemas/identifiers";
import { productShortcode } from "@cubby/schemas/identifiers";
import { testUserId } from "@cubby/schemas/testing";
import { generateShortcode } from "@cubby/shared";
import { CallToolResultSchema } from "@modelcontextprotocol/core";
import { and, eq } from "drizzle-orm";
import { createRepoEntity } from "tooling/factories/repo";
import { withTestDb } from "tooling/test-setup";
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { type JSONType, z } from "zod";

import { env } from "~/env";
import {
  entityAttachment,
  entityExternalId,
  expense,
  image,
  importSourceClaim,
  ledgerParty,
  product,
  purchase,
  run as runTable,
  runEvidence,
  runTarget,
  user,
  vendor,
} from "~/server/db/schema";
import { callMcpTool } from "~/server/mcp/mcp-test-utils";
import { createMcpServer } from "~/server/mcp/server";
import type { ToolArguments } from "~/server/mcp/tools/tool-registration";
import { getDb } from "~/server/repo/database-helpers";
import {
  createProductFixture,
  makeExpenseInput,
  makeProductInput,
} from "~/server/repo/repo.fixtures";
import { insertWithShortcode } from "~/server/repo/shortcode-utils";
import { requireActor } from "~/server/request-context";
import { createTestRequestContext } from "~/server/testing/request-context";

import {
  controlRun,
  expireStaleRuns,
  pauseAuthorizedRuns,
  resumeAuthorizedRuns,
  startTargetedRun,
} from "./run-service";

const VENDOR_HOST = "www.fieldgear.example";
const CDN_HOST = "cdn.fieldgear.example";
const OFF_VENDOR_HOST = "elsewhere.example";

/** A PNG header the dimension reader accepts; pixel data is never decoded. */
function pngBytes(width: number, height: number) {
  const bytes = new Uint8Array(33);
  bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0);
  const view = new DataView(bytes.buffer);
  view.setUint32(8, 13);
  bytes.set([0x49, 0x48, 0x44, 0x52], 12);
  view.setUint32(16, width);
  view.setUint32(20, height);
  bytes.set([8, 2, 0, 0, 0], 24);
  return bytes;
}

const productPage = (
  ldJson: JSONType,
  extra = "",
) => `<!doctype html><html><head><title>Trail tee</title>
<link rel="canonical" href="https://${VENDOR_HOST}/p/trail-tee-olive-m">
<script type="application/ld+json">${JSON.stringify(ldJson)}</script>
</head><body><h1>Trail tee</h1>${extra}</body></html>`;

const singleProduct = {
  "@context": "https://schema.org",
  "@type": "Product",
  name: "Trail tee, olive, M",
  sku: "FG-TEE-OLV-M",
  mpn: "TT-200",
  gtin12: "036000291452",
  image: [`https://${CDN_HOST}/img/trail-tee-olive.png`],
};

type Route = {
  status?: number;
  headers?: Record<string, string>;
  body: string | Uint8Array;
};

/** Synthetic vendor pages keyed by `host/path`; a local HTTP server serves them. */
const pages = new Map<string, Route>([
  [
    `${VENDOR_HOST}/p/trail-tee-olive-m`,
    {
      headers: { "content-type": "text/html; charset=utf-8" },
      body: productPage(singleProduct),
    },
  ],
  [
    `${CDN_HOST}/img/trail-tee-olive.png`,
    { headers: { "content-type": "image/png" }, body: pngBytes(640, 480) },
  ],
  [
    `${VENDOR_HOST}/p/trail-tee-family`,
    {
      headers: { "content-type": "text/html" },
      body: productPage({
        "@context": "https://schema.org",
        "@type": "ProductGroup",
        name: "Trail tee",
        hasVariant: [
          { "@type": "Product", sku: "FG-TEE-OLV-M" },
          { "@type": "Product", sku: "FG-TEE-OLV-L" },
        ],
      }),
    },
  ],
  [
    `${VENDOR_HOST}/p/two-products`,
    {
      headers: { "content-type": "text/html" },
      body: productPage([
        { "@type": "Product", sku: "FG-TEE-OLV-M" },
        { "@type": "Product", sku: "FG-TEE-OLV-L" },
      ]),
    },
  ],
  [
    `${VENDOR_HOST}/account/sign-in`,
    {
      headers: { "content-type": "text/html" },
      body: productPage(
        singleProduct,
        '<form><input type="password" name="password"></form>',
      ),
    },
  ],
  [
    `${VENDOR_HOST}/p/moved`,
    {
      status: 302,
      headers: { location: `https://${OFF_VENDOR_HOST}/p/trail-tee` },
      body: "",
    },
  ],
  [
    `${OFF_VENDOR_HOST}/p/trail-tee`,
    {
      headers: { "content-type": "text/html" },
      body: productPage(singleProduct),
    },
  ],
]);

let server: Server;
let serverOrigin = "";
const realFetch = globalThis.fetch;
const objects = new Map<string, { body: ArrayBuffer; type: string }>();

/**
 * Synthetic hosts reach the local server; the R2 endpoint is an in-memory
 * store.
 */
async function testFetch(
  input: string | URL | Request,
  init?: RequestInit,
): Promise<Response> {
  const request = new Request(input, init);
  const url = new URL(request.url);
  if (url.origin === new URL(env.R2_ENDPOINT).origin) {
    const key = url.pathname;
    if (request.method === "PUT") {
      objects.set(key, {
        body: await request.arrayBuffer(),
        type: request.headers.get("content-type") ?? "",
      });
      return new Response(null, { status: 200 });
    }
    if (request.method === "DELETE") {
      objects.delete(key);
      return new Response(null, { status: 204 });
    }
    const stored = objects.get(key);
    return stored
      ? new Response(stored.body, { headers: { "content-type": stored.type } })
      : new Response(null, { status: 404 });
  }
  if ([VENDOR_HOST, CDN_HOST, OFF_VENDOR_HOST].includes(url.hostname))
    return realFetch(`${serverOrigin}/${url.hostname}${url.pathname}`, {
      method: request.method,
      redirect: "manual",
      signal: init?.signal ?? null,
    });
  // The test database harness (IntegreSQL) shares the global fetch.
  return realFetch(input, init);
}

beforeAll(async () => {
  server = createServer((req, res) => {
    const route = pages.get((req.url ?? "").slice(1));
    if (!route) {
      res.writeHead(404).end();
      return;
    }
    res.writeHead(route.status ?? 200, route.headers ?? {});
    res.end(route.body);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = z.object({ port: z.number() }).parse(server.address());
  serverOrigin = `http://127.0.0.1:${port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

beforeEach(() => {
  vi.stubGlobal("fetch", testFetch);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

const toolResult = z.object({
  isError: z.boolean().optional(),
  structuredContent: z.record(z.string(), z.json()).optional(),
  content: z.array(z.json()),
});

describe("caller-owned product enrichment over MCP", () => {
  const ctx = withTestDb();

  const memberContext = (userId: UserId) =>
    requireActor(createTestRequestContext(ctx.db, { auth: { userId } }));

  async function call(
    tool: string,
    args: ToolArguments,
    options: {
      userId?: UserId;
      purchaseAgent?: { runId: string; grantId: string };
    } = {},
  ) {
    const context = memberContext(options.userId ?? ctx.actor.userId);
    const extra: NonNullable<Parameters<typeof callMcpTool>[4]> = {
      entityKernel: context,
    };
    if (options.purchaseAgent) extra.purchaseAgent = options.purchaseAgent;
    const raw = await callMcpTool(
      createMcpServer(),
      tool,
      args,
      context,
      extra,
    );
    return toolResult.parse(CallToolResultSchema.parse(raw));
  }

  async function ok(tool: string, args: ToolArguments) {
    const result = await call(tool, args);
    // oxlint-disable-next-line vitest/valid-expect -- The label names the failing call.
    expect(result.isError, JSON.stringify(result.content)).not.toBe(true);
    return result.structuredContent ?? {};
  }

  async function refused(
    tool: string,
    args: ToolArguments,
    message: string | RegExp,
    options?: Parameters<typeof call>[2],
  ) {
    const result = await call(tool, args, options);
    expect(result.isError).toBe(true);
    expect(JSON.stringify(result.content)).toMatch(message);
  }

  async function memberParty() {
    const [existing] = await getDb(ctx.db)
      .select({ id: ledgerParty.id })
      .from(ledgerParty)
      .where(eq(ledgerParty.userId, ctx.actor.userId));
    return (
      existing ??
      (await insertWithShortcode(ctx.db, "ledgerParty", {
        name: "Enrichment member",
        kind: "member",
        userId: ctx.actor.userId,
      }))
    );
  }

  /** An import-created Product: a Purchase line on a browser-claimed order. */
  async function importedProduct(
    name: string,
    overrides: { manufacturer?: string } = {},
  ) {
    const party = await memberParty();
    const created = await createProductFixture(
      ctx.db,
      makeProductInput({
        name,
        manufacturer: overrides.manufacturer ?? "",
        model: null,
      }),
      ctx.actor,
    );
    const orderId = `FG-${crypto.randomUUID().slice(0, 8)}`;
    await createRepoEntity(
      ctx,
      "expense",
      makeExpenseInput({
        name,
        cost: 24,
        vendor: "Fieldgear Outfitters",
        orderId,
        productId: created.id,
      }),
    );
    const [line] = await getDb(ctx.db)
      .select({ purchaseId: expense.purchaseId })
      .from(expense)
      .where(eq(expense.productId, created.entityId));
    if (!line?.purchaseId) throw new Error("Purchase line missing");
    const [order] = await getDb(ctx.db)
      .select({ vendorId: purchase.vendorId })
      .from(purchase)
      .where(eq(purchase.id, line.purchaseId));
    if (!order?.vendorId) throw new Error("Purchase vendor missing");
    await getDb(ctx.db)
      .update(vendor)
      .set({
        website: `https://${VENDOR_HOST}`,
        browserDomains: [VENDOR_HOST],
      })
      .where(eq(vendor.id, order.vendorId));
    const [sourceRun] = await getDb(ctx.db)
      .insert(runTable)
      .values({
        shortcode: generateShortcode("run"),
        actorUserId: ctx.actor.userId,
        actorName: "Import fixture",
        actorEmail: "import-fixture@example.test",
        purpose: "file_import",
        trigger: "manual",
        status: "completed",
      })
      .returning({ id: runTable.id });
    await getDb(ctx.db)
      .insert(importSourceClaim)
      .values({
        ledgerPartyId: party.id,
        purchaseId: line.purchaseId,
        kind: "browser_order",
        externalKey: `https://${VENDOR_HOST}/orders/${orderId}`,
        checksum: "c".repeat(64),
        firstRunId: sourceRun!.id,
        lastRunId: sourceRun!.id,
        outputFingerprint: "fixture",
      });
    return {
      id: productShortcode.parse(created.id),
      entityId: created.entityId,
      vendorId: order.vendorId,
      partyId: party.id,
    };
  }

  const runRow = async (runId: string) => {
    const [row] = await getDb(ctx.db)
      .select({
        id: runTable.id,
        status: runTable.status,
        executionMode: runTable.executionMode,
        dispatchEventId: runTable.dispatchEventId,
        dispatchAttempts: runTable.dispatchAttempts,
        vendorAccountId: runTable.vendorAccountId,
      })
      .from(runTable)
      .where(eq(runTable.shortcode, runId));
    if (!row) throw new Error(`Run ${runId} missing`);
    return row;
  };

  async function startRun(productIds: string[]) {
    const started = z
      .object({
        runs: z.array(
          z.object({
            created: z.boolean(),
            run: z.object({ id: z.string(), status: z.string() }).nullable(),
          }),
        ),
      })
      .parse(
        await ok("product_enrichment", { action: "start_run", productIds }),
      );
    expect(started.runs).toHaveLength(1);
    const runId = started.runs[0]!.run!.id;
    return runId;
  }

  const nextOut = z.object({
    runId: z.string(),
    status: z.string(),
    next: z
      .object({
        productId: z.string(),
        targetFingerprint: z.string(),
        startUrl: z.string().nullable(),
        evidence: z.array(z.object({ id: z.string(), kind: z.string() })),
      })
      .nullable(),
  });
  const captureOut = z.object({
    evidenceId: z.string(),
    replayed: z.boolean(),
    sourceUrl: z.string(),
    checksum: z.string(),
    product: z.object({
      skus: z.array(z.string()),
      gtins: z.array(z.string()),
    }),
    images: z.array(
      z.object({
        url: z.string(),
        naturalWidth: z.number(),
        naturalHeight: z.number(),
      }),
    ),
  });

  it("discovers, starts, captures, commits, and finishes without a coordinator", async () => {
    const tee = await importedProduct("Trail tee, olive, M");

    const sources = z
      .object({
        products: z.array(
          z.object({ productId: z.string(), selected: z.boolean() }),
        ),
      })
      .parse(
        await ok("imports_read", {
          action: "enrichment_sources",
          purpose: "product_enrichment",
          targetId: tee.id,
        }),
      );
    expect(sources.products).toEqual([
      expect.objectContaining({ productId: tee.id, selected: true }),
    ]);

    const runId = await startRun([tee.id]);
    // No queue in this runtime: a dispatched start would read
    // `dispatch_failed`. A caller-owned run never dispatches.
    expect(await runRow(runId)).toMatchObject({
      status: "running",
      executionMode: "caller",
      dispatchEventId: null,
      dispatchAttempts: 0,
      vendorAccountId: null,
    });

    const next = nextOut.parse(
      await ok("imports_read", { action: "enrichment_next", runId }),
    );
    expect(next.next).toMatchObject({ productId: tee.id, evidence: [] });
    const fingerprint = next.next!.targetFingerprint;

    const captured = captureOut.parse(
      await ok("product_enrichment", {
        action: "capture_page",
        runId,
        productId: tee.id,
        url: `https://${VENDOR_HOST}/p/trail-tee-olive-m`,
      }),
    );
    expect(captured).toMatchObject({
      replayed: false,
      sourceUrl: `https://${VENDOR_HOST}/p/trail-tee-olive-m`,
      product: { skus: ["FG-TEE-OLV-M"], gtins: ["036000291452"] },
      images: [
        {
          url: `https://${CDN_HOST}/img/trail-tee-olive.png`,
          naturalWidth: 640,
          naturalHeight: 480,
        },
      ],
    });
    const [retained] = await getDb(ctx.db)
      .select({
        kind: runEvidence.kind,
        objectKey: runEvidence.objectKey,
        checksum: runEvidence.checksum,
      })
      .from(runEvidence)
      .where(eq(runEvidence.id, captured.evidenceId));
    expect(retained).toMatchObject({
      kind: "http_capture",
      checksum: captured.checksum,
    });
    expect(
      [...objects.keys()].some((key) => key.endsWith(retained!.objectKey)),
    ).toBe(true);

    const recaptured = captureOut.parse(
      await ok("product_enrichment", {
        action: "capture_page",
        runId,
        productId: tee.id,
        url: `https://${VENDOR_HOST}/p/trail-tee-olive-m`,
      }),
    );
    expect(recaptured).toMatchObject({
      evidenceId: captured.evidenceId,
      replayed: true,
    });

    const commitArgs = {
      action: "commit",
      runId,
      operationId: "enrich-trail-tee",
      productId: tee.id,
      targetFingerprint: fingerprint,
      changes: {
        manufacturer: "Fieldgear",
        identifiers: [
          {
            evidenceId: captured.evidenceId,
            source: "fieldgear",
            kind: "retailer_sku",
            externalId: "FG-TEE-OLV-M",
          },
          {
            evidenceId: captured.evidenceId,
            source: "gtin",
            kind: "gtin_14",
            externalId: "036000291452",
          },
        ],
        image: {
          evidenceId: captured.evidenceId,
          url: `https://${CDN_HOST}/img/trail-tee-olive.png`,
          naturalWidth: 640,
          naturalHeight: 480,
        },
      },
    };
    const committed = await ok("product_enrichment", commitArgs);
    expect(committed).toMatchObject({
      runId,
      productId: tee.id,
      changedFields: ["manufacturer", "identifiers", "image"],
      skippedIdentifiers: [],
    });
    // A verbatim retry replays the ledger result instead of writing again.
    expect(await ok("product_enrichment", commitArgs)).toEqual(committed);

    const ids = await getDb(ctx.db)
      .select({
        source: entityExternalId.source,
        kind: entityExternalId.kind,
        externalId: entityExternalId.externalId,
      })
      .from(entityExternalId)
      .where(eq(entityExternalId.entityId, tee.entityId));
    expect(ids).toEqual(
      expect.arrayContaining([
        {
          source: "fieldgear",
          kind: "retailer_sku",
          externalId: "FG-TEE-OLV-M",
        },
        { source: "gtin", kind: "gtin_14", externalId: "00036000291452" },
      ]),
    );
    const covers = await getDb(ctx.db)
      .select({ source: image.source, sourcePageUrl: image.sourcePageUrl })
      .from(entityAttachment)
      .innerJoin(image, eq(image.id, entityAttachment.imageId))
      .where(eq(entityAttachment.entityId, tee.entityId));
    expect(covers).toEqual([
      {
        source: "catalog",
        sourcePageUrl: `https://${VENDOR_HOST}/p/trail-tee-olive-m`,
      },
    ]);

    expect(
      nextOut.parse(
        await ok("imports_read", { action: "enrichment_next", runId }),
      ).next,
    ).toBeNull();
    const finished = await ok("product_enrichment", {
      action: "finish_run",
      runId,
    });
    expect(finished).toMatchObject({ runId, status: "completed" });
    expect(
      await ok("product_enrichment", { action: "finish_run", runId }),
    ).toEqual(finished);
    expect((await runRow(runId)).dispatchEventId).toBeNull();

    // A finished run is fenced.
    await refused(
      "product_enrichment",
      {
        action: "capture_page",
        runId,
        productId: tee.id,
        url: `https://${VENDOR_HOST}/p/trail-tee-olive-m`,
      },
      /fenced in status completed/,
    );
    await refused(
      "product_enrichment",
      { ...commitArgs, operationId: "enrich-trail-tee-again" },
      /fenced in status completed/,
    );
    await refused(
      "product_enrichment",
      {
        action: "skip_target",
        runId,
        productId: tee.id,
        outcome: "skipped",
        reason: "late skip",
      },
      /fenced in status completed/,
    );
  });

  it("refuses off-vendor, signed-in, ambiguous, and foreign-target captures", async () => {
    const tee = await importedProduct("Trail tee, olive, M (capture checks)");
    const other = await importedProduct("Trail socks (not in this run)");
    const runId = await startRun([tee.id]);
    const capture = (url: string, productId = tee.id) => ({
      action: "capture_page",
      runId,
      productId,
      url,
    });
    await refused(
      "product_enrichment",
      capture(`https://${OFF_VENDOR_HOST}/p/trail-tee`),
      /not on the run vendor/,
    );
    await refused(
      "product_enrichment",
      capture(`https://${VENDOR_HOST}/p/moved`),
      /not on the run vendor/,
    );
    await refused(
      "product_enrichment",
      capture(`https://${VENDOR_HOST}/account/sign-in`),
      /sign-in/,
    );
    await refused(
      "product_enrichment",
      capture(`https://${VENDOR_HOST}/p/trail-tee-family`),
      /exactly one Product/,
    );
    await refused(
      "product_enrichment",
      capture(`https://${VENDOR_HOST}/p/two-products`),
      /exactly one Product/,
    );
    await refused(
      "product_enrichment",
      capture(`https://${VENDOR_HOST}/p/trail-tee-olive-m`, other.id),
      /not a pending target of this run/,
    );
    const evidence = await getDb(ctx.db)
      .select({ id: runEvidence.id })
      .from(runEvidence)
      .innerJoin(runTable, eq(runTable.id, runEvidence.runId))
      .where(eq(runTable.shortcode, runId));
    expect(evidence).toEqual([]);
  });

  it("refuses missing, foreign, and wrong-variant evidence, stale fingerprints, and populated fields", async () => {
    const tee = await importedProduct("Trail tee, olive, M (commit checks)");
    const socks = await importedProduct("Trail socks, olive", {
      manufacturer: "Fieldgear",
    });
    const runId = await startRun([tee.id, socks.id]);
    const fingerprints = new Map(
      (
        await getDb(ctx.db)
          .select({
            entityId: runTarget.entityId,
            fingerprint: runTarget.targetFingerprint,
          })
          .from(runTarget)
          .innerJoin(runTable, eq(runTable.id, runTarget.runId))
          .where(eq(runTable.shortcode, runId))
      ).map((row) => [row.entityId, row.fingerprint]),
    );
    const captured = captureOut.parse(
      await ok("product_enrichment", {
        action: "capture_page",
        runId,
        productId: tee.id,
        url: `https://${VENDOR_HOST}/p/trail-tee-olive-m`,
      }),
    );
    const commit = (
      productId: string,
      productEntityId: string,
      changes: ToolArguments,
      fingerprint = fingerprints.get(productEntityId),
    ) => ({
      action: "commit",
      runId,
      operationId: `op-${crypto.randomUUID()}`,
      productId,
      targetFingerprint: fingerprint,
      changes,
    });
    const sku = (evidenceId: string, externalId = "FG-TEE-OLV-M") => ({
      identifiers: [
        { evidenceId, source: "fieldgear", kind: "retailer_sku", externalId },
      ],
    });

    await refused(
      "product_enrichment",
      commit(tee.id, tee.entityId, sku(crypto.randomUUID())),
      /not proven by this target's retained evidence/,
    );
    await refused(
      "product_enrichment",
      commit(socks.id, socks.entityId, sku(captured.evidenceId)),
      /not proven by this target's retained evidence/,
    );
    await refused(
      "product_enrichment",
      commit(tee.id, tee.entityId, sku(captured.evidenceId, "FG-TEE-OLV-L")),
      /not proven by this target's retained evidence/,
    );
    await refused(
      "product_enrichment",
      commit(tee.id, tee.entityId, {
        image: {
          evidenceId: captured.evidenceId,
          url: `https://${CDN_HOST}/img/trail-tee-olive.png`,
          naturalWidth: 1200,
          naturalHeight: 1200,
        },
      }),
      /not verified by this target's/,
    );
    await refused(
      "product_enrichment",
      commit(tee.id, tee.entityId, sku(captured.evidenceId), "0".repeat(64)),
      /changed before commit/,
    );
    await refused(
      "product_enrichment",
      commit(socks.id, socks.entityId, { manufacturer: "Other maker" }),
      /requires typed approval/,
    );
    // An edit after the run started makes its fingerprint stale.
    await getDb(ctx.db)
      .update(product)
      .set({ name: "Trail tee, olive, M (renamed)", updatedAt: new Date() })
      .where(eq(product.id, tee.entityId));
    await refused(
      "product_enrichment",
      commit(tee.id, tee.entityId, sku(captured.evidenceId)),
      /changed before commit/,
    );

    await refused(
      "product_enrichment",
      { action: "finish_run", runId },
      /unresolved target work/,
    );
    expect(
      await ok("product_enrichment", {
        action: "skip_target",
        runId,
        productId: tee.id,
        outcome: "needs_review",
        reason: "Renamed while the run was open; recheck the variant",
      }),
    ).toMatchObject({ productId: tee.id, state: "unresolved" });
    expect(
      await ok("product_enrichment", {
        action: "skip_target",
        runId,
        productId: socks.id,
        outcome: "skipped",
        reason: "No exact vendor page",
      }),
    ).toMatchObject({ productId: socks.id, state: "skipped" });
    expect(
      await ok("product_enrichment", { action: "finish_run", runId }),
    ).toMatchObject({ status: "needs_review", findingCount: 1 });
    const learned = await getDb(ctx.db)
      .select({ id: entityExternalId.id })
      .from(entityExternalId)
      .where(
        and(
          eq(entityExternalId.entityId, tee.entityId),
          eq(entityExternalId.kind, "retailer_sku"),
        ),
      );
    expect(learned).toEqual([]);
  });

  it("refuses another member and a run-delegated coordinator", async () => {
    const tee = await importedProduct("Trail tee, olive, M (ownership)");
    const runId = await startRun([tee.id]);
    const otherUserId = testUserId("caller-enrichment-other-member");
    await getDb(ctx.db).insert(user).values({
      id: otherUserId,
      name: "Other Household Member",
      email: "other-enrichment-member@example.test",
      emailVerified: true,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    await insertWithShortcode(ctx.db, "ledgerParty", {
      name: "Other Enrichment Member",
      kind: "member",
      userId: otherUserId,
    });
    const asOther = { userId: otherUserId };
    await refused(
      "imports_read",
      { action: "enrichment_next", runId },
      /not owned by this member/,
      asOther,
    );
    await refused(
      "product_enrichment",
      {
        action: "capture_page",
        runId,
        productId: tee.id,
        url: `https://${VENDOR_HOST}/p/trail-tee-olive-m`,
      },
      /not owned by this member/,
      asOther,
    );
    await refused(
      "product_enrichment",
      {
        action: "skip_target",
        runId,
        productId: tee.id,
        outcome: "skipped",
        reason: "not mine",
      },
      /not owned by this member/,
      asOther,
    );
    await refused(
      "product_enrichment",
      { action: "finish_run", runId },
      /not owned by this member/,
      asOther,
    );

    // A coordinator delegated to an ordinary enrichment run never mounts the
    // caller-owned actions, so it cannot start or work one.
    const live = await getDb(ctx.db)
      .select({ fingerprint: runTarget.targetFingerprint })
      .from(runTarget)
      .limit(1);
    const delegated = await startTargetedRun(ctx.db, {
      ledgerPartyId: tee.partyId,
      purpose: "product_enrichment",
      vendorId: tee.vendorId,
      trigger: "manual",
      targets: [
        {
          kind: "product",
          productId: tee.entityId,
          targetFingerprint: live[0]!.fingerprint,
        },
      ],
    });
    if (!delegated.created) throw new Error("Expected a coordinator run");
    const purchaseAgent = { runId: delegated.run.id, grantId: "grant-test" };
    for (const args of [
      { action: "start_run", productIds: [tee.id] },
      {
        action: "capture_page",
        runId,
        productId: tee.id,
        url: `https://${VENDOR_HOST}/p/trail-tee-olive-m`,
      },
      {
        action: "skip_target",
        runId,
        productId: tee.id,
        outcome: "skipped",
        reason: "delegated",
      },
      { action: "finish_run", runId },
    ])
      await refused("product_enrichment", args, /does not mount/, {
        purchaseAgent,
      });
    expect(await runRow(runId)).toMatchObject({ status: "running" });
    const targets = await getDb(ctx.db)
      .select({ state: runTarget.state })
      .from(runTarget)
      .innerJoin(runTable, eq(runTable.id, runTarget.runId))
      .where(eq(runTable.shortcode, runId));
    expect(targets).toEqual([{ state: "pending" }]);
  });

  it("keeps caller-owned runs out of coordinator recovery", async () => {
    const tee = await importedProduct("Trail tee, olive, M (recovery)");
    const runId = await startRun([tee.id]);
    await pauseAuthorizedRuns(ctx.db, ctx.actor.userId);
    expect(await runRow(runId)).toMatchObject({ status: "running" });
    expect(
      (await resumeAuthorizedRuns(ctx.db, ctx.actor.userId)).map(
        (run) => run.publicId,
      ),
    ).not.toContain(runId);
    for (const action of ["retry_dispatch", "resume", "pause"] as const)
      await expect(
        controlRun(ctx.db, ctx.actor, { runPublicId: runId, action }),
      ).rejects.toThrow(/caller-owned/);
    expect(await runRow(runId)).toMatchObject({
      status: "running",
      dispatchEventId: null,
    });

    // An abandoned run is not left holding its targets: the stale-run sweep
    // reviews it without ever reaching a browser bridge.
    const noBridge = {
      getByName: () => {
        throw new Error("A caller-owned run reached the browser bridge");
      },
    };
    await expireStaleRuns(
      ctx.db,
      noBridge,
      new Date(Date.now() + 3 * 60 * 60_000),
    );
    expect(await runRow(runId)).toMatchObject({ status: "needs_review" });
  });
});
