import type {
  MailboxRelevanceDecision,
  MailImageEvidence,
} from "@cubby/schemas/mailbox-research";
import {
  assertResponseContentType,
  ExternalFetchError,
  fetchExternalResponse,
  readResponseWithLimit,
  sanitizeExternalUrl,
} from "@cubby/shared/external-fetch";

import { scrubErrorMessage } from "~/lib/error-diagnostics";
import { wasm } from "~/lib/wasm";
import { MAILBOX_RELEVANCE_FEATURE } from "~/server/ai/policy/features";
import type { AiChatRequest } from "~/server/ai/run-feature";
import {
  ModelImageInputError,
  prepareModelImage,
} from "~/server/domains/image-processing/service/model-image";

import {
  GmailApiError,
  type GmailNormalizedMessage,
  type GmailProvider,
  type GmailOrderMailAttachment,
} from "../../repo/gmail/types";
import { unreadableMailImages } from "./triage";

export type MailRelevance = (
  request: AiChatRequest,
) => Promise<MailboxRelevanceDecision>;
const MAX_TRANSIENT_BYTES = 256 * 1024;
const MAX_ORIGINAL_BYTES = 3 * 1024 * 1024;
const MAX_IMAGES = 6;

function inlineImageContentId(source: string) {
  const match = /^cid:(.+)$/iu.exec(source);
  if (!match) return null;
  try {
    const id = decodeURIComponent(match[1]!);
    return /^[^<>\s]+$/u.test(id) ? id : null;
  } catch {
    return null;
  }
}

function readableMailView({
  bodyHtml,
  ...mail
}: GmailNormalizedMessage["mail"]) {
  const html = bodyHtml ? wasm.compact_email_html(bodyHtml) : null;
  const resolvedHtml = (
    availableContentIds: ReadonlySet<string>,
    suppliedSources: ReadonlySet<string>,
  ) =>
    html && {
      ...html,
      images: html.images.filter((image) => !suppliedSources.has(image.src)),
      unresolved_images:
        html.unresolved_images === html.unresolved_image_sources.length &&
        html.unresolved_image_sources.every((source) => {
          const id = inlineImageContentId(source);
          return id !== null && availableContentIds.has(id);
        })
          ? 0
          : html.unresolved_images,
    };
  return {
    images: html?.images ?? [],
    needsPixels: (availableContentIds: ReadonlySet<string>) =>
      html
        ? unreadableMailImages(
            resolvedHtml(availableContentIds, new Set())!,
            mail.bodyText ?? "",
          )
        : false,
    original: JSON.stringify({
      ...mail,
      htmlText:
        html?.text.trim() === mail.bodyText?.trim()
          ? null
          : (html?.text ?? null),
      links:
        html?.links.map(({ href, text }) => ({ url: href, label: text })) ?? [],
      images: html?.images.map(({ src, alt }) => ({ url: src, alt })) ?? [],
      trackingImageLabels: html?.tracking_image_labels ?? [],
      unresolvedImages: html?.unresolved_image_sources ?? [],
      preheader: html?.preheader ?? null,
      structuredData: html?.structured_data ?? [],
    }),
    // Omitted purchase cues and unreadable images require review; decorative
    // images and discarded layout bytes do not make a negative incomplete.
    complete: (
      availableContentIds: ReadonlySet<string>,
      suppliedSources: ReadonlySet<string>,
    ) =>
      !html ||
      (!html.truncated &&
        html.cue_links_omitted === 0 &&
        html.cue_images_omitted === 0 &&
        html.structured_data_omitted === 0 &&
        html.cues_omitted === 0 &&
        !unreadableMailImages(
          resolvedHtml(availableContentIds, suppliedSources)!,
          mail.bodyText ?? "",
        )),
  };
}

type MailContentPart = Exclude<
  AiChatRequest["messages"][number]["content"],
  string
>[number];

const readAttachmentData = async (
  provider: GmailProvider,
  messageId: string,
  attachment: GmailOrderMailAttachment,
) => {
  if (attachment.dataBase64Url) return attachment.dataBase64Url;
  if (!attachment.attachmentId) return undefined;
  try {
    return (await provider.getAttachment(messageId, attachment.attachmentId))
      .data;
  } catch (error) {
    if (error instanceof GmailApiError && error.status === 404)
      return undefined;
    throw error;
  }
};

const readAttachmentContext = async (
  provider: GmailProvider,
  messageId: string,
  attachment: GmailOrderMailAttachment,
  availableBytes: number,
  onBytes: (count: number) => void,
): Promise<{
  part: MailContentPart;
  encoded: string;
  imageBytes: Uint8Array | null;
} | null> => {
  const mimeType = attachment.mimeType;
  const supported =
    mimeType === "application/pdf" ||
    mimeType.startsWith("image/") ||
    mimeType.startsWith("text/");
  if (!supported || attachment.size > availableBytes) return null;
  const encoded = await readAttachmentData(provider, messageId, attachment);
  if (!encoded) return null;
  const bytes = Buffer.from(encoded, "base64url");
  onBytes(bytes.byteLength);
  if (bytes.byteLength < attachment.size || bytes.byteLength > availableBytes)
    return null;
  const part: MailContentPart = mimeType.startsWith("text/")
    ? {
        type: "text",
        content: `Attachment ${attachment.filename}:\n${bytes.toString("utf8")}`,
      }
    : {
        type: mimeType === "application/pdf" ? "document" : "image",
        source: { type: "inline", value: bytes.toString("base64"), mimeType },
      };
  return {
    part,
    encoded,
    imageBytes: mimeType.startsWith("image/") ? bytes : null,
  };
};

/** External image/transform seams keep private source bytes transient. */
export type RelevanceImagePorts = {
  fetcher?: typeof fetch;
  prepareImage?: typeof prepareModelImage;
  onEvidence?: (evidence: MailImageEvidence) => void;
};

async function acquireRemoteImage(
  src: string,
  availableBytes: number,
  fetcher: typeof fetch | undefined,
) {
  let response: Response | undefined;
  let consumedBytes = 0;
  let readingPixels = false;
  try {
    response = await fetchExternalResponse(src, { fetcher });
    if (!response.ok) {
      const diagnostic = await readResponseWithLimit(response, 32 * 1024);
      throw new Error(
        `${response.statusText}\n${new TextDecoder().decode(diagnostic)}`,
      );
    }
    assertResponseContentType(response, ["image/"]);
    readingPixels = true;
    const bytes = await readResponseWithLimit(response, availableBytes);
    consumedBytes = bytes.byteLength;
    return {
      bytes,
      consumedBytes,
      failure: null,
    };
  } catch (error) {
    if (
      readingPixels &&
      error instanceof ExternalFetchError &&
      error.code === "body-too-large"
    )
      consumedBytes = availableBytes;
    return {
      bytes: null,
      consumedBytes,
      failure: `${sanitizeExternalUrl(src)}: ${response ? `HTTP ${response.status}: ` : ""}${scrubErrorMessage(error instanceof Error ? error.message : String(error))}`,
    };
  } finally {
    await response?.body?.cancel().catch(() => undefined);
  }
}

type PreparedImage = { bytes: Uint8Array; index: number };

async function upgradeImageDetail(
  content: MailContentPart[],
  images: PreparedImage[],
  prepare: (
    bytes: Uint8Array,
    detail: "standard" | "detail",
  ) => Promise<Awaited<ReturnType<typeof prepareModelImage>> | null>,
  modelBytes: () => number,
) {
  let changed = false;
  for (const image of images) {
    const larger = await prepare(image.bytes, "detail");
    if (!larger) continue;
    const prior = content[image.index]!;
    content[image.index] = {
      type: "image",
      source: {
        type: "inline",
        value: Buffer.from(larger.bytes).toString("base64"),
        mimeType: larger.mimeType,
      },
    };
    if (modelBytes() > MAX_TRANSIENT_BYTES) content[image.index] = prior;
    else changed = true;
  }
  return changed;
}

function relevanceWithEvidence(
  decision: MailboxRelevanceDecision,
  classification: MailboxRelevanceDecision["classification"],
  evidence: MailImageEvidence,
): MailboxRelevanceDecision {
  if (!evidence.attempted && !evidence.prepared && !evidence.failures.length)
    return classification === decision.classification
      ? decision
      : { classification };
  return {
    ...decision,
    classification,
    reason: `${decision.reason ?? `Relevance model returned ${decision.classification}`}. Evidence: ${evidence.supplied}/${evidence.candidates} content images supplied; ${evidence.sourceBytes} source bytes; ${evidence.requestBytes} model-request bytes; image readability ${decision.imageReadability ?? "unreported"}${evidence.complete ? "" : "; omitted evidence"}.${evidence.failures.length ? ` Image evidence diagnostics: ${evidence.failures.join("; ")}` : ""}`,
  };
}

/** Unsupported, absent, or oversized bytes cannot justify a negative verdict. */
export async function interpretMailRelevance(
  provider: GmailProvider,
  normalized: GmailNormalizedMessage,
  interpret: MailRelevance,
  originalComplete = true,
  onAttachment?: (sourceKey: string, encoded: string) => void,
  ports: RelevanceImagePorts = {},
): Promise<MailboxRelevanceDecision> {
  const view = readableMailView(normalized.mail);
  const imagePreparer = ports.prepareImage ?? prepareModelImage;
  let complete =
    originalComplete &&
    Boolean(
      normalized.mail.bodyText?.trim() ||
      normalized.mail.bodyHtml?.trim() ||
      normalized.attachments.length,
    );
  const imageFailures: string[] = [];
  let imagePreparationAttempts = 0;
  const prepare = async (bytes: Uint8Array, detail: "standard" | "detail") => {
    if (detail === "standard") imagePreparationAttempts++;
    try {
      return await imagePreparer(bytes, detail);
    } catch (error) {
      if (!(error instanceof ModelImageInputError)) throw error;
      complete = false;
      imageFailures.push(
        scrubErrorMessage(
          error instanceof Error ? error.message : String(error),
        ),
      );
      return null;
    }
  };
  const content: MailContentPart[] = [{ type: "text", content: view.original }];
  const availableContentIds = new Set<string>();
  const suppliedSources = new Set<string>();
  const preparedImages: PreparedImage[] = [];
  let suppliedImageCount = 0;
  let acquiredBytes = new TextEncoder().encode(
    JSON.stringify(normalized.mail),
  ).byteLength;
  const modelBytes = () =>
    new TextEncoder().encode(
      JSON.stringify(MAILBOX_RELEVANCE_FEATURE.request(content)),
    ).byteLength;
  const add = (parts: MailContentPart[]) => {
    content.push(...parts);
    if (modelBytes() <= MAX_TRANSIENT_BYTES) return true;
    content.splice(content.length - parts.length, parts.length);
    complete = false;
    return false;
  };
  const preparePart = async (bytes: Uint8Array) => {
    const image = await prepare(bytes, "standard");
    return image
      ? {
          part: {
            type: "image",
            source: {
              type: "inline",
              value: Buffer.from(image.bytes).toString("base64"),
              mimeType: image.mimeType,
            },
          } satisfies MailContentPart,
          prepared: true,
        }
      : null;
  };
  for (const attachment of normalized.attachments) {
    if (acquiredBytes >= MAX_ORIGINAL_BYTES) {
      complete = false;
      break;
    }
    if (
      attachment.mimeType?.startsWith("image/") &&
      imagePreparationAttempts >= MAX_IMAGES
    ) {
      complete = false;
      continue;
    }
    const context = await readAttachmentContext(
      provider,
      normalized.mail.messageId,
      attachment,
      MAX_ORIGINAL_BYTES - acquiredBytes,
      (count) => {
        acquiredBytes = Math.min(MAX_ORIGINAL_BYTES, acquiredBytes + count);
      },
    );
    if (!context) {
      complete = false;
      continue;
    }
    onAttachment?.(attachment.sourceKey, context.encoded);
    const image = context.imageBytes
      ? await preparePart(context.imageBytes)
      : { part: context.part, prepared: false };
    if (!image) {
      complete = false;
      continue;
    }
    const parts: MailContentPart[] =
      attachment.contentId && image.part.type === "image"
        ? [
            {
              type: "text",
              content: `Inline Email image cid:${attachment.contentId}`,
            },
            image.part,
          ]
        : [image.part];
    if (!add(parts)) continue;
    if (image.part.type === "image") suppliedImageCount++;
    if (image.prepared && context.imageBytes)
      preparedImages.push({
        bytes: context.imageBytes,
        index: content.length - 1,
      });
    if (attachment.contentId && image.part.type === "image")
      availableContentIds.add(attachment.contentId);
  }
  // Only content images the compactor could not explain need network pixels.
  // Its existing structural tracking-pixel filter applies before this list.
  const candidates = view.needsPixels(availableContentIds)
    ? [...new Set(view.images.map((image) => image.src))].filter((src) =>
        /^https?:/iu.test(src),
      )
    : [];
  let attempted = 0;
  for (const src of candidates.slice(0, MAX_IMAGES)) {
    if (
      acquiredBytes >= MAX_ORIGINAL_BYTES ||
      imagePreparationAttempts >= MAX_IMAGES
    )
      break;
    attempted++;
    const acquired = await acquireRemoteImage(
      src,
      MAX_ORIGINAL_BYTES - acquiredBytes,
      ports.fetcher,
    );
    acquiredBytes += acquired.consumedBytes;
    if (!acquired.bytes) {
      complete = false;
      if (acquired.failure) imageFailures.push(acquired.failure);
      continue;
    }
    const image = await prepare(acquired.bytes, "standard");
    if (!image) {
      complete = false;
      continue;
    }
    const parts: MailContentPart[] = [
      { type: "text", content: `Email content image ${src}` },
      {
        type: "image",
        source: {
          type: "inline",
          value: Buffer.from(image.bytes).toString("base64"),
          mimeType: image.mimeType,
        },
      },
    ];
    if (!add(parts)) continue;
    suppliedImageCount++;
    preparedImages.push({ bytes: acquired.bytes, index: content.length - 1 });
    suppliedSources.add(src);
  }
  const evidence = (
    decision: MailboxRelevanceDecision | null,
    detailRetried: boolean,
  ): MailImageEvidence => ({
    attempted,
    prepared: preparedImages.length,
    supplied: suppliedImageCount,
    candidates:
      candidates.length +
      normalized.attachments.filter((attachment) =>
        attachment.mimeType?.startsWith("image/"),
      ).length,
    sourceBytes: acquiredBytes,
    requestBytes: modelBytes(),
    complete: complete && view.complete(availableContentIds, suppliedSources),
    failures: imageFailures,
    detailRetried,
    imageReadability: decision?.imageReadability ?? null,
    rawClassification: decision?.classification ?? null,
  });
  if (modelBytes() > MAX_TRANSIENT_BYTES) {
    ports.onEvidence?.(evidence(null, false));
    return {
      classification: "uncertain",
      reason: "Original model input exceeds the Email relevance byte budget",
    };
  }
  let decision = await interpret(MAILBOX_RELEVANCE_FEATURE.request(content));
  let detailRetried = false;
  if (
    decision.classification !== "related" &&
    decision.imageReadability === "needs_detail" &&
    preparedImages.length
  ) {
    if (
      await upgradeImageDetail(content, preparedImages, prepare, modelBytes)
    ) {
      detailRetried = true;
      decision = await interpret(MAILBOX_RELEVANCE_FEATURE.request(content));
    }
  }
  const readable =
    suppliedImageCount === 0 || decision.imageReadability === "sufficient";
  const classification =
    decision.classification === "unrelated" &&
    (!complete ||
      !readable ||
      !view.complete(availableContentIds, suppliedSources))
      ? "uncertain"
      : decision.classification;
  const diagnostics = evidence(decision, detailRetried);
  ports.onEvidence?.(diagnostics);
  return relevanceWithEvidence(decision, classification, diagnostics);
}
