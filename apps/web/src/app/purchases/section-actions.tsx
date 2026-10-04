import { LinkIcon } from "@phosphor-icons/react/dist/csr/Link";
import { useQuery } from "@tanstack/react-query";
import { useState } from "react";

import type { SectionActionComponent } from "~/entity/entity-detail/section-actions";
import { purchase as purchaseOperations } from "~/integrations/tanstack-query/generated/catalog.gen";
import { Button } from "~/ui/primitives/button";

import { LinkExpensesDialog } from "./link-expenses-dialog";
import { LinkProductsDialog } from "./link-products-dialog";
import { MatchStatementButton } from "./match-statement";

/** Review statement activity near the order and allocate one entry to it. */
export const MatchStatementAction: SectionActionComponent<"purchase"> = ({
  record: purchase,
  action,
}) => (
  <MatchStatementButton
    purchaseId={purchase.id}
    label={action.label}
    disabledReason={action.disabledReason}
  />
);

/** The attach dialogs change what the reconciliation compares, so they sit beside it. */
export const LinkExpensesAction: SectionActionComponent<"purchase"> = ({
  record: purchase,
  action,
}) => {
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button
        variant="outline"
        size="sm"
        disabled={action.disabledReason !== null}
        onClick={() => setOpen(true)}
      >
        <LinkIcon />
        {action.label}
      </Button>
      <LinkExpensesDialog
        open={open}
        onOpenChange={setOpen}
        purchase={purchase}
      />
    </>
  );
};

export const LinkProductsAction: SectionActionComponent<"purchase"> = ({
  record: purchase,
  action,
}) => {
  const [open, setOpen] = useState(false);
  const productsQuery = useQuery(
    purchaseOperations.products.queryOptions({ purchaseId: purchase.id }),
  );
  // Explicitly-linked products only: the picker hides what is already attached, and
  // `purchase.products` also returns products derived from this order's itemized expenses —
  // taking every row would hide exactly the products still worth linking.
  const attachedIds = new Set(
    (productsQuery.data ?? [])
      .filter((item) => item.linkAttachedAt !== null)
      .map((item) => item.productId),
  );
  return (
    <>
      <Button
        variant="outline"
        size="sm"
        disabled={action.disabledReason !== null}
        onClick={() => setOpen(true)}
      >
        <LinkIcon />
        {action.label}
      </Button>
      <LinkProductsDialog
        open={open}
        onOpenChange={setOpen}
        purchase={purchase}
        attachedIds={attachedIds}
      />
    </>
  );
};
