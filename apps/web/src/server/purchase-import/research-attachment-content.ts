import {
  researchAttachmentOriginal,
  RESEARCH_ATTACHMENT_MAX_BYTES,
} from "@cubby/schemas/research-tools";
import { sha256Hex } from "@cubby/shared/sha256";
import { z } from "zod";

import type { AiChatRequest } from "~/server/ai/run-feature";

const binding = z.object({
  attachmentRef: z.uuid(),
  attachmentChecksum: z.string().regex(/^[a-f0-9]{64}$/u),
});
const envelope = z.looseObject({
  originalAttachment: researchAttachmentOriginal,
});
/** Binary bytes remain in retained evidence and the binary model input. */
export function mailAttachmentReadableContent(content: string): string {
  let value;
  try {
    value = JSON.parse(content);
  } catch {
    return content;
  }
  const parsed = envelope.safeParse(value);
  if (!parsed.success) return content;
  const { dataBase64: _data, ...descriptor } = parsed.data.originalAttachment;
  return JSON.stringify({ ...parsed.data, originalAttachment: descriptor });
}
type SourceObservation = {
  evidenceId: string;
  metadata: unknown;
  content: string;
};
type ContentPart = Exclude<
  AiChatRequest["messages"][number]["content"],
  string
>[number];

/** The assessor receives the retained original, never a model's extraction. */
export async function attachmentAssessmentContext(
  observations: readonly SourceObservation[],
) {
  const context: SourceObservation[] = [];
  const parts: ContentPart[] = [];
  let byteCount = 0;
  for (const observation of observations) {
    const metadata = binding.safeParse(observation.metadata);
    if (!metadata.success) {
      context.push(observation);
      continue;
    }
    const parsed = envelope.parse(JSON.parse(observation.content));
    const original = parsed.originalAttachment;
    if (
      metadata.data.attachmentRef !== original.attachmentRef ||
      metadata.data.attachmentChecksum !== original.checksum
    )
      throw new Error("Retained attachment original binding changed.");
    const bytes = Buffer.from(original.dataBase64, "base64");
    byteCount += bytes.byteLength;
    if (
      byteCount > RESEARCH_ATTACHMENT_MAX_BYTES ||
      bytes.toString("base64") !== original.dataBase64
    )
      throw new Error(
        "Retained attachment exceeds the original byte limit or has invalid encoding.",
      );
    if ((await sha256Hex(bytes)) !== original.checksum)
      throw new Error("Retained attachment original checksum changed.");
    const { dataBase64, ...descriptor } = original;
    context.push({
      ...observation,
      content: JSON.stringify({ ...parsed, originalAttachment: descriptor }),
    });
    parts.push({
      type: "text",
      content: `Original attachment for observation ${observation.evidenceId}; attachmentRef ${original.attachmentRef}; checksum ${original.checksum}; filename ${original.filename}. Inspect these original bytes for source support.`,
    });
    parts.push({
      type: original.mimeType === "application/pdf" ? "document" : "image",
      source: {
        type: "inline",
        value: dataBase64,
        mimeType: original.mimeType,
      },
    });
  }
  return { observations: context, parts };
}
