import { describe, expect, it } from "vitest";

import { mailAttachmentIdCandidates, parseMailSourceKey } from "./import-scope";

describe("mail attachment source keys", () => {
  const ownKey = "gmail:mailbox-1:msg-1:attachment:2";

  it("names one attachment at every nesting depth of its own key", () => {
    // A read's attachmentId is the attachment's own key; appending it to the
    // message key once (or again on a retry) must not name another part.
    const keys = [
      ownKey,
      `gmail:mailbox-1:msg-1:attachment:${ownKey}`,
      `gmail:mailbox-1:msg-1:attachment:gmail:mailbox-1:msg-1:attachment:${ownKey}`,
    ];
    for (const key of keys) {
      const { mailboxId, messageId, attachmentId } = parseMailSourceKey(key);
      expect({ mailboxId, messageId }).toEqual({
        mailboxId: "mailbox-1",
        messageId: "msg-1",
      });
      expect(
        mailAttachmentIdCandidates(mailboxId!, messageId!, attachmentId!),
      ).toEqual(["2", ownKey]);
    }
  });

  it("keeps another message's key as an opaque attachment id", () => {
    expect(
      mailAttachmentIdCandidates(
        "mailbox-1",
        "msg-1",
        "gmail:mailbox-1:msg-2:attachment:2",
      )[0],
    ).toBe("gmail:mailbox-1:msg-2:attachment:2");
  });
});
