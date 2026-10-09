import { ExpenseSettlement } from "~/app/expenses/expense-settlement-body";
import {
  ReceiveExpenseAction,
  SplitExpenseAction,
} from "~/app/expenses/section-actions";
import {
  defineDetailHooks,
  type DetailSlotComponent,
} from "~/entity/entity-detail/detail-hooks";
import { ReportDetailActions } from "~/entity/entity-detail/report-slot";

const ExpenseDetailActions: DetailSlotComponent<"expense"> = ({ record }) => (
  <ReportDetailActions
    slot="expense.settlement"
    id={record.id}
    record={record}
  />
);

export const expenseDetailHooks = defineDetailHooks("expense", {
  slots: { settlement: { component: ExpenseSettlement } },
  headerActions: ExpenseDetailActions,
  sectionActions: {
    splitExpense: SplitExpenseAction,
    receiveExpense: ReceiveExpenseAction,
  },
});
