import { getErrorMessage } from "@cubby/shared";
import { Alert } from "react-native";
import { type ImageEntityType, removeEntityImage } from "./entity-images";
import { useTRPCClient } from "./trpc";

/**
 * Returns an onDeleteImage handler for DetailView: detaches the image from the
 * entity, then calls `onChanged` (refetch). The confirm dialog lives in the
 * gallery; this just performs the mutation and surfaces failures.
 */
export function useDeleteEntityImage(
  entityType: ImageEntityType,
  entityId: string,
  onChanged: () => void,
): (imageId: string) => void {
  const client = useTRPCClient();
  return (imageId: string) => {
    removeEntityImage(client, entityType, entityId, imageId)
      .then(() => onChanged())
      .catch((e) => Alert.alert("Couldn't remove photo", getErrorMessage(e)));
  };
}
