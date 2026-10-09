import { researchWorkResolve } from "@cubby/schemas/research-tools";
import { cubbyPiProviders } from "@cubby/shared/ai/pi-providers";
import { sha256Hex } from "@cubby/shared/sha256";
// Attachment-only identity can disappear behind metadata; another message's
// attachment can be read; changed bytes/rows can prove stale claims; oversized
// originals can silently truncate; pi can send PDFs as unsupported images.
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import {
  createModels,
  fauxAssistantMessage,
  fauxToolCall,
} from "@earendil-works/pi-ai";
import type { ToolExecutionApi } from "@earendil-works/pi-durable";
import { fromAny, fromPartial } from "@total-typescript/shoehorn";
import { eq } from "drizzle-orm";
import { withTestDb } from "tooling/test-setup";
import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";

import * as structured from "~/server/ai/run-feature";
import {
  orderMail,
  orderMailAttachment,
  mailboxMessage,
  runEvidence,
  runTarget,
} from "~/server/db/schema";
import type { RunServices } from "~/server/purchase-agent/environment";
import { purchaseImportTools } from "~/server/purchase-agent/tools";
import { getDb } from "~/server/repo/database-helpers";
import { insertWithShortcode } from "~/server/repo/shortcode-utils";

import { loadResearchEvidence } from "./research-evidence";
import { resolveImportResearch } from "./research-import";
import { startMailResearch } from "./research-run";
import { researchServiceFor } from "./research-service";
import { assessResearchProposal } from "./research-support";

function receiptPdf() {
  const stream =
    "BT /F1 18 Tf 40 740 Td (Synthetic kettle: XL copper variant) Tj ET";
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>",
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
    `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`,
  ];
  let document = "%PDF-1.4\n";
  const offsets = [0];
  for (const [index, object] of objects.entries()) {
    offsets.push(document.length);
    document += `${index + 1} 0 obj\n${object}\nendobj\n`;
  }
  const xref = document.length;
  document += `xref\n0 6\n0000000000 65535 f \n${offsets
    .slice(1)
    .map((offset) => `${String(offset).padStart(10, "0")} 00000 n \n`)
    .join("")}trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return new TextEncoder().encode(document);
}

function toolApi(): ToolExecutionApi {
  const memos = new Map<string, unknown>();
  return fromPartial<ToolExecutionApi>({
    memo: async (name: string, ...rest: unknown[]) => {
      if (rest.length === 2 && !memos.has(name)) memos.set(name, rest[0]);
      return fromAny(memos.get(name));
    },
  });
}

describe("original retained mail attachment research", () => {
  const ctx = withTestDb();
  afterEach(() => vi.restoreAllMocks());
  async function fixture(bytes = receiptPdf()) {
    const party = await insertWithShortcode(ctx.db, "ledgerParty", {
      name: "Synthetic attachment researcher",
      kind: "member",
      userId: ctx.actor.userId,
    });
    const [mail] = await getDb(ctx.db)
      .insert(orderMail)
      .values({
        ledgerPartyId: party.id,
        mailboxId: "synthetic-attachment-mailbox",
        messageId: "synthetic-attachment-message",
        sender: "receipts@example.test",
        subject: "Your original receipt",
        receivedAt: new Date("2026-10-01T12:00:00Z"),
        rawChecksum: "a".repeat(64),
        content: {
          snippet: null,
          bodyText:
            "The item variant is recorded only in the attached original receipt.",
          bodyHtml: null,
        },
      })
      .returning();
    if (!mail) throw new Error("Synthetic mail missing");
    const [attachment] = await getDb(ctx.db)
      .insert(orderMailAttachment)
      .values({
        orderMailId: mail.id,
        providerAttachmentId: "synthetic-receipt-part",
        filename: "receipt.pdf",
        mimeType: "application/pdf",
        checksum: await sha256Hex(bytes),
        pendingObjectKey: "synthetic/private/original-receipt",
      })
      .returning();
    if (!attachment) throw new Error("Synthetic attachment missing");
    await getDb(ctx.db).insert(mailboxMessage).values({
      ledgerPartyId: party.id,
      mailboxId: mail.mailboxId,
      messageId: mail.messageId,
      checksum: mail.rawChecksum,
      classification: "related",
      classificationVersion: "synthetic-v1",
      status: "pending",
      orderMailId: mail.id,
    });
    const [started] = await startMailResearch(
      ctx.db,
      {
        ledgerPartyId: party.id,
        userId: ctx.actor.userId,
        mailboxId: mail.mailboxId,
        messageIds: [mail.id],
      },
      { send: async () => {} },
    );
    if (!started) throw new Error("Synthetic research missing");
    const [target] = await getDb(ctx.db)
      .select()
      .from(runTarget)
      .where(eq(runTarget.runId, started.runId));
    if (!target) throw new Error("Synthetic work missing");
    const retained = new Map<string, Uint8Array>();
    const originals = new Map([[attachment.pendingObjectKey!, bytes]]);
    const reads: string[] = [];
    const services = researchServiceFor(
      ctx.db,
      fromPartial<Env>({ R2_KEY_PREFIX: "synthetic/research" }),
      started.runId,
      {
        observations: {
          storage: {
            put: async (key, value) => {
              retained.set(key, value);
            },
            get: async (key) => {
              const value = retained.get(key);
              if (!value)
                throw new Error("Synthetic retained original missing");
              return new TextDecoder().decode(value);
            },
          },
        },
        readAttachment: async (key: string) => {
          reads.push(key);
          const value = originals.get(key);
          if (!value) throw new Error("Synthetic attachment original missing");
          return value;
        },
      },
    );
    const input = {
      workRef: target.id,
      messageRef: mail.id,
      attachmentRef: attachment.id,
    };
    return {
      party,
      mail,
      attachment,
      started,
      target,
      services,
      retained,
      originals,
      reads,
      input,
      bytes,
    };
  }

  it("delivers attachment-only variant bytes through the researcher and PDF gateway, then independently supplies the same original to source assessment", async () => {
    const f = await fixture();
    const tool = purchaseImportTools(() =>
      fromPartial<RunServices>(f.services),
    ).find((candidate) => candidate.name === "mail_read");
    if (!tool) throw new Error("Synthetic mail tool missing");
    const api = toolApi();
    const result = await tool.execute(f.input, api, BACKGROUND_CONTEXT);
    if (!result.content)
      throw new Error("Synthetic mail tool returned no content.");
    expect.soft(result.content).toContainEqual({
      type: "image",
      data: Buffer.from(f.bytes).toString("base64"),
      mimeType: "application/pdf",
    });
    expect(
      result.content
        .filter((part) => part.type === "text")
        .map((part) => part.text)
        .join("\n"),
    ).not.toContain(Buffer.from(f.bytes).toString("base64"));
    expect(
      result.content
        .filter((part) => part.type === "text")
        .map((part) => part.text)
        .join("\n"),
    ).not.toContain(f.attachment.pendingObjectKey);
    expect(await tool.execute(f.input, api, BACKGROUND_CONTEXT)).toEqual(
      result,
    );
    let body: unknown;
    const models = createModels();
    for (const provider of cubbyPiProviders(() => async (_url, init) => {
      body = JSON.parse(String(init?.body));
      return new Response("synthetic transport refusal", { status: 400 });
    }))
      models.setProvider(provider);
    const model = models.getModel("openai", "gpt-6-sol");
    if (!model) throw new Error("Declared researcher model missing");
    const assistant = fauxAssistantMessage(fauxToolCall("mail_read", f.input), {
      stopReason: "toolUse",
    });
    const call = assistant.content.find((part) => part.type === "toolCall");
    if (!call || call.type !== "toolCall")
      throw new Error("Synthetic tool call missing");
    await models.complete(model, {
      messages: [
        {
          role: "user",
          content: "Read the exact original receipt variant.",
          timestamp: Date.now(),
        },
        assistant,
        {
          role: "toolResult",
          toolCallId: call.id,
          toolName: "mail_read",
          content: [
            ...result.content,
            {
              type: "image",
              data: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jOlkAAAAASUVORK5CYII=",
              mimeType: "image/png",
            },
            { type: "text", text: "Synthetic normal output text." },
          ],
          isError: false,
          timestamp: Date.now(),
        },
      ],
    });
    expect.soft(JSON.stringify(body)).toContain('"type":"input_file"');
    expect
      .soft(JSON.stringify(body))
      .toContain(
        `data:application/pdf;base64,${Buffer.from(f.bytes).toString("base64")}`,
      );
    const transport = z
      .object({
        input: z.array(z.looseObject({ output: z.array(z.json()).optional() })),
      })
      .parse(body);
    const outputs = transport.input.flatMap((item) => item.output ?? []);
    expect(outputs).toContainEqual(
      expect.objectContaining({
        type: "input_text",
        text: expect.stringContaining("Synthetic normal output text."),
      }),
    );
    expect(outputs).toContainEqual(
      expect.objectContaining({
        type: "input_image",
        image_url:
          "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jOlkAAAAASUVORK5CYII=",
      }),
    );
    const [evidence] = await getDb(ctx.db)
      .select()
      .from(runEvidence)
      .where(eq(runEvidence.runId, f.started.runId));
    if (!evidence) throw new Error("Attachment observation missing");
    const retained = f.retained.get(evidence.objectKey);
    expect
      .soft(new TextDecoder().decode(retained))
      .toContain(Buffer.from(f.bytes).toString("base64"));
    expect.soft(evidence.sourceMetadata).toMatchObject({
      attachmentRef: f.attachment.id,
      attachmentChecksum: f.attachment.checksum,
    });
    const observations = await loadResearchEvidence(
      ctx.db,
      {
        runId: f.started.runId,
        workRef: f.target.id,
        evidenceIds: [evidence.id],
      },
      async (row) => new TextDecoder().decode(f.retained.get(row.objectKey)),
    );
    const fact = {
      evidenceId: evidence.id,
      fieldPath: "notes",
      value: "Synthetic kettle XL copper",
      support: {
        observation: "Synthetic kettle: XL copper variant",
        reasoning:
          "This exact variant is printed in the original attached receipt.",
      },
    };
    const proposal = {
      workRef: f.target.id,
      status: "verified" as const,
      identity: {
        evidenceIds: [evidence.id],
        reasoning: "The attached original identifies the purchased variant.",
      },
      facts: [fact],
      detail: "Original receipt variant verified.",
    };
    let originalSeen = false;
    vi.spyOn(structured, "runStructuredFeature").mockImplementation(
      async (_feature, request) => {
        originalSeen = request.messages.some(
          (message) =>
            Array.isArray(message.content) &&
            message.content.some(
              (part) =>
                part.type === "document" &&
                part.source.type === "inline" &&
                part.source.value === Buffer.from(f.bytes).toString("base64"),
            ),
        );
        return fromAny({
          identityVerified: originalSeen,
          acceptedFacts: originalSeen ? [0] : [],
          acceptedIdentifiers: [],
          acceptedImages: [],
          acceptedOrders: [],
          acceptedEmailLinks: [],
          rejected: originalSeen
            ? []
            : [{ path: "facts.0", reason: "Original receipt unavailable." }],
        });
      },
    );
    const assessment = await assessResearchProposal({
      db: ctx.db,
      runId: f.started.runId,
      context: {},
      observations,
      proposal: researchWorkResolve.parse(proposal),
    });
    expect.soft(originalSeen).toBe(true);
    expect.soft(assessment.acceptedFacts).toEqual([0]);
  });

  it("rejects another retained message's attachment reference before reading or retaining its bytes", async () => {
    const f = await fixture();
    const [other] = await getDb(ctx.db)
      .insert(orderMail)
      .values({
        ledgerPartyId: f.party.id,
        mailboxId: f.mail.mailboxId,
        messageId: "synthetic-other-source",
        sender: "other@example.test",
        subject: "Other source",
        receivedAt: new Date(),
        rawChecksum: "b".repeat(64),
        content: { snippet: null, bodyText: "Other source", bodyHtml: null },
      })
      .returning();
    if (!other) throw new Error("Synthetic other mail missing");
    const [foreign] = await getDb(ctx.db)
      .insert(orderMailAttachment)
      .values({
        orderMailId: other.id,
        providerAttachmentId: "other-part",
        filename: "other.pdf",
        mimeType: "application/pdf",
        checksum: f.attachment.checksum,
        pendingObjectKey: "synthetic/private/other-original",
      })
      .returning();
    if (!foreign) throw new Error("Synthetic foreign attachment missing");
    await expect(
      f.services.researchMailRead(
        { ...f.input, attachmentRef: foreign.id },
        crypto.randomUUID(),
      ),
    ).rejects.toThrow(/attachment|belong|source/);
    expect(f.reads).toEqual([]);
    expect(await getDb(ctx.db).select().from(runEvidence)).toEqual([]);
  });

  it("reads the same original after attachment storage has moved to its linked Image", async () => {
    const f = await fixture();
    const linked = await insertWithShortcode(ctx.db, "image", {
      key: "synthetic/private/linked-receipt-original",
      filename: "receipt.pdf",
      size: f.bytes.byteLength,
      contentType: "application/pdf",
      status: "UPLOADED",
      sha256: f.attachment.checksum,
    });
    await getDb(ctx.db)
      .update(orderMailAttachment)
      .set({ pendingObjectKey: null, imageId: linked.id })
      .where(eq(orderMailAttachment.id, f.attachment.id));
    f.originals.delete(f.attachment.pendingObjectKey!);
    f.originals.set(linked.key, f.bytes);
    const result = await f.services.researchMailRead(
      f.input,
      crypto.randomUUID(),
    );
    expect(
      z
        .object({ originalAttachment: z.object({ dataBase64: z.string() }) })
        .parse(result).originalAttachment.dataBase64,
    ).toBe(Buffer.from(f.bytes).toString("base64"));
    expect(f.reads).toEqual([linked.key]);
  });

  it("rejects original bytes that no longer match the retained attachment checksum", async () => {
    const f = await fixture();
    f.originals.set(
      f.attachment.pendingObjectKey!,
      new TextEncoder().encode("Changed synthetic original"),
    );
    await expect(
      f.services.researchMailRead(f.input, crypto.randomUUID()),
    ).rejects.toThrow(/checksum|changed/);
    expect(await getDb(ctx.db).select().from(runEvidence)).toEqual([]);
  });

  it("refuses oversized originals explicitly without silent truncation or a negative research verdict", async () => {
    const f = await fixture(new Uint8Array(3 * 1024 * 1024 + 1));
    await expect(
      f.services.researchMailRead(f.input, crypto.randomUUID()),
    ).rejects.toThrow(/byte|size|limit/);
    expect(await getDb(ctx.db).select().from(runEvidence)).toEqual([]);
  });

  it("fences attachment claims before assessment when the live original changes after observation", async () => {
    const f = await fixture();
    const observation = await f.services.researchMailRead(
      f.input,
      crypto.randomUUID(),
    );
    const { evidenceId } = z
      .object({ evidenceId: z.uuid() })
      .parse(observation);
    await getDb(ctx.db)
      .update(orderMailAttachment)
      .set({ checksum: "f".repeat(64) })
      .where(eq(orderMailAttachment.id, f.attachment.id));
    let assessments = 0;
    await expect(
      resolveImportResearch(
        ctx.db,
        {
          runId: f.started.runId,
          workRef: f.target.id,
          callId: "synthetic-stale-attachment-claim",
          proposal: {
            workRef: f.target.id,
            status: "no_source_found",
            identity: {
              evidenceIds: [evidenceId],
              reasoning: "Inspect the original receipt.",
            },
            detail: "Original source must remain current.",
          },
        },
        {
          readEvidence: async (row) =>
            new TextDecoder().decode(f.retained.get(row.objectKey)),
          assess: async () => {
            assessments++;
            return {
              identityVerified: false,
              acceptedFacts: [],
              acceptedIdentifiers: [],
              acceptedImages: [],
              acceptedOrders: [],
              acceptedEmailLinks: [],
              rejected: [],
            };
          },
        },
      ),
    ).rejects.toThrow(/attachment|checksum|changed/);
    expect(assessments).toBe(0);
  });
});
