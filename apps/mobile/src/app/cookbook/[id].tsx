import { unsafeCookbookId } from "@cubby/schemas/identifiers";
import { useQuery } from "@tanstack/react-query";
import { router, Stack, useLocalSearchParams } from "expo-router";
import { EntityListScreen } from "@/components/entity-list-screen";
import { useTRPC } from "@/lib/trpc";

// A cookbook "detail" is its recipes — recipe.list filtered by cookbookId.
export default function CookbookDetail() {
  const { id, name } = useLocalSearchParams<{ id: string; name?: string }>();
  const trpc = useTRPC();
  const q = useQuery(
    trpc.recipe.list.queryOptions({
      filters: { cookbookId: unsafeCookbookId(id) },
      pagination: { pageIndex: 0, pageSize: 1000 },
    }),
  );

  return (
    <>
      <Stack.Screen options={{ title: name ?? "Cookbook" }} />
      <EntityListScreen
        embedded
        title={name ?? "Cookbook"}
        items={q.data?.items ?? []}
        count={q.data?.meta.totalCount}
        isLoading={q.isLoading}
        isRefetching={q.isRefetching}
        error={q.error}
        onRefresh={() => void q.refetch()}
        keyExtractor={(i) => i.id}
        primaryText={(i) => i.name ?? "Untitled recipe"}
        imageUrl={(i) => i.images[0]?.url}
        onPressItem={(i) => router.push(`/recipe/${i.id}`)}
        emptyText="No recipes in this cookbook."
      />
    </>
  );
}
