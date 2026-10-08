import { entityFieldModels } from "@cubby/schemas/entity-fields";
import { parseEntityId, runEntityId } from "@cubby/schemas/identifiers";
import { researchToolInputs } from "@cubby/schemas/research-tools";
import {
  mailResearchRunInput,
  purchaseValidationResearchRunInput,
} from "@cubby/schemas/run-fields";
import { and, asc, eq, inArray, isNull, or } from "drizzle-orm";
import { z } from "zod";

import type { Database } from "~/server/db";
import {
  importSourceClaim,
  importSourceOrder,
  ledgerParty,
  mailboxMessage,
  orderMail,
  orderMailAttachment,
  product,
  run,
  runTarget,
} from "~/server/db/schema";
import type { PurchaseAgentQueueProducer } from "~/server/purchase-agent-queue-types";
import type { RunServices } from "~/server/purchase-agent/environment";
import {
  getDb,
  notDeleted,
  withTransaction,
} from "~/server/repo/database-helpers";
import { readCanonicalEntityIds } from "~/server/repo/entity-identity";
import {
  claimRunExecution,
  ExecutionLimitError,
} from "~/server/runs/execution-context";
import { executeLeasedOperation } from "~/server/runs/operation";
import { findSearchHits } from "~/server/services/search.service";

import { sweepImportedPurchases } from "./enrichment-sweep";
import {
  loadPurchaseValidationContext,
  readPurchaseValidationOriginal,
} from "./purchase-validation-research";
import { readReceiptResearchOriginal } from "./receipt-evidence";
import {
  loadProductPurchaseContext,
  loadRunPurchaseContext,
} from "./research-context";
import { assertResearchWork } from "./research-evidence";
import { assertResearchRunExecutable } from "./research-execution";
import {
  loadMailAttachmentOriginal,
  type ResearchAttachmentReader,
} from "./research-mail-attachments";
import { loadResearchObjectiveContext } from "./research-objective-context";
import {
  retainResearchObservation,
  webReadResearch,
  webSearchResearch,
  type ResearchObservationPorts,
} from "./research-observations";
import {
  assertResearchRunNotRetired,
  exposeResearchSources,
} from "./research-retention";
import { publishPendingResearchRetention } from "./research-retention-delivery";
import { loadMailResearchSources } from "./research-run";

type ResearchServices = Pick<
  RunServices,
  | "researchNext"
  | "researchObserve"
  | "researchResolve"
  | "researchMailSearch"
  | "researchMailRead"
  | "researchWebSearch"
  | "researchWebRead"
  | "researchFind"
  | "researchResume"
  | "researchAcknowledge"
>;
export type ResearchServicePorts = {
  observations?: ResearchObservationPorts;
  readAttachment?: ResearchAttachmentReader;
  queue?: PurchaseAgentQueueProducer;
};

/** Durable tools return JSON values, including on their first delivery. */
type ResearchServiceOutput = Exclude<
  Awaited<ReturnType<ResearchServices[keyof ResearchServices]>>,
  null | void
>;
const json = (value: ResearchServiceOutput) =>
  z.record(z.string(), z.json()).parse(JSON.parse(JSON.stringify(value)));
const activeStates = ["pending", "prepared", "needs_evidence"];
const mailReceivedTimestamp = (receivedAt: Date | null) =>
  receivedAt?.toISOString() ?? null;
type ResearchToolPayload = z.output<
  (typeof researchToolInputs)[keyof typeof researchToolInputs]
>;

/** One authority boundary for interactive investigation and unattended research. */
export function researchServiceFor(
  db: Database,
  env: Env,
  rawRunId: string,
  ports: ResearchServicePorts = {},
): ResearchServices {
  const runId = runEntityId.parse(rawRunId);
  const database = getDb(db);
  const call = async (
    kind: string,
    callId: string,
    payload: ResearchToolPayload,
    work: () => Promise<object>,
  ) => {
    await assertResearchRunExecutable(db, runId);
    return executeLeasedOperation(
      db,
      { runId, operationId: callId, kind: `research_${kind}`, payload },
      async () => {
        const output = await work();
        await assertResearchRunNotRetired(db, runId);
        return json(output);
      },
    );
  };
  const cloudWork = async (workRef: string) => {
    const owned = await assertResearchWork(db, runId, workRef);
    // Offline browser work must not fence mail, search, or public reads.
    if (owned.scope.status === "paused_offline") {
      await database
        .update(run)
        .set({ status: "running", updatedAt: new Date() })
        .where(and(eq(run.id, runId), eq(run.status, "paused_offline")));
    }
    if (owned.target.entityKind === "product")
      await claimRunExecution(db, runId, {
        kind: "product",
        productId: parseEntityId("product", owned.target.entityId),
      });
    return owned;
  };
  const owner = async () => {
    const [owned] = await database
      .select({ run })
      .from(run)
      .innerJoin(
        ledgerParty,
        and(
          eq(ledgerParty.id, run.ledgerPartyId),
          eq(ledgerParty.userId, run.actorUserId),
          eq(ledgerParty.kind, "member"),
          notDeleted(ledgerParty),
        ),
      )
      .where(and(eq(run.id, runId), notDeleted(run)))
      .limit(1);
    if (!owned) throw new Error("Research Run ownership is unavailable.");
    return owned.run;
  };
  const mailHeads = async () => {
    const sources = await loadMailResearchSources(db, runId);
    await exposeResearchSources(db, {
      runId,
      sources: (sources ?? []).map((source) => ({
        orderMailId: source.orderMailId,
        checksum: source.checksum,
      })),
    });
    return (
      sources?.map(({ orderMailId, sender, subject, receivedAt }) => ({
        messageRef: orderMailId,
        sender,
        subject,
        receivedAt,
      })) ?? []
    );
  };
  const readMail = async (
    workRef: string,
    messageRef: string,
    callId: string,
    attachmentRef?: string,
  ) => {
    const { scope, target } = await cloudWork(workRef);
    const [mail] = await database
      .select()
      .from(orderMail)
      .where(
        and(
          eq(orderMail.id, messageRef),
          eq(orderMail.ledgerPartyId, scope.ledgerPartyId!),
        ),
      )
      .limit(1);
    if (!mail) throw new Error("Retained mail does not belong to this member.");
    const receivedAt = mailReceivedTimestamp(mail.receivedAt);
    const frozen = mailResearchRunInput.safeParse(scope.input);
    const frozenSource = frozen.success
      ? frozen.data.sources.find((source) => source.orderMailId === mail.id)
      : undefined;
    if (frozenSource && frozenSource.checksum !== mail.rawChecksum)
      throw new Error("Mail source changed since admission.");
    const [message] = await database
      .select()
      .from(mailboxMessage)
      .where(
        and(
          eq(mailboxMessage.ledgerPartyId, scope.ledgerPartyId!),
          eq(mailboxMessage.mailboxId, mail.mailboxId),
          eq(mailboxMessage.messageId, mail.messageId),
        ),
      )
      .limit(1);
    if (
      !message ||
      message.orderMailId !== mail.id ||
      message.checksum !== mail.rawChecksum ||
      ["excluded", "deleted"].includes(message.status) ||
      message.classification === "unrelated"
    )
      throw new Error(
        "Mail source is unavailable or no longer retained for purchase research.",
      );
    const { exposeResearchSources } = await import("./research-retention");
    await exposeResearchSources(db, {
      runId,
      sources: [{ orderMailId: mail.id, checksum: mail.rawChecksum }],
    });
    let contextOnly =
      scope.purpose !== "mail_import" ||
      target.workKey !== mail.id ||
      Boolean(message.runId && message.runId !== runId);
    if (!contextOnly) {
      const claimed = await database
        .update(mailboxMessage)
        .set({ runId, status: "researching" })
        .where(
          and(
            eq(mailboxMessage.id, message.id),
            eq(mailboxMessage.checksum, mail.rawChecksum),
            or(isNull(mailboxMessage.runId), eq(mailboxMessage.runId, runId)),
          ),
        )
        .returning({ id: mailboxMessage.id });
      contextOnly = claimed.length === 0;
    }
    const attachments = await database
      .select({
        attachmentRef: orderMailAttachment.id,
        filename: orderMailAttachment.filename,
        mimeType: orderMailAttachment.mimeType,
        checksum: orderMailAttachment.checksum,
      })
      .from(orderMailAttachment)
      .where(eq(orderMailAttachment.orderMailId, mail.id));
    const originalAttachment = attachmentRef
      ? await loadMailAttachmentOriginal(
          db,
          { orderMailId: mail.id, attachmentRef },
          ports.readAttachment,
        )
      : undefined;
    const retained = await retainResearchObservation(
      db,
      {
        runId,
        workRef,
        callId,
        kind: "mail_message",
        sourceMetadata: {
          sourceURL: null,
          contextOnly,
          mailboxId: mail.mailboxId,
          messageId: mail.messageId,
          orderMailId: mail.id,
          checksum: mail.rawChecksum,
          sender: mail.sender,
          subject: mail.subject,
          receivedAt: receivedAt ?? undefined,
          attachmentRef: originalAttachment?.attachmentRef,
          attachmentChecksum: originalAttachment?.checksum,
        },
        content: JSON.stringify({
          sender: mail.sender,
          subject: mail.subject,
          receivedAt,
          content: mail.content,
          attachments,
          originalAttachment,
        }),
      },
      { ...ports.observations, keyPrefix: env.R2_KEY_PREFIX },
    );
    return {
      ...retained,
      attachments,
      originalAttachment,
    };
  };

  const services: ResearchServices = {
    researchNext(raw, callId) {
      const input = researchToolInputs.work_next.parse(raw);
      return call("next", callId, input, async () => {
        const scope = await owner();
        if (!["running", "paused_offline"].includes(scope.status))
          return { status: "stopped", reason: scope.status };
        const targets = await database
          .select()
          .from(runTarget)
          .where(eq(runTarget.runId, runId))
          .orderBy(asc(runTarget.createdAt), asc(runTarget.id));
        const { readResearchBrowserTasks, waitForPendingBrowserWork } =
          await import("./research-browser-service");
        const browserTasks = await readResearchBrowserTasks(db, runId);
        const pendingBrowser = browserTasks.blockedWorkRefs;
        const target = targets.find(
          (candidate) =>
            activeStates.includes(candidate.state) &&
            !pendingBrowser.has(candidate.id),
        );
        if (target) {
          try {
            await cloudWork(target.id);
          } catch (error) {
            if (error instanceof ExecutionLimitError)
              return { status: "stopped", reason: error.reason };
            throw error;
          }
          if (target.entityKind === "product") {
            const [current] = await database
              .select()
              .from(product)
              .where(
                and(
                  eq(product.id, parseEntityId("product", target.entityId)),
                  notDeleted(product),
                ),
              )
              .limit(1);
            if (!current) throw new Error("Research Product is unavailable.");
            return {
              status: "working",
              work: {
                workRef: target.id,
                retainedObservation: browserTasks.retainedByWork.get(target.id),
                kind: "product",
                product: {
                  productRef: current.shortcode,
                  name: current.name,
                  ...Object.fromEntries(
                    entityFieldModels.product.research.fillFields.map(
                      (field) => [field, current[field]],
                    ),
                  ),
                },
                purchasedItems: await loadProductPurchaseContext(db, {
                  productId: current.id,
                  ledgerPartyId: parseEntityId(
                    "ledgerParty",
                    scope.ledgerPartyId!,
                  ),
                }),
              },
            };
          }
          if (scope.purpose === "purchase_validation") {
            const context = await loadPurchaseValidationContext(
              db,
              scope,
              target,
            );
            return {
              status: "working",
              work: {
                workRef: target.id,
                kind: "purchase",
                retainedObservation: browserTasks.retainedByWork.get(target.id),
                purchase: {
                  purchaseRef: context.purchase.shortcode,
                  orderId: context.purchase.orderId,
                  statedTotal: context.purchase.statedTotal,
                  vendor: context.vendor,
                  lines: context.live.lines,
                },
                originalSource: context.source,
                manualEvidenceUnavailable:
                  purchaseValidationResearchRunInput
                    .parse(scope.input)
                    .purchases.find(
                      (item) => item.purchaseId === target.entityId,
                    )?.manualEvidenceUnavailable ?? false,
                evidenceStatus:
                  target.state === "needs_evidence"
                    ? "needs_evidence"
                    : "available",
              },
            };
          }
          const objective = await loadResearchObjectiveContext(
            db,
            scope,
            target,
          );
          if (objective)
            return {
              status: "working",
              work: {
                ...objective,
                retainedObservation: browserTasks.retainedByWork.get(target.id),
              },
            };
          const sources = await mailHeads();
          return {
            status: "working",
            work: {
              workRef: target.id,
              retainedObservation: browserTasks.retainedByWork.get(target.id),
              kind: "mail",
              purchaseContext: await loadRunPurchaseContext(db, {
                runId,
                ledgerPartyId: parseEntityId(
                  "ledgerParty",
                  scope.ledgerPartyId!,
                ),
              }),
              sources: sources.filter(
                (source) =>
                  !target.workKey || source.messageRef === target.workKey,
              ),
              contextSources: sources.filter(
                (source) =>
                  target.workKey && source.messageRef !== target.workKey,
              ),
            },
          };
        }
        if (pendingBrowser.size)
          return waitForPendingBrowserWork(db, env, runId);
        const summary = {
          verified: targets.filter((target) => target.outcome === "verified")
            .length,
          partiallyVerified: targets.filter(
            (target) => target.outcome === "partially_verified",
          ).length,
          researchedWithGaps: targets.filter(
            (target) => target.outcome === "researched_with_gaps",
          ).length,
          unrelated: targets.filter((target) => target.outcome === "unrelated")
            .length,
          unresolved: targets.filter((target) => target.state === "unresolved")
            .length,
        };
        if (["mail_import", "account_sync"].includes(scope.purpose)) {
          const accepted = await database
            .selectDistinct({ purchaseId: importSourceOrder.purchaseId })
            .from(importSourceOrder)
            .innerJoin(
              importSourceClaim,
              eq(importSourceClaim.id, importSourceOrder.sourceClaimId),
            )
            .where(
              and(
                eq(importSourceClaim.lastRunId, runId),
                eq(importSourceClaim.ledgerPartyId, scope.ledgerPartyId!),
              ),
            );
          // Admission is replay-safe and follows committed source associations.
          // Launch before settlement so a crash retries this durable handoff.
          await sweepImportedPurchases(
            db,
            accepted.map((source) => source.purchaseId),
            { queue: ports.queue },
          );
        }
        await withTransaction(db, async (tx) => {
          await tx
            .select({ id: run.id })
            .from(run)
            .where(eq(run.id, runId))
            .for("update");
          const [open] = await tx
            .select({ id: runTarget.id })
            .from(runTarget)
            .where(
              and(
                eq(runTarget.runId, runId),
                inArray(runTarget.state, activeStates),
              ),
            )
            .limit(1);
          if (open)
            throw new Error("Research work changed while completing the Run.");
          await tx
            .update(run)
            .set({
              status: summary.unresolved ? "needs_review" : "completed",
              endedAt: new Date(),
              updatedAt: new Date(),
            })
            .where(
              and(
                eq(run.id, runId),
                inArray(run.status, ["running", "paused_offline"]),
              ),
            );
        });
        return { status: "done", summary };
      });
    },
    researchMailRead(raw, callId) {
      const input = researchToolInputs.mail_read.parse(raw);
      return call("mail_read", callId, input, () =>
        readMail(input.workRef, input.messageRef, callId, input.attachmentRef),
      );
    },
    researchMailSearch(raw, callId) {
      const input = researchToolInputs.mail_search.parse(raw);
      return call("mail_search", callId, input, async () => {
        const { scope } = await cloudWork(input.workRef);
        const { searchResearchMail } = await import("./research-mail-search");
        return searchResearchMail(db, { runId, scope, input, callId });
      });
    },
    researchWebSearch(raw, callId) {
      const input = researchToolInputs.web_search.parse(raw);
      return call("web_search", callId, input, async () => {
        await cloudWork(input.workRef);
        return webSearchResearch(
          db,
          env,
          { runId, callId, ...input },
          ports.observations,
        );
      });
    },
    researchWebRead(raw, callId) {
      const input = researchToolInputs.web_read.parse(raw);
      return call("web_read", callId, input, async () => {
        await cloudWork(input.workRef);
        return webReadResearch(
          db,
          env,
          { runId, callId, ...input },
          ports.observations,
        );
      });
    },
    researchFind(raw, callId) {
      const input = researchToolInputs.cubby_find.parse(raw);
      return call("find", callId, input, async () => {
        await cloudWork(input.workRef);
        return {
          results: await findSearchHits(db, { query: input.query, limit: 20 }),
        };
      });
    },
    async researchResolve(raw, callId) {
      const proposal = researchToolInputs.work_resolve.parse(raw);
      await assertResearchRunExecutable(db, runId);
      await owner();
      const [target] = await database
        .select()
        .from(runTarget)
        .where(
          and(eq(runTarget.id, proposal.workRef), eq(runTarget.runId, runId)),
        )
        .limit(1);
      if (!target)
        throw new Error("Research work does not belong to this Run.");
      // The resolver's durable receipt precedes its active-target fence, so
      // a response lost after commit remains replayable after settlement.
      const resolution = await (async () => {
        if (target.entityKind === "product") {
          const { resolveProductResearch } = await import("./research-product");
          return await resolveProductResearch(
            db,
            { runId, callId, proposal },
            ports.observations?.storage?.get
              ? {
                  readEvidence: (row) =>
                    ports.observations!.storage!.get!(row.objectKey),
                }
              : {},
          );
        }
        const { resolveImportResearch } = await import("./research-import");
        return await resolveImportResearch(db, {
          runId,
          workRef: proposal.workRef,
          callId,
          proposal,
        });
      })();
      if ("status" in resolution && resolution.status === "unrelated") {
        if (!resolution.retirement)
          throw new Error(
            "Unrelated research resolution has no retained cleanup receipt.",
          );
        await publishPendingResearchRetention(db, {
          receiptId: resolution.retirement.receiptId,
          queue: ports.queue,
        });
        return json({
          status: "stopped",
          reason: "unrelated_source",
          resolution,
        });
      }
      const next = await services.researchNext({}, `${callId}:next`);
      if ("purchaseIds" in resolution) {
        const {
          purchaseIds: _purchaseIds,
          productIds,
          eventIds: _eventIds,
          ...publicResolution
        } = resolution;
        const scope = await owner();
        const productIdentities = await readCanonicalEntityIds(
          db,
          "product",
          productIds,
        );
        const products = productIdentities.size
          ? await database
              .select({ productRef: product.shortcode })
              .from(product)
              .where(
                and(
                  inArray(
                    product.id,
                    [...productIdentities.values()].map((id) =>
                      parseEntityId("product", id),
                    ),
                  ),
                  notDeleted(product),
                ),
              )
          : [];
        return json({
          ...next,
          resolution: {
            ...publicResolution,
            purchaseContext: await loadRunPurchaseContext(db, {
              runId,
              ledgerPartyId: parseEntityId("ledgerParty", scope.ledgerPartyId!),
            }),
            productRefs: products.map((item) => item.productRef),
          },
        });
      }
      return json({ ...next, resolution });
    },
    async researchObserve(raw, callId) {
      await assertResearchRunExecutable(db, runId);
      const input = researchToolInputs.work_observe.parse(raw);
      if (input.action.kind === "read") {
        const { scope, target } = await cloudWork(input.workRef);
        const originalAttachment =
          scope.purpose === "purchase_validation"
            ? await readPurchaseValidationOriginal(
                db,
                scope,
                target,
                ports.readAttachment,
              )
            : await readReceiptResearchOriginal(
                db,
                scope,
                target,
                ports.readAttachment,
              );
        if (originalAttachment) {
          return call("observe_receipt", callId, input, async () => {
            const retained = await retainResearchObservation(
              db,
              {
                runId,
                workRef: target.id,
                callId,
                kind: "upload_evidence",
                sourceMetadata: {
                  ...(scope.purpose === "purchase_validation"
                    ? { originalEvidenceId: originalAttachment.attachmentRef }
                    : { imageId: originalAttachment.attachmentRef }),
                  originalChecksum: originalAttachment.checksum,
                  attachmentRef: originalAttachment.attachmentRef,
                  attachmentChecksum: originalAttachment.checksum,
                  title: originalAttachment.filename,
                  sourceURL: null,
                },
                content: JSON.stringify({ originalAttachment }),
              },
              { keyPrefix: env.R2_KEY_PREFIX, ...ports.observations },
            );
            return {
              status: "observed",
              evidenceId: retained.evidenceId,
              originalAttachment,
              observation: retained,
            };
          });
        }
        if (scope.purpose === "purchase_validation") {
          const { readResearchBrowserTasks } =
            await import("./research-browser-service");
          const browser = await readResearchBrowserTasks(db, runId);
          if (!browser.retainedByWork.has(target.id))
            return json({
              status: "needs_evidence",
              workRef: target.id,
              detail:
                "No verified original upload is available. Investigate owned mail or public sources, or navigate an authenticated browser explicitly.",
            });
        }
      }
      const { researchBrowserFor } = await import("./research-browser-service");
      return json(
        await researchBrowserFor(db, env, runId, ports.observations).observe(
          input,
          callId,
        ),
      );
    },
    async researchResume(signal) {
      await assertResearchRunExecutable(db, runId);
      const { researchBrowserFor } = await import("./research-browser-service");
      const result = await researchBrowserFor(
        db,
        env,
        runId,
        ports.observations,
      ).resume(signal);
      return result ? json(result) : null;
    },
    async researchAcknowledge(signal) {
      await assertResearchRunExecutable(db, runId);
      const { acknowledgeResearchBrowserObservation } =
        await import("./research-browser-service");
      await acknowledgeResearchBrowserObservation(db, runId, signal);
    },
  };
  return services;
}
