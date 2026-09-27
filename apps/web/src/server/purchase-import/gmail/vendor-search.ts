import { mergeAttachmentPayload, normalizeMessage } from "./normalize";
import type {
  GmailOrderMail,
  GmailOrderMailAttachment,
  GmailProvider,
} from "./types";
import {
  matchesVendorSender,
  vendorSearchTerms,
  type VendorMailIdentity,
} from "./vendor-identity";

const PAGE_SIZE = 10;

export async function loadVendorMailPage(
  provider: GmailProvider,
  input: {
    identity: VendorMailIdentity;
    after: string;
    pageToken: string | null;
  },
): Promise<{
  messages: GmailOrderMail[];
  attachments: GmailOrderMailAttachment[];
  searched: number;
  nextPageToken: string | null;
}> {
  const terms = vendorSearchTerms(input.identity);
  if (terms.length === 0)
    throw new Error("Add a Vendor website to search Gmail for its order mail.");
  const from = terms.map((term) => `from:${term}`).join(" ");
  const query = `${terms.length > 1 ? `{${from}}` : from} after:${input.after}`;
  const request: Parameters<GmailProvider["listMessages"]>[0] = {
    query,
    maxResults: PAGE_SIZE,
  };
  if (input.pageToken) request.pageToken = input.pageToken;
  const page = await provider.listMessages(request);
  const messages: GmailOrderMail[] = [];
  const attachments: GmailOrderMailAttachment[] = [];
  const refs = (page.messages ?? []).slice(0, PAGE_SIZE);
  for (const ref of refs) {
    const normalized = normalizeMessage(
      "me",
      await provider.getMessage(ref.id),
    );
    if (
      !matchesVendorSender(normalized.mail.headers.from ?? "", input.identity)
    )
      continue;
    messages.push(normalized.mail);
    for (const attachment of normalized.attachments) {
      attachments.push(
        attachment.attachmentId
          ? mergeAttachmentPayload(
              attachment,
              await provider.getAttachment(ref.id, attachment.attachmentId),
            )
          : attachment,
      );
    }
  }
  return {
    messages,
    attachments,
    searched: refs.length,
    nextPageToken: page.nextPageToken ?? null,
  };
}
