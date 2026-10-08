import { ELIGIBLE_MAIL_QUERY, GMAIL_PAGE_SIZE } from "./sync";
import type { GmailProvider } from "./types";
import { vendorSearchTerms, type VendorMailIdentity } from "./vendor-identity";

/** Search terms prioritize evidence; they never exclude messages after fetching. */
export async function listVendorMailPage(
  provider: GmailProvider,
  input: {
    identity: VendorMailIdentity & { name?: string };
    after: string;
    pageToken: string | null;
  },
): Promise<{ messageIds: string[]; nextPageToken: string | null }> {
  const terms = [
    ...new Set(
      [input.identity.name, ...vendorSearchTerms(input.identity)].filter(
        (term): term is string => Boolean(term?.trim()),
      ),
    ),
  ];
  if (!terms.length)
    throw new Error("Add a Vendor name or website to search Gmail.");
  const query = `{${terms.map((term) => `"${term.replaceAll('"', " ")}"`).join(" ")}}${input.after ? ` after:${input.after}` : ""} ${ELIGIBLE_MAIL_QUERY}`;
  const parameters: Parameters<GmailProvider["listMessages"]>[0] = {
    query,
    maxResults: GMAIL_PAGE_SIZE,
  };
  if (input.pageToken) parameters.pageToken = input.pageToken;
  const page = await provider.listMessages(parameters);
  return {
    messageIds: [
      ...new Set((page.messages ?? []).map((ref) => ref.id).filter(Boolean)),
    ],
    nextPageToken: page.nextPageToken ?? null,
  };
}
/** An explicit requested scope may be bounded; the default includes retained history. */
export const defaultVendorMailSearchAfter = (): string => "";
