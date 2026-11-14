import { readResponseWithLimit } from "@cubby/shared/external-fetch";
/** Content-addressed media shares the existing object store; Ask rows retain references. */
import { sha256Hex } from "@cubby/shared/sha256";
import { z } from "zod";

import { getR2PublicUrl } from "~/server/clients/r2-public-url";
import { getS3Object, uploadToS3 } from "~/server/clients/s3";

import type { ModelInput } from "./model-asks";
import type { DecisionImage } from "./policy/decision-choice";

export const storedDecisionImage = z.object({
  key: z.string().startsWith("ai-input/"),
  sha256: z.string().regex(/^[a-f0-9]{64}$/u),
  content_type: z.enum(["image/png", "image/jpeg", "image/webp"]),
});
const MAX_BYTES = 20 * 1024 * 1024;

async function retain(base64: string, mime: string) {
  if (base64.length > Math.ceil(MAX_BYTES / 3) * 4)
    throw new Error("AI media exceeds 20 MiB");
  const bytes = Buffer.from(base64, "base64");
  if (bytes.toString("base64") !== base64 || bytes.length > MAX_BYTES)
    throw new Error("Invalid AI media base64");
  const sha256 = await sha256Hex(bytes);
  const key = `ai-input/${sha256}`;
  await uploadToS3({ key, body: bytes, contentType: mime });
  return { key, sha256 };
}

/** Inline media is persisted once by content hash before an Ask is filed. */
export async function retainModelMedia(input: ModelInput): Promise<ModelInput> {
  if (input.kind === "choice") {
    const images = await Promise.all(
      (input.images ?? []).map(async (image) => {
        if (typeof image !== "string" && "key" in image) return image;
        if (typeof image === "string") {
          const match = /^data:(image\/(?:png|jpeg|webp));base64,(.*)$/u.exec(
            image,
          );
          if (!match)
            throw new Error("Decision media must be embedded image bytes");
          return storedDecisionImage.parse({
            ...(await retain(match[2]!, match[1]!)),
            content_type: match[1],
          });
        }
        return {
          ...(await retain(image.base64, image.content_type)),
          content_type: image.content_type,
        };
      }),
    );
    return { ...input, images: input.images ? images : undefined };
  }
  const messages = await Promise.all(
    input.request.messages.map(async (message) => {
      if (typeof message.content === "string") return message;
      const content = await Promise.all(
        message.content.map(async (part) => {
          if (part.type === "text" || part.source.type !== "inline")
            return part;
          const ref = await retain(part.source.value, part.source.mimeType);
          return {
            ...part,
            source: {
              type: "url" as const,
              value: getR2PublicUrl(ref.key),
              mimeType: part.source.mimeType,
              contentHash: ref.sha256,
            },
          };
        }),
      );
      return { ...message, content };
    }),
  );
  return { ...input, request: { ...input.request, messages } };
}

/** A producer verifies stored bytes before sending them to a provider. */
export async function resolveDecisionMedia(
  images: NonNullable<Extract<ModelInput, { kind: "choice" }>["images"]>,
): Promise<DecisionImage[]> {
  return Promise.all(
    images.map(async (image) => {
      if (typeof image === "string" || !("key" in image)) return image;
      const response = await getS3Object(image.key);
      if (!response.ok)
        throw new Error(`Stored AI media read failed: ${response.status}`);
      const bytes = await readResponseWithLimit(response, MAX_BYTES);
      if ((await sha256Hex(bytes)) !== image.sha256)
        throw new Error("Stored AI media hash changed");
      return {
        content_type: image.content_type,
        base64: Buffer.from(bytes).toString("base64"),
      };
    }),
  );
}
