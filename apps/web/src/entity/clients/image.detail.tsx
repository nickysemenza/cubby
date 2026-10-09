import { ImageDetailActions } from "~/app/images/image-processing-panel";
import { AttachImageAction, ImageAssociations } from "~/app/images/slots";
import { defineDetailHooks } from "~/entity/entity-detail/detail-hooks";

export const imageDetailHooks = defineDetailHooks("image", {
  slots: { associations: { component: ImageAssociations } },
  headerActions: ImageDetailActions,
  collectionActions: { attachImage: AttachImageAction },
});
