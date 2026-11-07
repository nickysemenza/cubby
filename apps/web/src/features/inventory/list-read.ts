import { INVENTORY_DIALOG_READ_FIELDS } from "~/entity/actions/action-read-fields";
import { specialistListReadProjection } from "~/entity/entity-list/list-read-demand";

export const inventoryListReadProjection = specialistListReadProjection({
  always: INVENTORY_DIALOG_READ_FIELDS,
});
