import { LinkIcon } from "@phosphor-icons/react/dist/csr/Link";
import { useState } from "react";

import type { SectionActionComponent } from "~/entity/entity-detail/section-actions";
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
      />
    </>
  );
};
