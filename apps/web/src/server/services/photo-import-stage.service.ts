import { parseShortcodeFor } from "@cubby/schemas/identifiers";

import type {
  PhotoImportStageInput,
  PhotoImportStageOutput,
} from "~/contracts/photo-import.contract";
import type { Database } from "~/server/db";
import { findReusableImagesBySha256 } from "~/server/repo/photo-import";
import { resolveOrThrow } from "~/server/repo/shortcode-resolver";
import { initiateImageUploadWithoutEntity } from "~/server/services/image-storage.service";

export interface PhotoImportStagePorts {
  findReusable: typeof findReusableImagesBySha256;
  initiateUpload: typeof initiateImageUploadWithoutEntity;
  /** Defaults to the real resolver; existing test doubles need not supply it. */
  resolveRunId?: typeof resolveOrThrow;
}

const productionPorts: PhotoImportStagePorts = {
  findReusable: findReusableImagesBySha256,
  initiateUpload: initiateImageUploadWithoutEntity,
  resolveRunId: resolveOrThrow,
};

/** Staging is deliberately not transactional: every successful presign remains reusable. */
export async function stagePhotoImport(
  db: Database,
  input: PhotoImportStageInput,
  ports: PhotoImportStagePorts = productionPorts,
): Promise<PhotoImportStageOutput> {
  const runId = input.runId
    ? await (ports.resolveRunId ?? resolveOrThrow)(db, "run", input.runId)
    : undefined;
  const exact = await ports.findReusable(
    db,
    input.items
      .filter((item) => item.allowExactReuse)
      .map((item) => item.sha256),
    runId,
  );
  const items: PhotoImportStageOutput["items"] = [];
  for (const item of input.items) {
    const reused = item.allowExactReuse ? exact.get(item.sha256) : undefined;
    if (reused) {
      items.push({
        kind: "existing",
        clientId: item.clientId,
        imageId: parseShortcodeFor("image", reused.shortcode),
      });
      continue;
    }
    try {
      const staged = await ports.initiateUpload(db, {
        filename: item.filename,
        contentType: item.contentType,
        size: item.size,
        algorithmRevision: 1,
        perceptualHash: item.perceptualHash,
        sourceFingerprint: item.sourceFingerprint,
        width: item.width,
        height: item.height,
      });
      items.push({ kind: "upload", clientId: item.clientId, ...staged });
    } catch (error) {
      // SILENT: already surfaced to the caller as this item's `failed`/
      // `retryable` result below; there's no richer per-item channel here.
      console.error("photo-import.stage-failed", {
        clientId: item.clientId,
        error,
      });
      items.push({ kind: "failed", clientId: item.clientId, retryable: true });
    }
  }
  return { items };
}
