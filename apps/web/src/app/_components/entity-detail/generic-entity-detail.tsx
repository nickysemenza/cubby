// step-4 placeholder: replaced by the generic page (rendered from
// `entitySummary[entity].detail` sections, hero and slots). Until then the
// generated detail routes mount the bespoke detail for each entity here.
import type { ComponentProps } from "react";

import { IngredientDetail } from "~/app/_components/ingredients/ingredient-detail";
import { InventoryDetail } from "~/app/_components/inventory/inventory-detail";
import { LocationDetail } from "~/app/_components/locations/location-detail";
import { ProductDetail } from "~/app/_components/products/product-detail";
import { ExpenseDetail } from "~/app/expenses/expense-detail";
import { FinancialAccountDetail } from "~/app/finance/financial-account-detail";
import { FinancialTransactionDetail } from "~/app/finance/financial-transaction-detail";
import { LedgerPartyDetail } from "~/app/finance/ledger-party-detail";
import { LedgerTransferDetail } from "~/app/finance/ledger-transfer-detail";
import { PlantingDetail } from "~/app/garden/planting-detail";
import { ImageDetailPage } from "~/app/images/image-detail-page";
import { MealDetailPage } from "~/app/meals/meal-detail-page";
import { PurchaseDetail } from "~/app/purchases/purchase-detail";
import { TaskDetail } from "~/app/tasks/task-detail";
import { VendorDetail } from "~/app/vendors/vendor-detail";
import { WishDetail } from "~/app/wishes/wish-detail";
import type { EntityDetailByEntity } from "~/entities/generated/entity-details.gen";

/** The entities whose detail route is generated (`route.detail` non-null). */
type RosterDetailEntity =
  | "product"
  | "ingredient"
  | "location"
  | "inventory"
  | "meal"
  | "ledgerParty"
  | "ledgerTransfer"
  | "task"
  | "vendor"
  | "purchase"
  | "financialAccount"
  | "financialTransaction"
  | "wish"
  | "expense"
  | "planting";

// A discriminated union rather than `{ entity: E; record: Record<E> }`, so the
// `switch` below narrows `record` with `entity` and no cast is needed.
export type GenericEntityDetailProps =
  | {
      [E in RosterDetailEntity]: { entity: E; record: EntityDetailByEntity[E] };
    }[RosterDetailEntity]
  | {
      entity: "image";
      record: ComponentProps<typeof ImageDetailPage>["record"];
    };

export function GenericEntityDetail(props: GenericEntityDetailProps) {
  switch (props.entity) {
    case "product":
      return <ProductDetail record={props.record} />;
    case "ingredient":
      return <IngredientDetail record={props.record} />;
    case "location":
      return <LocationDetail record={props.record} />;
    case "inventory":
      return <InventoryDetail record={props.record} />;
    case "meal":
      return <MealDetailPage record={props.record} />;
    case "ledgerParty":
      return <LedgerPartyDetail record={props.record} />;
    case "ledgerTransfer":
      return <LedgerTransferDetail record={props.record} />;
    case "task":
      return <TaskDetail record={props.record} />;
    case "vendor":
      return <VendorDetail record={props.record} />;
    case "purchase":
      return <PurchaseDetail record={props.record} />;
    case "financialAccount":
      return <FinancialAccountDetail record={props.record} />;
    case "financialTransaction":
      return <FinancialTransactionDetail record={props.record} />;
    case "wish":
      return <WishDetail record={props.record} />;
    case "expense":
      return <ExpenseDetail record={props.record} />;
    case "planting":
      return <PlantingDetail record={props.record} />;
    case "image":
      return <ImageDetailPage record={props.record} />;
  }
}
