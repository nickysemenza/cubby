import { z } from "zod";
import { imageAttachmentReadSchema } from "./generated/entity-image-attachment.gen";
import { createEntityReadMedia } from "./entity-read-media-factory";
export { entityAttachmentRole } from "./entity-read-media-factory";
const media: ReturnType<
  typeof createEntityReadMedia<typeof imageAttachmentReadSchema.shape>
> = createEntityReadMedia(imageAttachmentReadSchema);
export const entityAttachmentRead: typeof media.entityAttachmentRead =
  media.entityAttachmentRead;
export type EntityAttachmentRead = z.infer<typeof entityAttachmentRead>;
export const entityAttachmentList: typeof media.entityAttachmentList =
  media.entityAttachmentList;
export const withEntityListMedia: typeof media.withEntityListMedia =
  media.withEntityListMedia;
export const withEntityDetailMedia: typeof media.withEntityDetailMedia =
  media.withEntityDetailMedia;
