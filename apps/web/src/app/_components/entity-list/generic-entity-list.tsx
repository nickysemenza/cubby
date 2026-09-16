// step-4 placeholder: replaced by the generic page (rendered from
// `entitySummary[entity].list` over `useEntityList` + `ListWorkbench`). Until
// then the generated index routes mount the bespoke list for each entity here.
import { FinancialAccountList } from "~/app/finance/financial-account-list";
import { FinancialTransactionList } from "~/app/finance/financial-transaction-list";
import { LedgerPartyList } from "~/app/finance/ledger-party-list";
import { LedgerTransferList } from "~/app/finance/ledger-transfer-list";
import { IngredientList } from "~/app/ingredients/ingredientlist";
import { InventoryItemList } from "~/app/inventory/inventoryitemlist";
import { PurchaseList } from "~/app/purchases/purchaselist";
import { VendorList } from "~/app/vendors/vendorlist";
import { WishList } from "~/app/wishes/wish-list";

/** The entities whose index route is generated (`route.list: true`). */
export type GenericListEntity =
  | "ingredient"
  | "inventory"
  | "ledgerParty"
  | "ledgerTransfer"
  | "vendor"
  | "purchase"
  | "financialAccount"
  | "financialTransaction"
  | "wish";

export function GenericEntityList({ entity }: { entity: GenericListEntity }) {
  switch (entity) {
    case "ingredient":
      return <IngredientList />;
    case "inventory":
      return <InventoryItemList />;
    case "ledgerParty":
      return <LedgerPartyList />;
    case "ledgerTransfer":
      return <LedgerTransferList />;
    case "vendor":
      return <VendorList />;
    case "purchase":
      return <PurchaseList />;
    case "financialAccount":
      return <FinancialAccountList />;
    case "financialTransaction":
      return <FinancialTransactionList />;
    case "wish":
      return <WishList />;
  }
}
