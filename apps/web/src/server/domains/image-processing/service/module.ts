import { z } from "zod";

import {
  deviceImageAsk,
  cloudImageAsk,
  imageExecutionEvidence,
  imageMetadataAsk,
  imageObservationEvidence,
} from "~/server/domains/image-processing/module";
import { defineModule, definePass } from "~/server/kernel/api";
const cloudImagePass = definePass({
  name: "image.cloud",
  async run(db, cursor) {
    const { jobId, askId } = z
      .object({ jobId: z.string(), askId: z.string() })
      .parse(cursor);
    const { parseEntityId } = await import("@cubby/schemas/identifiers");
    const { cloudAskPassState } =
      await import("~/server/domains/image-processing/repo/image-asks");
    if ((await cloudAskPassState(db, askId))?.done)
      return { cursor, done: true };
    await (
      await import("~/server/domains/image-processing/service/dispatch")
    ).dispatchImageProcessingWakeup(db, parseEntityId("imageJob", jobId));
    const state = await cloudAskPassState(db, askId);
    return {
      cursor,
      done: state?.done ?? true,
      availableAt: new Date(Date.now() + (state?.unknown ? 3600000 : 60000)),
    };
  },
});
const metadataPass = definePass({
  name: "image.metadata",
  async run(db, cursor, claim) {
    const { parseEntityId } = await import("@cubby/schemas/identifiers");
    const { imageId } = z.object({ imageId: z.string() }).parse(cursor);
    try {
      await (
        await import("~/server/domains/image/service/image-metadata-extraction.service")
      ).extractAndStoreImageMetadata(
        db,
        parseEntityId("image", imageId),
        undefined,
        claim.fenced,
      );
    } catch (error) {
      const { AskUnknownError, AskAbandonedError } =
        await import("~/server/kernel/api");
      if (error instanceof AskAbandonedError) return { cursor, done: true };
      if (error instanceof AskUnknownError)
        return {
          cursor,
          done: false,
          availableAt: new Date(Date.now() + 21600000),
          waitCause: "provider_capacity",
        };
      throw error;
    }
    return { cursor, done: true };
  },
});
const metadataProducer: typeof imageMetadataAsk = {
  ...imageMetadataAsk,
  produce: async (input) => ({
    output: await (
      await import("~/server/domains/image/service/image-metadata-extraction.service")
    ).produceImageMetadata(input),
  }),
};
export const imageKernelModule = defineModule({
  name: "image",
  asks: [deviceImageAsk, cloudImageAsk, metadataProducer],
  evidence: [imageExecutionEvidence, imageObservationEvidence],
  passes: [cloudImagePass, metadataPass],
  machinery: [
    { entity: "image", owning: null, fields: false, quality: false },
    { entity: "imageJob", owning: null, fields: false, quality: false },
  ],
});
