import {
  parseEntityId,
  type ProductId,
  type PurchaseId,
} from "@cubby/schemas/identifiers";
import type {
  ExtractedOrderCandidate,
  ExtractedPurchaseLine,
} from "@cubby/schemas/purchase-import";

import type { DrizzleTransaction } from "~/server/db";
import { importSourceProduct } from "~/server/db/schema";
import type { ExistingExpenseSnapshot } from "~/server/domains/purchase-import/repo/writer-policy";
import { insertWithShortcode } from "~/server/generic/shortcode/repo/shortcode-utils";

import type { LineIdentityDecision } from "./writer";
import { applyExpenseProductBinding } from "./writer-apply";
import {
  planAggregateExpense,
  planLineAction,
  planResolvedNoOp,
  planIdentityFindings,
  planImportedExpense,
  planInsertedFindings,
  type LineFinding,
  type planLineMatch,
  type planLineMode,
} from "./writer-plan";

export type LineMutation = {
  targetKind: "expense" | "product";
  targetId: string;
  mutationKind: "create" | "update" | "delete";
  fields: string[];
};

type Finding =
  | LineFinding
  | { kind: "sum_mismatch" | "foreign_currency"; summary: string };

export async function writePurchaseLines(
  tx: DrizzleTransaction,
  args: {
    purchaseId: PurchaseId;
    candidate: ExtractedOrderCandidate;
    identityDecisions: LineIdentityDecision[];
    mode: ReturnType<typeof planLineMode>;
    lineMatch: ReturnType<typeof planLineMatch>;
    orderDate: string | null;
    /** Item lines carry no cost: a foreign receipt or an unpriced itemization. */
    unpriced: boolean;
    loadExpenses: () => Promise<ExistingExpenseSnapshot[]>;
    resolveProduct: (
      line: ExtractedPurchaseLine,
      identity: LineIdentityDecision,
      previous: Map<string, string>,
      onCreated: (id: ProductId) => void,
    ) => Promise<ProductId | null>;
    fileFinding: (finding: Finding) => Promise<string>;
  },
) {
  const {
    purchaseId,
    candidate,
    identityDecisions,
    mode,
    lineMatch,
    orderDate,
    unpriced,
  } = args;
  const findingIds: string[] = [];
  const productLines: Array<
    Pick<
      typeof importSourceProduct.$inferInsert,
      "lineIndex" | "productId" | "expenseId"
    >
  > = [];
  const rowMutations: LineMutation[] = [];
  const fileFindings = async (findings: Finding[]) => {
    for (const finding of findings)
      findingIds.push(await args.fileFinding(finding));
  };
  const onCreated = (id: ProductId) =>
    rowMutations.push({
      targetKind: "product",
      targetId: id,
      mutationKind: "create",
      fields: ["name", "externalIds", "notes"],
    });

  const writeAggregate = async () => {
    if (candidate.printedGrandTotal !== null) {
      const existing = await args.loadExpenses();
      const plan = planAggregateExpense(
        purchaseId,
        candidate,
        orderDate,
        existing,
      );
      if (plan) {
        const inserted = await insertWithShortcode(tx, "expense", plan);
        rowMutations.push({
          targetKind: "expense",
          targetId: inserted.id,
          mutationKind: "create",
          fields: ["name", "cost", "lineKind", "purchaseId"],
        });
      }
    }
  };
  // An unpriced itemization books its printed total first, then its item
  // lines without cost; never price an item from the total.
  if (mode.kind === "unpriced_itemization") await writeAggregate();
  const lineMode =
    mode.kind === "unpriced_itemization" ? mode.lines : mode.kind;
  if (mode.kind === "aggregate") {
    await writeAggregate();
    await fileFindings([{ kind: "sum_mismatch", summary: mode.detail }]);
  } else if (mode.kind === "foreign") {
    await fileFindings([{ kind: "foreign_currency", summary: mode.detail }]);
  } else if (
    lineMode === "identity" ||
    lineMode === "no_op" ||
    lineMode === "insert"
  ) {
    const productsByExternalIdentity = new Map<string, string>();
    for (const [lineIndex, line] of candidate.lines.entries()) {
      const action = planLineAction(
        lineMode,
        line,
        lineIndex,
        identityDecisions,
        lineMatch,
      );
      if (action.kind === "skip") continue;
      if (action.kind === "unresolved") {
        if (action.expenseId)
          productLines.push({
            lineIndex,
            productId: null,
            expenseId: action.expenseId,
          });
        await fileFindings([action.finding]);
        continue;
      }
      const identity = action.identity;
      const productId = await args.resolveProduct(
        line,
        identity,
        productsByExternalIdentity,
        onCreated,
      );
      if (lineMode === "identity") {
        if (productId) productLines.push({ lineIndex, productId });
        await fileFindings(planIdentityFindings(line, identity));
      } else if (lineMode === "no_op") {
        if (!productId) continue;
        const { row, binding } = planResolvedNoOp(
          line,
          lineIndex,
          identity,
          productId,
          lineMatch,
        );
        if (binding) {
          await applyExpenseProductBinding(tx, binding);
          rowMutations.push({
            targetKind: "expense",
            targetId: row.id,
            mutationKind: "update",
            fields: ["productId", "productQuantity"],
          });
        }
        productLines.push({
          lineIndex,
          productId,
          expenseId: parseEntityId("expense", row.id),
        });
      } else {
        const plan = planImportedExpense(
          purchaseId,
          line,
          identity,
          productId,
          orderDate,
          unpriced,
        );
        const inserted = await insertWithShortcode(tx, "expense", plan.values);
        productLines.push({ lineIndex, productId, expenseId: inserted.id });
        rowMutations.push({
          targetKind: "expense",
          targetId: inserted.id,
          mutationKind: "create",
          fields: plan.fields,
        });
        await fileFindings(planInsertedFindings(line, identity));
      }
    }
  }
  return { findingIds, productLines, rowMutations };
}
