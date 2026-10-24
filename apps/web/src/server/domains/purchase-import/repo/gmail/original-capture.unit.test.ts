import { encodeBase64Url } from "@cubby/shared/base64";
import { describe, expect, it } from "vitest";

import { originalChecksum } from "./checksum";
import { normalizeMessage } from "./normalize";
import { captureGmailOriginal } from "./original-capture";
import type { GmailMessage, GmailMessagePart } from "./types";

const owner = "11111111-2222-f333-0444-555555555555";
const text = (value: string): GmailMessagePart => ({
  mimeType: "text/plain",
  body: {
    data: encodeBase64Url(value),
    size: new TextEncoder().encode(value).length,
  },
});
const message = (parts: GmailMessagePart[]): GmailMessage => ({
  id: "synthetic-original",
  threadId: "synthetic-thread",
  internalDate: "1000",
  payload: {
    mimeType: "multipart/mixed",
    headers: [{ name: "Message-ID", value: "<synthetic@example.test>" }],
    parts,
  },
});
const capture = (
  value: GmailMessage,
  attachmentPayloads?: ReadonlyMap<string, string>,
) =>
  captureGmailOriginal({
    ledgerPartyId: owner,
    mailboxId: "synthetic-mailbox",
    messageId: value.id,
    message: value,
    attachmentPayloads,
  });

describe("complete Gmail original capture", () => {
  it("separates distinct provider bindings from the same complete literal MIME capture", async () => {
    const original = message([text("Synthetic original")]);
    const left = await capture(original);
    const right = await captureGmailOriginal({
      ledgerPartyId: owner,
      mailboxId: "synthetic-second-mailbox",
      messageId: "synthetic-copy",
      message: {
        ...original,
        id: "synthetic-copy",
        threadId: "synthetic-copy-thread",
      },
    });
    if (left.status !== "complete" || right.status !== "complete")
      throw new Error("Synthetic MIME should be complete");
    expect(left.contentDigest).toBe(right.contentDigest);
    expect(left.binding).not.toEqual(right.binding);
    // Equality of captured MIME is not authorization to transfer a member decision between bindings.
    expect(left.parts).toHaveLength(2);
  });

  it("captures extra text parts which the retained normalization omits", async () => {
    const left = message([text("Synthetic first"), text("AAA")]);
    const right = message([text("Synthetic first"), text("BBB")]);
    expect(
      await originalChecksum(normalizeMessage("synthetic-mailbox", left)),
    ).toBe(
      await originalChecksum(normalizeMessage("synthetic-mailbox", right)),
    );
    const a = await capture(left);
    const b = await capture(right);
    if (a.status !== "complete" || b.status !== "complete")
      throw new Error("Synthetic MIME should be complete");
    expect(a.contentDigest).not.toBe(b.contentDigest);
    expect(a.parts).toHaveLength(3);
  });

  it("binds attachment bytes and content IDs without changing the existing checksum", async () => {
    const attachment = (
      bytes: string,
      contentId = "<synthetic>",
    ): GmailMessagePart => ({
      partId: "1",
      filename: "synthetic.txt",
      mimeType: "text/plain",
      headers: [{ name: "Content-ID", value: contentId }],
      body: {
        attachmentId: "synthetic-attachment",
        size: 3,
        data: encodeBase64Url(bytes),
      },
    });
    const left = message([text("Synthetic first"), attachment("AAA")]);
    const right = message([text("Synthetic first"), attachment("BBB")]);
    const cid = message([
      text("Synthetic first"),
      attachment("AAA", "<different>"),
    ]);
    expect(
      await originalChecksum(normalizeMessage("synthetic-mailbox", left)),
    ).toBe(
      await originalChecksum(normalizeMessage("synthetic-mailbox", right)),
    );
    const captures = await Promise.all(
      [left, right, cid].map((value) => capture(value)),
    );
    const digests = captures.map((result) =>
      result.status === "complete" ? result.contentDigest : null,
    );
    expect(digests.every(Boolean)).toBe(true);
    expect(new Set(digests).size).toBe(3);
  });

  it("requires already acquired attachment bytes and checks their declared size", async () => {
    const original = message([
      {
        mimeType: "application/pdf",
        filename: "synthetic.pdf",
        body: { attachmentId: "synthetic-attachment", size: 3 },
      },
    ]);
    expect(await capture(original)).toMatchObject({
      status: "incomplete",
      problem: { reason: "missing_payload", part: "0.0" },
    });
    expect(
      await capture(
        original,
        new Map([["synthetic-attachment", encodeBase64Url("AAA")]]),
      ),
    ).toMatchObject({ status: "complete" });
    expect(
      await capture(
        original,
        new Map([["synthetic-attachment", encodeBase64Url("A")]]),
      ),
    ).toMatchObject({
      status: "incomplete",
      problem: { reason: "size_mismatch" },
    });
  });

  it.each([
    {
      payload: { mimeType: "text/plain", body: { data: "%%%" } },
      reason: "invalid_encoding",
    },
    {
      payload: { mimeType: "text/plain", body: { data: "QQ", size: 2 } },
      reason: "size_mismatch",
    },
    {
      payload: { mimeType: "text/plain", body: { size: -1 } },
      reason: "invalid_size",
    },
    { payload: { body: { size: 0 } }, reason: "missing_mime_type" },
  ])("retains incomplete proof for $reason", async ({ payload, reason }) => {
    const result = await capture({ id: "synthetic-original", payload });
    expect(result).toMatchObject({ status: "incomplete", problem: { reason } });
    expect(result).not.toHaveProperty("contentDigest");
  });

  it("refuses conflicting inline/fetched bytes and mismatched provider identity", async () => {
    const original = message([
      {
        mimeType: "text/plain",
        filename: "synthetic.txt",
        body: {
          attachmentId: "synthetic-attachment",
          data: encodeBase64Url("AAA"),
          size: 3,
        },
      },
    ]);
    expect(
      await capture(
        original,
        new Map([["synthetic-attachment", encodeBase64Url("BBB")]]),
      ),
    ).toMatchObject({
      status: "incomplete",
      problem: { reason: "conflicting_payload" },
    });
    expect(
      await captureGmailOriginal({
        ledgerPartyId: owner,
        mailboxId: "synthetic-mailbox",
        messageId: "different",
        message: original,
      }),
    ).toMatchObject({
      status: "incomplete",
      problem: { reason: "identity_mismatch" },
    });
  });

  it("marks oversized/deep captures incomplete without accepting a partial digest", async () => {
    const huge = message([text("A".repeat(3 * 1024 * 1024 + 1))]);
    expect(await capture(huge)).toMatchObject({
      status: "incomplete",
      problem: { reason: "capture_limit" },
    });
    let part = text("Synthetic leaf");
    for (let depth = 0; depth < 70; depth++)
      part = { mimeType: "multipart/mixed", parts: [part] };
    expect(
      await capture({ id: "synthetic-original", payload: part }),
    ).toMatchObject({
      status: "incomplete",
      problem: { reason: "capture_limit" },
    });
  });
});
