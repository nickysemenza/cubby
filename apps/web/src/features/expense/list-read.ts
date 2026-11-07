import {
  EXPENSE_MARK_PURCHASED_READ_FIELDS,
  EXPENSE_RECEIVE_READ_FIELDS,
} from "~/entity/actions/action-read-fields";
import { specialistListReadProjection } from "~/entity/entity-list/list-read-demand";

export const expenseListReadProjection = specialistListReadProjection({
  always: [
    "projectId",
    ...EXPENSE_RECEIVE_READ_FIELDS,
    ...EXPENSE_MARK_PURCHASED_READ_FIELDS,
  ],
});
