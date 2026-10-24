import {
  emailOriginalCapture,
  emailOriginalCaptureProblem,
  emailOriginalPartCapture,
  type EmailOriginalCapture,
} from "@cubby/schemas/email-observations";
import { MAIL_ATTACHMENT_MAX_BYTES } from "@cubby/schemas/mailbox-research";
import { decodeBase64Url } from "@cubby/shared/base64";
import { sha256Hex } from "@cubby/shared/sha256";
import type { z } from "zod";

import { canonicalJson } from "~/server/lib/canonical-json";

import type { GmailMessage, GmailMessagePart } from "./types";

/** Capture every MIME part before normalization discards alternative bodies; never fetch missing bytes. */
export async function captureGmailOriginal(input: {
  ledgerPartyId: string;
  mailboxId: string;
  messageId: string;
  message: GmailMessage;
  /** Already acquired bytes, keyed by this original's provider attachment ID. */
  attachmentPayloads?: ReadonlyMap<string, string>;
}): Promise<EmailOriginalCapture> {
  const binding = {
    provider: "gmail",
    ledgerPartyId: input.ledgerPartyId,
    mailboxId: input.mailboxId,
    messageId: input.messageId,
    threadId: input.message.threadId ?? null,
    internalDate: input.message.internalDate ?? null,
  };
  const parts: z.infer<typeof emailOriginalPartCapture>[] = [];
  let capturedBytes = 0;
  const incomplete = (problem: z.infer<typeof emailOriginalCaptureProblem>) =>
    emailOriginalCapture.parse({
      version: "gmail-original-v1",
      status: "incomplete",
      binding,
      problem,
    });
  if (input.message.id !== input.messageId)
    return incomplete({ reason: "identity_mismatch", part: "0" });
  if (!input.message.payload)
    return incomplete({ reason: "missing_payload", part: "0" });

  async function visit(
    part: GmailMessagePart,
    path: string,
    depth: number,
  ): Promise<z.infer<typeof emailOriginalCaptureProblem> | null> {
    if (parts.length >= 512 || depth > 64)
      return { reason: "capture_limit", part: path };
    if (!part.mimeType) return { reason: "missing_mime_type", part: path };
    const size = part.body?.size;
    if (size !== undefined && (!Number.isSafeInteger(size) || size < 0))
      return { reason: "invalid_size", part: path };
    const encoded = part.body?.data;
    const fetched = part.body?.attachmentId
      ? input.attachmentPayloads?.get(part.body.attachmentId)
      : undefined;
    if (
      encoded === undefined &&
      fetched === undefined &&
      !(part.parts?.length || size === 0)
    )
      return { reason: "missing_payload", part: path };
    let bytes = new Uint8Array();
    try {
      for (const value of [encoded, fetched]) {
        if (
          value !== undefined &&
          value.length > Math.ceil(MAIL_ATTACHMENT_MAX_BYTES / 3) * 4 + 4
        )
          return { reason: "capture_limit", part: path };
        if (value !== undefined && !/^[A-Za-z0-9_-]*={0,2}$/u.test(value))
          return { reason: "invalid_encoding", part: path };
      }
      bytes = decodeBase64Url(encoded ?? fetched ?? "");
      if (
        encoded !== undefined &&
        fetched !== undefined &&
        (await sha256Hex(bytes)) !== (await sha256Hex(decodeBase64Url(fetched)))
      )
        return { reason: "conflicting_payload", part: path };
    } catch {
      return { reason: "invalid_encoding", part: path };
    }
    if (size !== undefined && bytes.length !== size)
      return { reason: "size_mismatch", part: path };
    // Keep headers ordered (including duplicates), content IDs, provider part IDs and structure.
    const metadata = canonicalJson({
      partId: part.partId ?? null,
      mimeType: part.mimeType,
      filename: part.filename ?? null,
      headers:
        part.headers?.map((header) => ({
          name: header.name,
          value: header.value,
        })) ?? null,
      bodyPresent: part.body !== undefined,
      attachmentId: part.body?.attachmentId ?? null,
      declaredSize: size ?? null,
      children: part.parts?.length ?? 0,
    });
    capturedBytes += new TextEncoder().encode(metadata).length + bytes.length;
    if (capturedBytes > MAIL_ATTACHMENT_MAX_BYTES)
      return { reason: "capture_limit", part: path };
    parts.push({
      path,
      metadataDigest: await sha256Hex(metadata),
      bodyDigest: await sha256Hex(bytes),
      bodyBytes: bytes.length,
    });
    for (const [index, child] of (part.parts ?? []).entries()) {
      const problem = await visit(child, `${path}.${index}`, depth + 1);
      if (problem) return problem;
    }
    return null;
  }
  const problem = await visit(input.message.payload, "0", 0);
  return problem
    ? incomplete(problem)
    : emailOriginalCapture.parse({
        version: "gmail-original-v1",
        status: "complete",
        binding,
        parts,
        contentDigest: await sha256Hex(canonicalJson(parts)),
      });
}
