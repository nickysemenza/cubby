import { unsafeCookbookId } from "@cubby/schemas/identifiers";
import { router, Stack, useLocalSearchParams } from "expo-router";
import { EntityListScreen } from "@/components/entity-list-screen";
import { useTRPCClient } from "@/lib/trpc";
import { useInfiniteList } from "@/lib/use-infinite-list";

// A cookbook "detail" is its recipes — recipe.list filtered by cookbookId.
export default function CookbookDetail() {
  const { id, name } = useLocalSearchParams<{ id: string; name?: string }>();
  const client = useTRPCClient();
  const list = useInfiniteList({
    queryKey: ["recipe", "list", "cookbook", id],
    pageSize: 30,
    fetchPage: (pageIndex, pageSize) =>
      client.recipe.list.query({
        filters: { cookbookId: unsafeCookbookId(id) },
        pagination: { pageIndex, pageSize },
      }),
  });

  return (
    <>
      <Stack.Screen options={{ title: name ?? "Cookbook" }} />
      <EntityListScreen
        embedded
        title={name ?? "Cookbook"}
        items={list.items}
        count={list.totalCount}
        isLoading={list.isLoading}
        isRefetching={list.isRefetching}
        error={list.error}
        onRefresh={list.refetch}
        onEndReached={list.onEndReached}
        isFetchingMore={list.isFetchingMore}
        keyExtractor={(i) => i.id}
        primaryText={(i) => i.name ?? "Untitled recipe"}
        imageUrl={(i) => i.images[0]?.url}
        onPressItem={(i) => router.push(`/recipe/${i.id}`)}
        emptyText="No recipes in this cookbook."
      />
    </>
  );
}
