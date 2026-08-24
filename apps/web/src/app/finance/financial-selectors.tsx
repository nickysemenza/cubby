import { useQuery } from "@tanstack/react-query";
import { useMemo } from "react";
import { useTRPC } from "~/integrations/trpc/react";
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
function Search({
  children,
  kind,
}: {
  children: WithEntitySearchProps<string>["children"];
  kind: "account" | "purchase";
}) {
  const api = useTRPC();
  const { searchQuery, onSearchChange } = useEntitySearch();
  const { enabled, onOpenChange } = useDeferredSearch(searchQuery);
  const account = useQuery({
    ...api.financialAccount.list.queryOptions({
      filters: { search: searchQuery },
      pagination,
    }),
    enabled: enabled && kind === "account",
  });
  const purchase = useQuery({
    ...api.purchase.list.queryOptions({
      filters: { search: searchQuery },
      pagination,
    }),
    enabled: enabled && kind === "purchase",
  });
  const items = useMemo<ComboboxItem<string>[]>(
    () =>
      kind === "account"
        ? (account.data?.items ?? []).map((a) => ({
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
          }))
        : (purchase.data?.items ?? []).map((p) => ({
            id: p.id,
            shortcode: p.id,
            name:
              p.orderId ||
              `${p.vendorName ?? "Vendor"} · ${p.date ?? "undated"}`,
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
    [account.data, kind, purchase.data],
  );
  return (
    <>
      {children({
        items,
        onSearchChange,
        isLoading: kind === "account" ? account.isLoading : purchase.isLoading,
        onOpenChange,
      })}
    </>
  );
}
export function WithFinancialAccountSearch({
  children,
}: WithEntitySearchProps<string>) {
  return <Search kind="account">{children}</Search>;
}
export function WithPurchaseSearch({
  children,
}: WithEntitySearchProps<string>) {
  return <Search kind="purchase">{children}</Search>;
}
