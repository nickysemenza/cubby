import { colors, getErrorMessage } from "@cubby/shared";
import { Stack } from "expo-router";
import {
  ActivityIndicator,
  FlatList,
  Image,
  RefreshControl,
  StyleSheet,
  Text,
  View,
} from "react-native";

import { usePaginatedList } from "@/hooks/usePaginatedList";
import { trpcClient } from "@/lib/api";

type InventoryItem = {
  id: string;
  quantity?: number | null;
  product?: { name: string; images?: { url: string | null }[] } | null;
  location?: { name: string } | null;
};

const EMPTY_FILTERS = {};

export default function InventoryListScreen() {
  const {
    data,
    isLoading,
    error,
    fetchNextPage,
    hasNextPage,
    isFetchingNextPage,
    isRefreshing,
    onRefresh,
  } = usePaginatedList<InventoryItem>({
    queryFn: (params) => trpcClient.inventory.list.query(params),
    filters: EMPTY_FILTERS,
    queryKey: ["inventory", "list"],
  });

  if (isLoading) {
    return (
      <View style={styles.center}>
        <Stack.Screen options={{ title: "Inventory" }} />
        <ActivityIndicator size="large" color={colors.terracotta} />
      </View>
    );
  }

  if (error) {
    return (
      <View style={styles.center}>
        <Stack.Screen options={{ title: "Inventory" }} />
        <Text style={styles.errorText}>{getErrorMessage(error)}</Text>
      </View>
    );
  }

  return (
    <View style={styles.container}>
      <Stack.Screen options={{ title: "Inventory" }} />
      <FlatList
        data={data}
        keyExtractor={(item) => item.id}
        renderItem={({ item }) => {
          const imageUrl = item.product?.images?.[0]?.url;
          return (
            <View style={styles.row}>
              {imageUrl && (
                <Image source={{ uri: imageUrl }} style={styles.thumbnail} />
              )}
              <View style={styles.text}>
                <Text style={styles.name}>
                  {item.product?.name ?? "Unknown product"}
                </Text>
                <View style={styles.details}>
                  {item.location?.name && (
                    <Text style={styles.subtitle}>{item.location.name}</Text>
                  )}
                  {item.quantity != null && (
                    <Text style={styles.subtitle}>Qty: {item.quantity}</Text>
                  )}
                </View>
              </View>
            </View>
          );
        }}
        onEndReached={() => hasNextPage && fetchNextPage()}
        onEndReachedThreshold={0.5}
        refreshControl={
          <RefreshControl
            refreshing={isRefreshing}
            onRefresh={onRefresh}
            tintColor={colors.terracotta}
          />
        }
        ListFooterComponent={
          isFetchingNextPage ? (
            <View style={styles.footer}>
              <ActivityIndicator size="small" color={colors.terracotta} />
            </View>
          ) : null
        }
        ListEmptyComponent={
          <View style={styles.empty}>
            <Text style={styles.emptyText}>No inventory items found</Text>
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
    paddingHorizontal: 32,
  },
  row: {
    flexDirection: "row",
    alignItems: "center",
    paddingHorizontal: 16,
    paddingVertical: 12,
    borderBottomWidth: 1,
    borderBottomColor: colors.border,
  },
  thumbnail: {
    width: 48,
    height: 48,
    borderRadius: 6,
    backgroundColor: colors.muted,
    marginRight: 12,
  },
  text: { flex: 1 },
  name: { fontSize: 16, fontWeight: "500", color: colors.foreground },
  details: { flexDirection: "row", gap: 12, marginTop: 4 },
  subtitle: { fontSize: 14, color: colors.shelf },
  errorText: { color: colors.destructive },
  empty: { alignItems: "center", paddingVertical: 32 },
  emptyText: { color: colors.mutedForeground },
  footer: { paddingVertical: 16, alignItems: "center" },
});
