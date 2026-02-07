import { useInfiniteQuery } from "@tanstack/react-query";
import { colors, getErrorMessage } from "@cubby/shared";
import { Stack, useRouter } from "expo-router";
import { useCallback, useState } from "react";
import {
  ActivityIndicator,
  FlatList,
  RefreshControl,
  StyleSheet,
  Text,
  View,
} from "react-native";

import { ActivityEntry } from "@/components/ActivityEntry";
import { trpcClient } from "@/lib/api";

const PAGE_SIZE = 20;

export default function ActivityScreen() {
  const router = useRouter();
  const [isManualRefreshing, setIsManualRefreshing] = useState(false);

  const query = useInfiniteQuery({
    queryKey: ["auditLog", "list"],
    queryFn: async ({ pageParam }) => {
      return await trpcClient.auditLog.list.query({
        limit: PAGE_SIZE,
        cursor: pageParam as string | undefined,
      });
    },
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (lastPage) => lastPage.nextCursor ?? undefined,
  });

  const entries = query.data?.pages.flatMap((p) => p.entries) ?? [];

  const onRefresh = useCallback(async () => {
    setIsManualRefreshing(true);
    await query.refetch();
    setIsManualRefreshing(false);
  }, [query]);

  const navigateToEntity = (entityType: string, entityId: string) => {
    const routeMap: Record<string, string> = {
      product: `/product/${entityId}`,
      location: `/location/${entityId}`,
      recipe: `/recipe/${entityId}`,
      ingredient: `/ingredient/${entityId}`,
    };
    const route = routeMap[entityType];
    if (route) router.push(route);
  };

  if (query.isLoading) {
    return (
      <View style={styles.center}>
        <Stack.Screen options={{ title: "Activity" }} />
        <ActivityIndicator size="large" color={colors.terracotta} />
      </View>
    );
  }

  if (query.error) {
    return (
      <View style={styles.center}>
        <Stack.Screen options={{ title: "Activity" }} />
        <Text style={styles.errorText}>{getErrorMessage(query.error)}</Text>
      </View>
    );
  }

  return (
    <View style={styles.container}>
      <Stack.Screen options={{ title: "Activity" }} />
      <FlatList
        data={entries}
        keyExtractor={(item) => item.id}
        renderItem={({ item }) => (
          <ActivityEntry
            action={item.action}
            entityType={item.entityType}
            entityId={item.entityId}
            changes={item.changes as Record<string, unknown> | null}
            createdAt={new Date(item.createdAt)}
            userName={item.user?.name ?? item.user?.email}
            onPress={
              item.action !== "delete"
                ? () => navigateToEntity(item.entityType, item.entityId)
                : undefined
            }
          />
        )}
        onEndReached={() => query.hasNextPage && query.fetchNextPage()}
        onEndReachedThreshold={0.5}
        refreshControl={
          <RefreshControl
            refreshing={isManualRefreshing}
            onRefresh={onRefresh}
            tintColor={colors.terracotta}
          />
        }
        ListFooterComponent={
          query.isFetchingNextPage ? (
            <View style={styles.footer}>
              <ActivityIndicator size="small" color={colors.terracotta} />
            </View>
          ) : null
        }
        ListEmptyComponent={
          <View style={styles.empty}>
            <Text style={styles.emptyText}>No activity yet</Text>
          </View>
        }
      />
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.cream },
  center: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: colors.cream,
  },
  errorText: { color: colors.destructive },
  empty: { alignItems: "center", paddingVertical: 32 },
  emptyText: { color: colors.mutedForeground },
  footer: { paddingVertical: 16, alignItems: "center" },
});
