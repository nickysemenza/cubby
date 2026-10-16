import type { WCompactEmail } from "@cubby/recipebridge";
import type {
  MailboxClassification,
  MailboxClassificationDecision,
  MailTriageIncompleteReason,
} from "@cubby/schemas/mailbox-research";

import { wasm } from "~/lib/wasm";
import { decisionChoiceFitsContext } from "~/server/ai/decision-model";
import { MAILBOX_TRIAGE_FEATURE } from "~/server/ai/policy/features";

import { droppedBodyParts } from "../../repo/gmail/normalize";
import type {
  GmailMessage,
  GmailMessagePart,
  GmailNormalizedMessage,
} from "../../repo/gmail/types";

export type MailTriage = (content: string) => Promise<MailboxClassification>;

const incompletePart = (part: GmailMessagePart): boolean => {
  if ((part.parts ?? []).some(incompletePart)) return true;
  if (part.filename) return false;
  if (!part.mimeType?.startsWith("text/")) return false;
  if (part.body?.attachmentId) return true;
  if ((part.body?.size ?? 0) > 0 && !part.body?.data) return true;
  return Boolean(
    part.body?.data &&
    (part.body.size ?? 0) > Buffer.from(part.body.data, "base64url").byteLength,
  );
};

export const gmailOriginalComplete = (
  raw: GmailMessage,
  normalized: GmailNormalizedMessage,
): boolean =>
  Boolean(
    normalized.mail.bodyText?.trim() ||
    normalized.mail.bodyHtml?.trim() ||
    normalized.attachments.length,
  ) && !(raw.payload && incompletePart(raw.payload));

const utf8Bytes = (value: string) => new TextEncoder().encode(value).byteLength;

// Avoid splitting a surrogate pair at either excerpt boundary.
function excerpt(value: string, start: number, end: number): string {
  if (start > 0 && /[\uDC00-\uDFFF]/u.test(value.charAt(start))) start++;
  if (end < value.length && /[\uDC00-\uDFFF]/u.test(value.charAt(end))) end--;
  return value.slice(start, end);
}

function boundedField(value: string, bytes: number): string {
  let low = 0;
  let high = value.length;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (utf8Bytes(JSON.stringify(excerpt(value, 0, middle))) <= bytes)
      low = middle;
    else high = middle - 1;
  }
  return excerpt(value, 0, low);
}

const LINKS_SHOWN = 12;
const IMAGES_SHOWN = 6;
const STRUCTURED_DATA_SHOWN = 3;
/** Fewer letters and digits than this beside content images is an image-only message. */
const READABLE_CHARS = 64;

/** Catalog labels can explain promotional pictures; a receipt or unlabeled
 * image still needs pixels when the readable body cannot explain it. */
export function unreadableMailImages(html: WCompactEmail, plain: string) {
  if (html.unresolved_images || html.images_omitted) return true;
  if (!html.images.length) return false;
  if (html.readable_chars + wasm.readable_chars(plain) >= READABLE_CHARS)
    return false;
  return !(
    html.cue_images_omitted === 0 &&
    html.images.every((image) => image.alt.trim() && !image.cue) &&
    wasm.readable_chars(html.images.map((image) => image.alt).join("\n")) >=
      READABLE_CHARS
  );
}

/** Shown evidence lost a cue-bearing item, by position or by its bound. */
const clippedCue = <T extends { cue: boolean }>(
  all: readonly T[],
  shown: readonly unknown[],
  same: (item: T, index: number) => boolean,
) =>
  all.some(
    (item, index) => item.cue && !(index < shown.length && same(item, index)),
  );

/**
 * Whether the serialized view lost purchase evidence. Cues are scanned on the
 * full text, and each must survive into the content the decision model reads.
 * A cue past the scan bound cannot be checked, so then a clipped body or
 * preheader counts as clipped evidence.
 */
function purchaseCueCheck(
  html: WCompactEmail | null,
  plain: string,
  preheader: string | null,
) {
  const plainCues = wasm.purchase_cues(plain);
  const cuesOmitted = (html?.cues_omitted ?? 0) + plainCues.omitted > 0;
  const preheaderClipped =
    (html?.preheader ?? null) !== null && preheader !== html?.preheader;
  const cues = [
    ...new Map(
      [...(html?.cues ?? []), ...plainCues.cues].map((cue) => [
        cue.toLowerCase(),
        cue,
      ]),
    ).keys(),
  ];
  return (serialized: string, bodyFull: boolean) =>
    (cuesOmitted && (!bodyFull || preheaderClipped)) ||
    cues.some((cue) => !serialized.includes(cue));
}

function triageView(
  raw: GmailMessage,
  normalized: GmailNormalizedMessage,
  prompt = MAILBOX_TRIAGE_FEATURE.prompt,
) {
  const bodyHtml = normalized.mail.bodyHtml;
  const html = bodyHtml ? wasm.compact_email_html(bodyHtml) : null;
  const plain = normalized.mail.bodyText ?? "";
  const htmlText = html?.text ?? "";
  const body =
    plain.trim() && htmlText.trim() && plain.trim() !== htmlText.trim()
      ? `${plain}\n\n${htmlText}`
      : plain || htmlText;
  const from = normalized.mail.headers.from ?? "";
  const subject = normalized.mail.headers.subject ?? "";
  const headers = {
    from: boundedField(from, 512),
    subject: boundedField(subject, 1_024),
  };
  const senderDomain =
    headers.from.match(/@([a-z0-9.-]+\.[a-z]{2,})/iu)?.[1]?.toLowerCase() ??
    null;
  const attachments = normalized.attachments
    .slice(0, 8)
    .map(({ filename, mimeType, size }) => ({
      filename: boundedField(filename, 128),
      mimeType: boundedField(mimeType, 64),
      size,
    }));
  const preheader = html?.preheader ? boundedField(html.preheader, 512) : null;
  // These strings remain untrusted evidence, including clipped structured data.
  const links = (html?.links ?? [])
    .slice(0, LINKS_SHOWN)
    .map(({ href, text }) => ({
      href: boundedField(href, 256),
      text: boundedField(text, 96),
    }));
  const images = (html?.images ?? [])
    .slice(0, IMAGES_SHOWN)
    .map(({ src, alt }) => ({
      src: boundedField(src, 256),
      alt: boundedField(alt, 128),
    }));
  const trackingImageLabels = (html?.tracking_image_labels ?? [])
    .slice(0, IMAGES_SHOWN)
    .map((label) => boundedField(label, 128));
  const structuredData = (html?.structured_data ?? [])
    .slice(0, STRUCTURED_DATA_SHOWN)
    .map((block) => boundedField(block, 2_048));

  const reasons = new Set<MailTriageIncompleteReason>();
  if (headers.from !== from || headers.subject !== subject)
    reasons.add("headers_clipped");
  if (normalized.attachments.length) reasons.add("attachments");
  if (raw.payload && droppedBodyParts(raw.payload))
    reasons.add("mime_parts_dropped");
  let htmlEvidenceComplete = true;
  if (html) {
    if (html.truncated) reasons.add("compactor_truncated");
    if (unreadableMailImages(html, plain)) reasons.add("image_only");
    if (
      html.cue_links_omitted ||
      clippedCue(html.links, links, (link, index) => {
        const shown = links[index];
        return (
          shown !== undefined &&
          shown.text === link.text &&
          (shown.href === link.href ||
            (Boolean(link.text.trim()) &&
              link.url_cues.every((cue) =>
                shown.href.toLowerCase().includes(cue.toLowerCase()),
              )))
        );
      })
    )
      reasons.add("links_clipped");
    if (
      html.tracking_image_labels.length !== trackingImageLabels.length ||
      html.tracking_image_labels.some(
        (label, index) => label !== trackingImageLabels[index],
      ) ||
      html.cue_images_omitted ||
      clippedCue(html.images, images, (image, index) => {
        const shown = images[index];
        return (
          shown !== undefined &&
          shown.alt === image.alt &&
          (shown.src === image.src ||
            (Boolean(image.alt.trim()) &&
              image.url_cues.every((cue) =>
                shown.src.toLowerCase().includes(cue.toLowerCase()),
              )))
        );
      })
    )
      reasons.add("images_clipped");
    const structuredComplete =
      html.structured_data_omitted === 0 &&
      html.structured_data.every(
        (block, index) => structuredData[index] === block,
      );
    if (!structuredComplete) reasons.add("structured_data_clipped");
    htmlEvidenceComplete =
      structuredComplete &&
      !unreadableMailImages(html, plain) &&
      !reasons.has("links_clipped") &&
      !reasons.has("images_clipped");
  }
  const cueMissing = purchaseCueCheck(html, plain, preheader);

  const encode = (length: number) => {
    const full = length === body.length;
    const headLength = full ? length : Math.ceil(length * 0.75);
    const view = {
      headers,
      senderDomain,
      preheader,
      body: excerpt(body, 0, headLength),
      bodyEnd: full
        ? ""
        : excerpt(body, body.length - (length - headLength), body.length),
      bodyComplete: full && !html?.truncated,
      attachments,
      attachmentsComplete: attachments.length === normalized.attachments.length,
      htmlEvidence: html
        ? { links, images, trackingImageLabels, structuredData }
        : null,
      htmlEvidenceComplete,
    };
    // A cue never contains a character JSON escapes, so it matches the serialized view.
    const serialized = JSON.stringify(view).toLowerCase();
    const missing = cueMissing(serialized, full);
    return {
      content: JSON.stringify({
        ...view,
        omittedPurchaseCues: missing,
        incompleteReasons: [
          ...reasons,
          ...(missing ? ["purchase_cue_clipped"] : []),
        ],
      }),
      missing,
    };
  };
  // The real gate: the decision model's serialized request, rules and escaping included.
  const fits = (length: number) =>
    decisionChoiceFitsContext(prompt(encode(length).content));
  let low = 0;
  let high = body.length;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (fits(middle)) low = middle;
    else high = middle - 1;
  }
  const { content, missing } = encode(low);
  if (missing) reasons.add("purchase_cue_clipped");
  return {
    content,
    bytes: utf8Bytes(content),
    incompleteReasons: [...reasons],
  };
}

/** What the decision model read: its size and evidence omitted from the bounded view. */
type MailTriageView = {
  bytes: number;
  complete: boolean;
  incompleteReasons: MailTriageIncompleteReason[];
};

/** The bounded view is transient; the original remains the retained evidence. */
export async function routeGmailMessage(
  raw: GmailMessage,
  normalized: GmailNormalizedMessage,
  choose: MailTriage,
  prompt = MAILBOX_TRIAGE_FEATURE.prompt,
): Promise<{
  decision: MailboxClassificationDecision;
  view: MailTriageView | null;
}> {
  const body = normalized.mail.bodyText || normalized.mail.bodyHtml;
  if (!body?.trim() || (raw.payload && incompletePart(raw.payload)))
    return {
      decision: {
        classification: "uncertain",
        stage: "rule",
        reason: "The message body is empty or incomplete",
      },
      view: null,
    };
  const { content, bytes, incompleteReasons } = triageView(
    raw,
    normalized,
    prompt,
  );
  const view = {
    bytes,
    complete: incompleteReasons.length === 0,
    incompleteReasons,
  };
  const choice = await choose(content);
  return {
    decision: {
      classification: choice,
      stage: "decision",
      reason: `The decision model classified the ${view.complete ? "message" : "partial message"} ${choice}`,
    },
    view,
  };
}
