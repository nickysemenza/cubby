/** Failures: preview stops before fallback, reruns a definite decision, or
 * publishes classification/history/content while measuring the pipeline. */
import { executionAuthorizationInput } from "@cubby/schemas/execution-authorization";
import { mailTriagePreviewOut } from "@cubby/schemas/mailbox-research";
import { eq } from "drizzle-orm";
import { withTestDb } from "tooling/test-setup";
import { afterEach, describe, expect, it, vi } from "vitest";

import { account } from "~/server/db/auth.schema";
import { getDb } from "~/server/db/helpers";
import {
  email,
  emailClassificationObservation,
  orderMail,
  run,
} from "~/server/db/schema";
import { issueExecutionAuthorization } from "~/server/domains/run/repo/execution-authorization";
import { insertWithShortcode } from "~/server/generic/shortcode/repo/shortcode-utils";
import { requireActor } from "~/server/http/request-context";
import { McpOperationContext } from "~/server/mcp/operation-context";
import { createMcpServer } from "~/server/mcp/server";
import { callMcpTool } from "~/server/testing/mcp-test-utils";
import { createTestRequestContext } from "~/server/testing/request-context";

import * as providers from "../../repo/gmail/provider";
import type { GmailProvider } from "../../repo/gmail/types";
import { previewMailTriage } from "./reclassify";
import type { MailRelevance } from "./relevance";
import * as runners from "./triage-model";

describe("full read-only Email preview", () => {
  const ctx = withTestDb();
  afterEach(() => vi.restoreAllMocks());

  it.each(["uncertain", "related", "unrelated"] as const)(
    "routes %s and leaves Email evidence unchanged",
    async (classification) => {
      const mailboxId = "synthetic-preview-mailbox";
      const party = await insertWithShortcode(ctx.db, "ledgerParty", {
        name: "Synthetic preview member",
        kind: "member",
        userId: ctx.actor.userId,
      });
      await getDb(ctx.db).insert(account).values({
        id: crypto.randomUUID(),
        accountId: mailboxId,
        providerId: "google",
        userId: ctx.actor.userId,
        updatedAt: new Date(),
      });
      await issueExecutionAuthorization(
        ctx.db,
        ctx.actor,
        executionAuthorizationInput.parse({
          kind: "execution_authorization",
          version: 1,
          owner: { userId: ctx.actor.userId, ledgerPartyId: party.id },
          scope: { kind: "backfill", mailboxId, discovery: "all_history" },
          meteredBudget: { period: "lifetime", limitMicroUSD: 1_000_000 },
          expiresAt: new Date(Date.now() + 60_000).toISOString(),
        }),
      );
      const saved = await insertWithShortcode(ctx.db, "email", {
        ledgerPartyId: party.id,
        mailboxId,
        messageId: "synthetic-preview",
        checksum: "synthetic-retained-checksum",
        status: "pending",
        classification: "uncertain",
      });
      const getMessage = vi.fn<GmailProvider["getMessage"]>(async () => ({
        id: saved.messageId,
        payload: {
          mimeType: "text/plain",
          body: {
            data: Buffer.from(
              "Synthetic community newsletter. No purchase or payment.",
            ).toString("base64url"),
          },
        },
      }));
      vi.spyOn(providers, "gmailProviderForUser").mockResolvedValue({
        getMessage,
        getAttachment: async () => ({}),
        listMessages: async () => ({}),
        listHistory: async () => ({}),
        getProfile: async () => ({ historyId: "1" }),
      });
      const relevance = vi.fn<MailRelevance>(async () => ({
        classification: "unrelated",
        reason: "Synthetic newsletter",
      }));
      const before = await getDb(ctx.db)
        .select()
        .from(email)
        .where(eq(email.id, saved.id));
      vi.spyOn(runners, "productionMailTriage").mockImplementation(
        (_db, _run, onCall) => async () => {
          onCall?.({
            model: "typesafe/jev",
            promptVersion: "synthetic-preview",
            operation: "mailbox-triage",
          });
          return classification;
        },
      );
      vi.spyOn(runners, "productionMailRelevance").mockImplementation(
        (_db, _run, onCall) => async (request) => {
          const result = await relevance(request);
          onCall?.({
            model: "gpt-6-luna",
            promptVersion: "synthetic-preview",
            operation: "mailbox-relevance",
          });
          return result;
        },
      );
      const result =
        classification === "uncertain"
          ? mailTriagePreviewOut.parse(
              (
                await callMcpTool(
                  createMcpServer(),
                  "imports_read",
                  {
                    action: "mail_triage_preview",
                    mailboxId,
                    messageId: saved.messageId,
                  },
                  {},
                  {
                    operationContext: new McpOperationContext(
                      requireActor(
                        createTestRequestContext(ctx.db, {
                          auth: { userId: ctx.actor.userId },
                        }),
                      ),
                    ),
                  },
                )
              ).structuredContent,
            )
          : await previewMailTriage(
              ctx.db,
              { mailboxId, messageId: saved.messageId },
              ctx.actor,
              {
                triage: async () => classification,
                relevance,
              },
            );
      expect(result.classification).toBe(
        classification === "uncertain" ? "unrelated" : classification,
      );
      expect(result.stage).toBe(
        classification === "uncertain" ? "model" : "decision",
      );
      expect(result.triage.classification).toBe(classification);
      expect(result.usage).toMatchObject(
        classification === "uncertain"
          ? {
              calls: 2,
              accountingPending: true,
              standardCost: null,
              chargedCost: null,
            }
          : {
              calls: 0,
              accountingPending: false,
              standardCost: 0,
              chargedCost: 0,
            },
      );
      expect(result.relevance?.classification).toBe(
        classification === "uncertain" ? "unrelated" : undefined,
      );
      expect(relevance).toHaveBeenCalledTimes(
        classification === "uncertain" ? 1 : 0,
      );
      expect(getMessage).toHaveBeenCalledTimes(1);
      expect(
        await getDb(ctx.db).select().from(email).where(eq(email.id, saved.id)),
      ).toEqual(before);
      expect(
        await getDb(ctx.db).select().from(emailClassificationObservation),
      ).toEqual([]);
      expect(await getDb(ctx.db).select().from(orderMail)).toEqual([]);
      expect(
        await getDb(ctx.db)
          .select({ status: run.status })
          .from(run)
          .where(eq(run.shortcode, result.runId)),
      ).toEqual([{ status: "completed" }]);
    },
  );
});
