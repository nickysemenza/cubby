import type {
  FinancialAccountShortcode,
  PurchaseShortcode,
  VendorShortcode,
} from "@cubby/schemas/identifiers";
import { useQuery } from "@tanstack/react-query";
import { createContext, type ReactNode, useContext, useMemo } from "react";

import { entityListFor } from "~/entities/entity-list.functions";

import type { ComboboxItem } from "../_components/combobox/combobox-types";
import {
  pagination,
  useDeferredSearch,
  useEntitySearch,
} from "../_components/combobox/entity-search-hooks";
import type { WithEntitySearchProps } from "../_components/combobox/with-search-hook";

const accountIdentityFacts = (identity: {
  kind: string;
  issuer?: string | null;
  institution?: string | null;
  provider?: string | null;
  last4?: string | null;
}) => {
  const owner = identity.issuer ?? identity.institution ?? identity.provider;
  return [owner, identity.last4 ? `•••• ${identity.last4}` : null].filter(
    (fact): fact is string => fact != null,
  );
};

/** Read-only relation selectors: finance evidence must choose an existing
 * account/purchase, never silently mint a counterparty from typed text. */
const PurchaseVendorScopeContext = createContext<VendorShortcode | null>(null);

export const purchaseSearchFilters = (
  search: string,
  vendorId: VendorShortcode | null,
) => ({ search, vendorId: vendorId ?? undefined });

export function PurchaseVendorScope({
  vendorId,
  children,
}: {
  vendorId: VendorShortcode | null;
  children: ReactNode;
}) {
  return (
    <PurchaseVendorScopeContext.Provider value={vendorId}>
      {children}
    </PurchaseVendorScopeContext.Provider>
  );
}

function useFinanceSearch(
  kind: "account" | "purchase",
  vendorId: VendorShortcode | null = null,
) {
  const { searchQuery, onSearchChange } = useEntitySearch();
  const { enabled, onOpenChange } = useDeferredSearch(searchQuery);
  const account = useQuery({
    ...entityListFor("financialAccount").queryOptions({
      filters: { search: searchQuery },
      pagination,
    }),
    enabled: enabled && kind === "account",
  });
  const purchase = useQuery({
    ...entityListFor("purchase").queryOptions({
      filters: purchaseSearchFilters(searchQuery, vendorId),
      pagination,
    }),
    enabled: enabled && kind === "purchase",
  });
  return {
    account,
    onOpenChange,
    onSearchChange,
    purchase,
  };
}

export function WithFinancialAccountSearch({
  children,
}: WithEntitySearchProps<FinancialAccountShortcode>) {
  const { account, onOpenChange, onSearchChange } = useFinanceSearch("account");
  const items = useMemo<ComboboxItem<FinancialAccountShortcode>[]>(
    () =>
      (account.data?.items ?? []).map((a) => ({
        id: a.id,
        shortcode: a.id,
        name: a.name,
        secondary: a.identity.kind.replaceAll("_", " "),
        presentation: {
          group: a.provisional
            ? {
                id: "provisional",
                label: "Provisional accounts",
                order: 1,
              }
            : {
                id: "confirmed",
                label: "Confirmed accounts",
                order: 0,
              },
          status: a.provisional
            ? { label: "Provisional", tone: "warning" as const }
            : undefined,
          facts: accountIdentityFacts(a.identity),
        },
      })),
    [account.data],
  );
  return children({
    items,
    onSearchChange,
    isLoading: account.isLoading,
    onOpenChange,
  });
}

export function WithPurchaseSearch({
  children,
}: WithEntitySearchProps<PurchaseShortcode>) {
  const vendorId = useContext(PurchaseVendorScopeContext);
  const { onOpenChange, onSearchChange, purchase } = useFinanceSearch(
    "purchase",
    vendorId,
  );
  const items = useMemo<ComboboxItem<PurchaseShortcode>[]>(
    () =>
      (purchase.data?.items ?? []).map((p) => ({
        id: p.id,
        shortcode: p.id,
        name:
          p.orderId || `${p.vendorName ?? "Vendor"} · ${p.date ?? "undated"}`,
        secondary: p.vendorName ?? undefined,
        presentation: {
          status:
            p.reconciliation === "mismatch"
              ? { label: "Check total", tone: "warning" as const }
              : undefined,
          facts: [
            p.date ? `Purchased ${p.date}` : "Undated",
            `$${p.expenseTotal.toFixed(2)}`,
          ],
        },
      })),
    [purchase.data],
  );
  return children({
    items,
    onSearchChange,
    isLoading: purchase.isLoading,
    onOpenChange,
  });
}
