import { mailReadOut } from "@cubby/schemas/mailbox-research";
import { z } from "zod";

const sourceRead = mailReadOut.pick({
  id: true,
  mailboxId: true,
  messageId: true,
  checksum: true,
  content: true,
});

export const retainedMailPage = z.object({
  /** The offset actually requested, not an offset inferred from the response. */
  offset: z.number().int().nonnegative(),
  response: sourceRead,
});

export const retainedMailPages = z.object({
  emailId: sourceRead.shape.id,
  checksum: sourceRead.shape.checksum,
  textPages: z.array(retainedMailPage),
  htmlPages: z.array(retainedMailPage),
});

type Pages = z.infer<typeof retainedMailPages>;
const bytes = (text: string) => new TextEncoder().encode(text).length;

/** Validate byte coverage independently of per-page truncation flags. */
function sequence(input: Pages, mode: "text" | "html") {
  const pages = mode === "text" ? input.textPages : input.htmlPages;
  const errors: string[] = [];
  let offset = 0;
  let text = "";
  let total: number | null = null;
  let identity: string | null = null;
  if (!pages.length) return { errors: [`No ${mode} pages`], text };
  for (const [index, page] of pages.entries()) {
    const read = page.response;
    const content = read.content;
    const body = mode === "text" ? content.bodyText : content.bodyHtml;
    const size = mode === "text" ? content.textBytes : content.htmlBytes;
    const currentIdentity = JSON.stringify([read.mailboxId, read.messageId]);
    identity ??= currentIdentity;
    total ??= size;
    if (read.id !== input.emailId || read.checksum !== input.checksum)
      errors.push(`${mode} page ${index}: source/checksum mismatch`);
    if (currentIdentity !== identity || size !== total)
      errors.push(`${mode} page ${index}: original changed between pages`);
    if (page.offset !== offset)
      errors.push(
        `${mode} page ${index}: missing, repeated or reordered bytes`,
      );
    if (body === null) errors.push(`${mode} page ${index}: missing body`);
    offset += bytes(body ?? "");
    text += body ?? "";
    const last = index === pages.length - 1;
    if (content.nextOffset !== (last ? null : offset))
      errors.push(
        `${mode} page ${index}: continuation does not match coverage`,
      );
    // Earlier compact pages are legitimately truncated. HTML fragments stay
    // truncated even on their final page; their byte coverage is authoritative.
    if (last && mode === "text" && (content.truncated || content.bodyShortened))
      errors.push("Compact text is incomplete; recover the full HTML original");
    if (
      mode === "text" &&
      (content.linksOmitted > 0 ||
        content.imagesOmitted > 0 ||
        content.structuredDataOmitted > 0)
    )
      errors.push(
        "Compact evidence omits links, images or structured data; recover the full HTML original",
      );
  }
  if (total === null || offset !== total)
    errors.push(`${mode}: original byte length is not fully covered`);
  return { errors, text };
}

export function completeRetainedMail(input: Pages) {
  const identityErrors: string[] = [];
  const pages = [...input.textPages, ...input.htmlPages];
  const first = pages[0]?.response;
  for (const { response } of pages)
    if (
      response.id !== input.emailId ||
      response.checksum !== input.checksum ||
      response.mailboxId !== first?.mailboxId ||
      response.messageId !== first.messageId
    )
      identityErrors.push(
        "Page source/checksum differs from the retained original",
      );
  if (identityErrors.length)
    return { complete: false, mode: null, text: null, errors: identityErrors };
  const text = sequence(input, "text");
  if (!text.errors.length)
    return { complete: true, mode: "text", text: text.text, errors: [] };
  const html = sequence(input, "html");
  if (!html.errors.length)
    return { complete: true, mode: "html", text: html.text, errors: [] };
  return {
    complete: false,
    mode: null,
    text: null,
    errors: [...text.errors, ...html.errors],
  };
}
