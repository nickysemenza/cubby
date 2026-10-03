import { FinancialSettlementCell } from "~/app/purchases/financial-settlement";
import { ReconciliationStatus } from "~/app/purchases/purchase-reconciliation";
import { EntityRefLink } from "~/entity/components/entity-ref-link";
import { VendorCell } from "~/entity/components/vendor-cell";
import { createTextColumn } from "~/ui/data-table/columnHelpers";
import { createCubbyColumnCollection } from "~/ui/data-table/table-features";
import { Row } from "~/ui/layout";
import { NoneValue } from "~/ui/primitives/none-value";

import type { ListRenderer } from "../list-renderer-types";

const vendor: ListRenderer<"purchase"> = (helper) =>
  createCubbyColumnCollection((add) => {
    add(
      helper.accessor((row) => row.vendorName, {
        id: "vendorId",
        header: "Vendor",
        meta: {
          className: "w-48",
          mobile: { slot: "subtitle", priority: 10 },
        },
        cell: (info) => {
          const row = info.row.original;
          return row.vendorName && row.vendorId ? (
            <VendorCell
              vendor={row.vendorName}
              vendorId={row.vendorId}
              logo={row.vendorLogo}
              compactOnMobile
            />
          ) : (
            <NoneValue />
          );
        },
      }),
    );
  });

// Raw order id, mono — the value a receipt prints, paired with the vendor's
// "same order" link (an order id is only unique within a vendor). Its header
// control is the presence worklist.
const orderLink: ListRenderer<"purchase"> = (helper) =>
  createCubbyColumnCollection((add) => {
    add(
      createTextColumn(helper, "orderId", {
        header: "Order #",
        className: "w-40 font-mono",
        mobile: { slot: "meta", priority: 20 },
        renderValue: (value, purchase) =>
          value ? (
            <Row align="center" gap="xs">
              <span className="min-w-0 truncate">{value}</span>
              <EntityRefLink
                variant="order"
                orderUrl={purchase.orderUrl}
                orderId={value}
                vendorName={purchase.vendorName}
              />
            </Row>
          ) : (
            <NoneValue />
          ),
      }),
    );
  });

const financialSettlement: ListRenderer<"purchase"> = (helper) =>
  createCubbyColumnCollection((add) => {
    add(
      helper.display({
        id: "financialReconciliation",
        header: "Settlement",
        meta: {
          provenanceWorkbenchHandled: true,
          className: "w-32",
          mobile: { slot: "meta", priority: 65, interactive: true },
        },
        cell: (info) => (
          <FinancialSettlementCell purchase={info.row.original} />
        ),
      }),
    );
  });

const reconciliationStatus: ListRenderer<"purchase"> = (helper) =>
  createCubbyColumnCollection((add) => {
    add(
      helper.display({
        id: "reconciliation",
        header: "Reconciles",
        meta: { className: "w-48", mobile: { slot: "meta", priority: 60 } },
        cell: (info) => <ReconciliationStatus purchase={info.row.original} />,
      }),
    );
  });

export const purchaseListRenderers = {
  "vendor-cell": vendor,
  "order-link": orderLink,
  "financial-settlement": financialSettlement,
  "reconciliation-status": reconciliationStatus,
} as const;
