import type {
  DurableObjectState,
  WebSocket as CfWebSocket,
} from "@cloudflare/workers-types";
import { buildActorContext } from "@cubby/schemas/context";
import { parseEntityId, userId } from "@cubby/schemas/identifiers";
import type { BrowserBridgeRequest } from "@cubby/schemas/purchase-import";
import { vendorAccountCursor } from "@cubby/schemas/vendor-account-fields";
import { DurableObject } from "cloudflare:workers";
import { and, eq, gt, inArray, isNotNull } from "drizzle-orm";
import { z } from "zod";

import { runWithExecutionCtx, setCfEnv } from "~/server/cf-env";

import {
  bridgeServerMessage,
  decodeBrowserBridgeMessage,
  type BrowserBridgeResult,
  type PurchaseImportDurableObjectRpc,
} from "./contracts";
import { PurchaseImportSqlStore } from "./sql-store";

declare const WebSocketPair: {
  new (): { 0: WebSocket; 1: CfWebSocket };
};

type SocketAttachment = {
  protocolVersion: 1;
  ledgerPartyId: string;
  vendorAccountId: string;
  userId: string;
  enhancedScreenshot?: boolean;
};

type HuntTarget = {
  id: string;
  orderIds: string[];
  amount: number;
  dateFrom: string;
  dateTo: string;
};

const candidateMatchesHunt = (
  candidate: {
    orderId: string | null;
    orderedAt: string | null;
    printedGrandTotal: number | null;
    payments: { amount: number; chargedAt?: string }[];
  },
  hunt: HuntTarget,
) => {
  if (hunt.orderIds.length > 0)
    return (
      candidate.orderId !== null && hunt.orderIds.includes(candidate.orderId)
    );
  const amountInCents = Math.round(Math.abs(hunt.amount) * 100);
  const inWindow = (value: string | null | undefined) => {
    if (!value) return false;
    const date = value.slice(0, 10);
    return date >= hunt.dateFrom && date <= hunt.dateTo;
  };
  if (
    candidate.payments.some(
      (payment) =>
        Math.round(Math.abs(payment.amount) * 100) === amountInCents &&
        inWindow(payment.chargedAt),
    )
  )
    return true;
  return (
    candidate.printedGrandTotal !== null &&
    Math.round(Math.abs(candidate.printedGrandTotal) * 100) === amountInCents &&
    inWindow(candidate.orderedAt)
  );
};
const socketAttachment = z.object({
  protocolVersion: z.literal(1),
  ledgerPartyId: z.string().min(1),
  vendorAccountId: z.string().min(1),
  userId: z.string().min(1),
  enhancedScreenshot: z.boolean().optional(),
});

export class PurchaseImportDurableObject
  extends DurableObject<Env>
  implements PurchaseImportDurableObjectRpc
{
  private readonly store: PurchaseImportSqlStore;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.store = new PurchaseImportSqlStore(ctx.storage);
    this.store.migrate();
  }

  async fetch(request: Request): Promise<Response> {
    if (request.headers.get("upgrade")?.toLowerCase() !== "websocket")
      return new Response("WebSocket upgrade required", { status: 426 });

    const ledgerPartyId = request.headers.get("x-cubby-ledger-party-id");
    const vendorAccountId = request.headers.get("x-cubby-vendor-account-id");
    const userId = request.headers.get("x-cubby-user-id");
    if (!ledgerPartyId || !vendorAccountId || !userId)
      return new Response("Authenticated ownership context required", {
        status: 403,
      });

    const pair = new WebSocketPair();
    const client = pair[0];
    const server = pair[1];
    this.ctx.acceptWebSocket(server);
    server.serializeAttachment({
      protocolVersion: 1,
      ledgerPartyId,
      vendorAccountId,
      userId,
    } satisfies SocketAttachment);
    // SAFETY: Cloudflare extends ResponseInit with the WebSocket upgrade slot.
    const responseInit = {
      status: 101,
      webSocket: client,
    } as ResponseInit & { webSocket: WebSocket };
    return new Response(null, responseInit);
  }

  async enqueue(command: BrowserBridgeRequest): Promise<void> {
    this.store.enqueue(command);
    this.broadcast(command);
  }

  async result(requestId: string): Promise<BrowserBridgeResult | null> {
    return this.store.result(requestId);
  }

  async cancel(requestId: string): Promise<void> {
    this.store.cancel(requestId);
    this.broadcastMessage({ version: 1, type: "cancel", commandID: requestId });
  }

  // Socket lifecycle handling is kept together so result persistence always
  // precedes acknowledgement and a follow-up capture.
  // eslint-disable-next-line complexity
  async webSocketMessage(
    socket: CfWebSocket,
    message: string | ArrayBuffer,
  ): Promise<void> {
    const parsed = decodeBrowserBridgeMessage(message);
    if (!parsed.success) {
      socket.close(1008, "Invalid bridge message");
      return;
    }
    if (parsed.data.type === "hello") {
      const attachment = socketAttachment
        .nullable()
        .parse(socket.deserializeAttachment());
      if (attachment) {
        socket.serializeAttachment({
          ...attachment,
          enhancedScreenshot: parsed.data.capabilities.enhancedScreenshot,
        } satisfies SocketAttachment);
      }
      this.replay(socket);
      return;
    }
    if (parsed.data.type === "result") {
      const command = this.store.claimResult(parsed.data.result);
      if (!command) {
        socket.send(
          JSON.stringify(
            bridgeServerMessage.parse({
              version: 1,
              type: "acknowledge",
              commandID: parsed.data.result.commandID,
            }),
          ),
        );
        return;
      }
      try {
        if (parsed.data.result.outcome.status === "failed") {
          const attachment = socketAttachment
            .nullable()
            .parse(socket.deserializeAttachment());
          if (attachment) {
            await this.recordBridgeFailure(
              attachment,
              parsed.data.result.runID,
              parsed.data.result.outcome.code,
              parsed.data.result.outcome.message,
            );
          }
        }
        if (
          command?.operation.type === "capture" &&
          parsed.data.result.outcome.status === "completed"
        ) {
          const attachment = socketAttachment
            .nullable()
            .parse(socket.deserializeAttachment());
          if (attachment && parsed.data.result.outcome.capture) {
            await this.processCapture(
              attachment,
              parsed.data.result,
              command.operation.allowedHosts,
            );
          }
        }
        socket.send(
          JSON.stringify(
            bridgeServerMessage.parse({
              version: 1,
              type: "acknowledge",
              commandID: parsed.data.result.commandID,
            }),
          ),
        );
        if (parsed.data.result.outcome.status === "completed") {
          if (
            command.operation.type === "navigate" ||
            command.operation.type === "follow_captured_link" ||
            command.operation.type === "scroll"
          ) {
            const captureHosts =
              command.operation.type === "scroll"
                ? this.store.runState(command.runID)?.allowedHosts
                : command.operation.allowedHosts;
            if (!captureHosts)
              throw new Error("Purchase import run state is unavailable");
            const attachment = socketAttachment
              .nullable()
              .parse(socket.deserializeAttachment());
            const capture = {
              id: crypto.randomUUID(),
              runID: command.runID,
              deadline: command.deadline,
              operation: {
                type: "capture" as const,
                allowedHosts: captureHosts,
                enhancedEvidence: attachment?.enhancedScreenshot ?? false,
              },
            };
            this.store.enqueue(capture);
            this.send(socket, capture);
          }
        }
      } catch (error) {
        this.store.retryResult(parsed.data.result.commandID);
        throw error;
      }
    }
  }

  webSocketError(_socket: CfWebSocket, error: Error): void {
    console.error("purchase-import.bridge.websocket", error);
  }

  webSocketClose(
    socket: CfWebSocket,
    code: number,
    reason: string,
    wasClean: boolean,
  ): void {
    socket.close(code, wasClean ? reason : "Bridge disconnected");
  }

  private replay(socket: CfWebSocket): void {
    for (const command of this.store.replayable()) {
      this.send(socket, command);
    }
  }

  private broadcast(command: BrowserBridgeRequest): void {
    for (const socket of this.ctx.getWebSockets()) this.send(socket, command);
  }

  private send(socket: CfWebSocket, command: BrowserBridgeRequest): void {
    socket.send(
      JSON.stringify(
        bridgeServerMessage.parse({ version: 1, type: "command", command }),
      ),
    );
    this.store.markSent(command.id);
  }

  private broadcastMessage(message: unknown): void {
    const encoded = JSON.stringify(bridgeServerMessage.parse(message));
    for (const socket of this.ctx.getWebSockets()) socket.send(encoded);
  }

  private async recordBridgeFailure(
    attachment: SocketAttachment,
    runId: string,
    code: string,
    message: string,
  ): Promise<void> {
    const connectionString = this.env.HYPERDRIVE?.connectionString;
    if (!connectionString) return;
    const [{ db, withRequestDbClient }, schema, repo] = await Promise.all([
      import("~/server/db"),
      import("~/server/db/schema"),
      import("~/server/repo/database-helpers"),
    ]);
    await withRequestDbClient(connectionString, async () => {
      const database = repo.getDb(db);
      const authRequired = code === "authentication_required";
      await database
        .update(schema.importRun)
        .set({
          status: authRequired ? "paused_auth" : "failed",
          failureCode: `${code}:${message}`.slice(0, 2_000),
          endedAt: authRequired ? null : new Date(),
          updatedAt: new Date(),
        })
        .where(eq(schema.importRun.id, z.uuid().parse(runId)));
      await database
        .update(schema.vendorAccount)
        .set({
          status: authRequired ? "paused_auth" : "paused_offline",
          updatedAt: new Date(),
        })
        .where(
          eq(
            schema.vendorAccount.id,
            parseEntityId("vendorAccount", attachment.vendorAccountId),
          ),
        );
    });
  }

  private async processCapture(
    attachment: SocketAttachment,
    result: BrowserBridgeResult,
    allowedHosts: string[],
  ): Promise<void> {
    if (result.outcome.status !== "completed" || !result.outcome.capture)
      return;
    const connectionString = this.env.HYPERDRIVE?.connectionString;
    if (!connectionString)
      throw new Error("Purchase import database is unavailable");
    setCfEnv(this.env);
    const capture = result.outcome.capture;
    const stableCapture = {
      sourceURL: capture.sourceURL,
      title: capture.title,
      readableText: capture.readableText,
      links: capture.links.map(({ url, label }) => ({ url, label })),
      images: capture.images.map(({ url, alt }) => ({ url, alt })),
    };
    const bytes = new TextEncoder().encode(JSON.stringify(stableCapture));
    const digest = await crypto.subtle.digest("SHA-256", bytes);
    const checksum = [...new Uint8Array(digest)]
      .map((byte) => byte.toString(16).padStart(2, "0"))
      .join("");
    const [
      { db, withRequestDbClient },
      schema,
      repo,
      resolver,
      agent,
      writer,
      findings,
      gmail,
    ] = await Promise.all([
      import("~/server/db"),
      import("~/server/db/schema"),
      import("~/server/repo/database-helpers"),
      import("~/server/repo/shortcode-resolver"),
      import("~/server/agents/purchase-import/extract"),
      import("./writer"),
      import("./findings"),
      import("./gmail/process"),
    ]);
    await runWithExecutionCtx(
      { waitUntil: (task) => this.ctx.waitUntil(task) },
      () =>
        // This callback is the explicit durable state-machine boundary:
        // splitting branches would obscure acknowledgement and replay rules.
        // eslint-disable-next-line complexity
        withRequestDbClient(connectionString, async () => {
          const database = repo.getDb(db);
          const [owned] = await database
            .select({
              vendorId: schema.vendorAccount.vendorId,
              cursor: schema.vendorAccount.cursor,
            })
            .from(schema.vendorAccount)
            .where(
              and(
                eq(
                  schema.vendorAccount.id,
                  parseEntityId("vendorAccount", attachment.vendorAccountId),
                ),
                eq(
                  schema.vendorAccount.ledgerPartyId,
                  parseEntityId("ledgerParty", attachment.ledgerPartyId),
                ),
                repo.notDeleted(schema.vendorAccount),
              ),
            )
            .limit(1);
          if (!owned)
            throw new Error("Browser bridge ownership changed during the run");
          const runState = this.store.advanceRun(result.runID);
          if (!runState)
            throw new Error("Purchase import run state is unavailable");
          const captureInput = {
            url: capture.sourceURL,
            title: capture.title,
            text: capture.readableText,
            links: capture.links.map((link) => ({
              id: link.id,
              href: link.url,
              text: link.label ?? "",
            })),
            images: capture.images.map((image) => ({
              src: image.url,
              alt: image.alt ?? "",
            })),
            capturedAt: capture.capturedAt,
          };
          const screenshot = capture.evidence.find(
            (item) => item.kind === "screenshot",
          );
          const uuid = z.uuid();
          const runId = uuid.parse(result.runID);
          const accountId = parseEntityId(
            "vendorAccount",
            attachment.vendorAccountId,
          );
          const [queuedHunt] = await database
            .select({
              id: schema.importHunt.id,
              orderIds: schema.importHunt.matchedOrderIds,
              amount: schema.financialTransaction.amount,
              dateFrom: schema.importHunt.dateFrom,
              dateTo: schema.importHunt.dateTo,
            })
            .from(schema.importHunt)
            .innerJoin(
              schema.financialTransaction,
              eq(
                schema.financialTransaction.id,
                schema.importHunt.financialTransactionId,
              ),
            )
            .where(
              and(
                eq(schema.importHunt.vendorAccountId, accountId),
                eq(schema.importHunt.state, "browser_queued"),
              ),
            )
            .limit(1);
          const extraction = await agent.extractPurchaseCapture({
            db,
            runId: result.runID,
            capture: captureInput,
            screenshotImageId: screenshot?.id,
          });

          const finishRun = async () => {
            const [runRecord] = await database
              .select({ trigger: schema.importRun.trigger })
              .from(schema.importRun)
              .where(eq(schema.importRun.id, runId))
              .limit(1);
            const importedPurchases = await database
              .selectDistinct({
                id: schema.purchase.id,
                orderId: schema.purchase.orderId,
                statedTotal: schema.purchase.statedTotal,
                displayLabel: schema.purchase.displayLabel,
              })
              .from(schema.importRunMutation)
              .innerJoin(
                schema.purchase,
                and(
                  eq(schema.purchase.id, schema.importRunMutation.targetId),
                  repo.notDeleted(schema.purchase),
                ),
              )
              .where(
                and(
                  eq(schema.importRunMutation.runId, runId),
                  eq(schema.importRunMutation.targetType, "purchase"),
                ),
              );
            if (
              runRecord?.trigger === "discovery" &&
              importedPurchases.length === 0
            ) {
              await database
                .update(schema.importHunt)
                .set({
                  state: "expected_order_not_found",
                  error: "The vendor order page could not be extracted.",
                  updatedAt: new Date(),
                })
                .where(
                  and(
                    eq(schema.importHunt.vendorAccountId, accountId),
                    eq(schema.importHunt.state, "browser_queued"),
                  ),
                );
            }
            if (importedPurchases.length > 0) {
              const purchaseIds = importedPurchases.map(({ id }) => id);
              const [expenseRows, paymentRows] = await Promise.all([
                database
                  .select({
                    purchaseId: schema.expense.purchaseId,
                    id: schema.expense.id,
                    name: schema.expense.name,
                    amount: schema.expense.cost,
                    lineKind: schema.expense.lineKind,
                    quantity: schema.expense.productQuantity,
                    productId: schema.product.id,
                    productName: schema.product.name,
                    productManufacturer: schema.product.manufacturer,
                    productModel: schema.product.model,
                  })
                  .from(schema.importRunMutation)
                  .innerJoin(
                    schema.expense,
                    and(
                      eq(schema.expense.id, schema.importRunMutation.targetId),
                      repo.notDeleted(schema.expense),
                    ),
                  )
                  .leftJoin(
                    schema.product,
                    and(
                      eq(schema.product.id, schema.expense.productId),
                      repo.notDeleted(schema.product),
                    ),
                  )
                  .where(
                    and(
                      eq(schema.importRunMutation.runId, runId),
                      eq(schema.importRunMutation.targetType, "expense"),
                      inArray(schema.expense.purchaseId, purchaseIds),
                    ),
                  ),
                database
                  .select({
                    purchaseId: schema.purchasePaymentEvidence.purchaseId,
                    amount: schema.purchasePaymentEvidence.amount,
                    chargedAt: schema.purchasePaymentEvidence.chargedAt,
                    cardLastFour: schema.purchasePaymentEvidence.cardLastFour,
                    description: schema.purchasePaymentEvidence.description,
                  })
                  .from(schema.purchasePaymentEvidence)
                  .where(
                    inArray(
                      schema.purchasePaymentEvidence.purchaseId,
                      purchaseIds,
                    ),
                  ),
              ]);
              const audit = await agent.auditPurchaseImportBatch({
                db,
                runId: result.runID,
                renderedBatch: importedPurchases.map((purchase) => ({
                  ...purchase,
                  expenses: expenseRows
                    .filter((row) => row.purchaseId === purchase.id)
                    .map((row) => ({
                      id: row.id,
                      name: row.name,
                      amount: row.amount,
                      lineKind: row.lineKind,
                      quantity: row.quantity,
                      product: row.productId
                        ? {
                            id: row.productId,
                            name: row.productName,
                            manufacturer: row.productManufacturer,
                            model: row.productModel,
                          }
                        : null,
                    })),
                  paymentEvidence: paymentRows
                    .filter((row) => row.purchaseId === purchase.id)
                    .map(({ purchaseId: _purchaseId, ...row }) => row),
                })),
              });
              const ownedIds = new Set(importedPurchases.map((row) => row.id));
              for (const finding of audit.findings) {
                const targetId = parseEntityId(
                  "purchase",
                  finding.targetPurchaseId,
                );
                if (!ownedIds.has(targetId)) continue;
                const findingDigest = await crypto.subtle.digest(
                  "SHA-256",
                  new TextEncoder().encode(JSON.stringify(finding)),
                );
                const evidenceFingerprint = [...new Uint8Array(findingDigest)]
                  .map((byte) => byte.toString(16).padStart(2, "0"))
                  .join("");
                const [storedFinding] = await database
                  .insert(schema.importFinding)
                  .values({
                    importRunId: runId,
                    ledgerPartyId: parseEntityId(
                      "ledgerParty",
                      attachment.ledgerPartyId,
                    ),
                    targetType: "purchase",
                    targetId,
                    kind: finding.kind,
                    summary: finding.summary,
                    proposedFix: finding.proposedFix,
                    evidenceFingerprint,
                    probability: finding.probability,
                  })
                  .onConflictDoNothing()
                  .returning({ id: schema.importFinding.id });
                if (
                  storedFinding &&
                  finding.probability >= 0.95 &&
                  finding.proposedFix?.kind === "relink_product"
                ) {
                  const expenseId = parseEntityId(
                    "expense",
                    finding.proposedFix.expenseId,
                  );
                  const [mutation] = await database
                    .select({ createdAt: schema.importRunMutation.createdAt })
                    .from(schema.importRunMutation)
                    .where(
                      and(
                        eq(schema.importRunMutation.runId, runId),
                        eq(schema.importRunMutation.targetType, "expense"),
                        eq(schema.importRunMutation.targetId, expenseId),
                      ),
                    )
                    .limit(1);
                  const [laterHumanAudit] = mutation
                    ? await database
                        .select({ id: schema.auditLog.id })
                        .from(schema.auditLog)
                        .where(
                          and(
                            eq(schema.auditLog.entityType, "expense"),
                            eq(schema.auditLog.entityId, expenseId),
                            gt(schema.auditLog.createdAt, mutation.createdAt),
                          ),
                        )
                        .limit(1)
                    : [];
                  if (mutation && !laterHumanAudit) {
                    await findings.resolveImportFinding(
                      db,
                      { id: storedFinding.id, action: "apply" },
                      buildActorContext(userId.parse(attachment.userId), "api"),
                    );
                  }
                }
              }
            }
            await database
              .update(schema.importRun)
              .set({
                status: "completed",
                endedAt: new Date(),
                updatedAt: new Date(),
              })
              .where(eq(schema.importRun.id, runId));
            await database
              .update(schema.vendorAccount)
              .set({
                status: "active",
                lastSuccessAt: new Date(),
                updatedAt: new Date(),
              })
              .where(eq(schema.vendorAccount.id, accountId));
          };

          if (extraction.status === "unreadable" && !extraction.candidate) {
            const knownOrders = await database
              .select({ orderId: schema.purchase.orderId })
              .from(schema.purchase)
              .where(
                and(
                  eq(schema.purchase.vendorAccountId, accountId),
                  isNotNull(schema.purchase.orderId),
                  repo.notDeleted(schema.purchase),
                ),
              );
            if (runState.steps >= 30) {
              await finishRun();
              return;
            }
            const navigationInput = {
              db,
              runId: result.runID,
              capture: captureInput,
              knownOrderIds: knownOrders.flatMap(({ orderId }) =>
                orderId ? [orderId] : [],
              ),
              stepsRemaining: 30 - runState.steps,
            };
            const decision = await agent.choosePurchaseImportNavigation(
              queuedHunt
                ? {
                    ...navigationInput,
                    huntTarget: {
                      orderIds: queuedHunt.orderIds,
                      amount: queuedHunt.amount,
                      dateFrom: queuedHunt.dateFrom,
                      dateTo: queuedHunt.dateTo,
                    },
                  }
                : navigationInput,
            );
            if (decision.action === "finish") {
              await finishRun();
              return;
            }
            const operation =
              decision.action === "scroll"
                ? ({
                    type: "scroll" as const,
                    pageCount: decision.pageCount,
                  } as const)
                : ({
                    type: "follow_captured_link" as const,
                    linkID: decision.linkId,
                    allowedHosts,
                  } as const);
            if (
              decision.action === "follow_link" &&
              !capture.links.some((link) => link.id === decision.linkId)
            ) {
              throw new Error("Navigation selected a link outside the capture");
            }
            const next = {
              id: crypto.randomUUID(),
              runID: result.runID,
              deadline: new Date(Date.now() + 5 * 60_000).toISOString(),
              operation,
            } satisfies BrowserBridgeRequest;
            this.store.enqueue(next);
            this.broadcast(next);
            return;
          }
          if (
            queuedHunt &&
            extraction.candidate &&
            !candidateMatchesHunt(extraction.candidate, queuedHunt)
          ) {
            if (queuedHunt.orderIds.length > 0 || runState.steps >= 30) {
              await finishRun();
              return;
            }
            const backToList = {
              id: crypto.randomUUID(),
              runID: result.runID,
              deadline: new Date(Date.now() + 5 * 60_000).toISOString(),
              operation: {
                type: "navigate" as const,
                url: runState.rootUrl,
                allowedHosts: runState.allowedHosts,
              },
            } satisfies BrowserBridgeRequest;
            this.store.enqueue(backToList);
            this.broadcast(backToList);
            return;
          }
          const primaryEvidence = capture.evidence.find(
            (item) =>
              item.kind === "normalized_pdf" || item.kind === "rendered_pdf",
          );
          const writeResult = await writer.importVendorOrder(
            db,
            {
              runId,
              ledgerPartyId: uuid.parse(attachment.ledgerPartyId),
              vendorId: owned.vendorId,
              vendorAccountId: accountId,
              source: {
                kind: "browser_order",
                externalKey: capture.sourceURL,
                checksum,
              },
              extraction,
              primaryDocumentImageId: primaryEvidence
                ? await resolver.resolveOrThrow(db, "image", primaryEvidence.id)
                : null,
              screenshotImageId: screenshot
                ? await resolver.resolveOrThrow(db, "image", screenshot.id)
                : null,
            },
            attachment.userId,
          );
          if (writeResult.purchaseId && extraction.candidate?.orderId) {
            const [writtenPurchase] = await database
              .select({ shortcode: schema.purchase.shortcode })
              .from(schema.purchase)
              .where(
                eq(
                  schema.purchase.id,
                  parseEntityId("purchase", writeResult.purchaseId),
                ),
              )
              .limit(1);
            if (writtenPurchase) {
              await gmail.attachPendingOrderMailEvidence(db, {
                vendorId: owned.vendorId,
                orderId: extraction.candidate.orderId,
                purchaseShortcode: writtenPurchase.shortcode,
              });
            }
          }
          const orderAt = extraction.candidate?.orderedAt ?? null;
          const orderId = extraction.candidate?.orderId ?? null;
          if (orderAt) {
            const cursor = vendorAccountCursor.parse(owned.cursor);
            const newestOrderAt =
              !cursor.newestOrderAt || orderAt > cursor.newestOrderAt
                ? orderAt
                : cursor.newestOrderAt;
            const orderIdsOnNewestDate =
              !cursor.newestOrderAt || orderAt > cursor.newestOrderAt
                ? orderId
                  ? [orderId]
                  : []
                : cursor.newestOrderAt.slice(0, 10) === orderAt.slice(0, 10)
                  ? [
                      ...new Set([
                        ...cursor.orderIdsOnNewestDate,
                        ...(orderId ? [orderId] : []),
                      ]),
                    ]
                  : cursor.orderIdsOnNewestDate;
            await database
              .update(schema.vendorAccount)
              .set({
                cursor: {
                  ...cursor,
                  newestOrderAt,
                  orderIdsOnNewestDate,
                  backfillBeforeOrderAt:
                    !cursor.backfillBeforeOrderAt ||
                    orderAt < cursor.backfillBeforeOrderAt
                      ? orderAt
                      : cursor.backfillBeforeOrderAt,
                },
                updatedAt: new Date(),
              })
              .where(eq(schema.vendorAccount.id, accountId));
          }
          const [run] = await database
            .select({ trigger: schema.importRun.trigger })
            .from(schema.importRun)
            .where(eq(schema.importRun.id, runId))
            .limit(1);
          if (run?.trigger === "discovery" || runState.steps >= 30) {
            if (run?.trigger === "discovery") {
              await database
                .update(schema.importHunt)
                .set({ state: "resolved", updatedAt: new Date() })
                .where(
                  and(
                    queuedHunt
                      ? eq(schema.importHunt.id, queuedHunt.id)
                      : eq(schema.importHunt.vendorAccountId, accountId),
                    eq(schema.importHunt.state, "browser_queued"),
                  ),
                );
            }
            await finishRun();
            return;
          }
          const backToList = {
            id: crypto.randomUUID(),
            runID: result.runID,
            deadline: new Date(Date.now() + 5 * 60_000).toISOString(),
            operation: {
              type: "navigate" as const,
              url: runState.rootUrl,
              allowedHosts: runState.allowedHosts,
            },
          } satisfies BrowserBridgeRequest;
          this.store.enqueue(backToList);
          this.broadcast(backToList);
        }),
      this.env.APP_ORIGIN,
    );
  }
}
