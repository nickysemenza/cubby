import type { GmailProvider } from "./types";
import { vendorSearchTerms, type VendorMailIdentity } from "./vendor-identity";

const PAGE_SIZE = 10;

/**
 * One page of a vendor's Gmail search, as message ids only. The caller
 * fetches and saves the ones it has not classified yet, one at a time
 * (`ingestGmailMessages`), so a page never holds its messages' attachments.
 */
export async function listVendorMailPage(
  provider: GmailProvider,
  input: {
    identity: VendorMailIdentity;
    after: string;
    pageToken: string | null;
  },
): Promise<{ messageIds: string[]; nextPageToken: string | null }> {
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
  return {
    messageIds: (page.messages ?? []).slice(0, PAGE_SIZE).map((ref) => ref.id),
    nextPageToken: page.nextPageToken ?? null,
  };
}
