import { formatCurrency } from "@cubby/shared";
import { useQuery } from "@tanstack/react-query";
import * as WebBrowser from "expo-web-browser";
import { EntityListScreen } from "@/components/entity-list-screen";
import { useTRPC } from "@/lib/trpc";

export default function PurchasesScreen() {
  const trpc = useTRPC();
  // Notion-backed: dashboard returns { projects, tasks, purchases } or null.
  const q = useQuery(trpc.notion.dashboard.queryOptions());
  const notConfigured = q.data === null;
  const purchases = q.data?.purchases ?? [];

  return (
    <EntityListScreen
      embedded
      title="Purchases"
      items={purchases}
      count={notConfigured ? undefined : purchases.length}
      isLoading={q.isLoading}
      isRefetching={q.isRefetching}
      error={q.error}
      onRefresh={() => void q.refetch()}
      keyExtractor={(p) => p.id}
      primaryText={(p) => p.name}
      secondaryText={(p) =>
        [p.category, p.subcategory, p.date].filter(Boolean).join(" · ") || null
      }
      rightValues={(p) => [
        p.cost != null ? formatCurrency(p.cost) : null,
        p.purchaser,
      ]}
      onPressItem={(p) => void WebBrowser.openBrowserAsync(p.notionUrl)}
      emptyText={notConfigured ? "Notion isn't connected." : "No purchases."}
    />
  );
}
