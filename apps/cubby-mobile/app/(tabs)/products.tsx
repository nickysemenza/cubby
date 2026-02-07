import MaterialIcons from "@expo/vector-icons/MaterialIcons";
import {
  colors,
  formatCategoryLabel,
  getCategoryColor,
  getErrorMessage,
} from "@cubby/shared";
import { useRouter } from "expo-router";
import { useCallback, useState } from "react";
import {
  ActivityIndicator,
  FlatList,
  Image,
  RefreshControl,
  SectionList,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from "react-native";

import { CategoryBadge } from "@/components/CategoryBadge";
import { SectionHeader } from "@/components/SectionHeader";
import { useGroupedList } from "@/hooks/useGroupedList";
import { usePaginatedList } from "@/hooks/usePaginatedList";
import { trpcClient } from "@/lib/api";

type ProductItem = {
  id: string;
  name: string;
  manufacturer?: string | null;
  category?: string | null;
  images?: { url: string | null }[];
};

const EMPTY_FILTERS = {};

export default function ProductsScreen() {
  const router = useRouter();
  const [grouped, setGrouped] = useState(false);

  const {
    data,
    isLoading,
    error,
    fetchNextPage,
    hasNextPage,
    isFetchingNextPage,
    isRefreshing,
    onRefresh,
  } = usePaginatedList<ProductItem>({
    queryFn: (params) => trpcClient.product.list.query(params),
    filters: EMPTY_FILTERS,
    queryKey: ["product", "list"],
  });

  const groupKey = useCallback(
    (item: ProductItem) =>
      item.category ? formatCategoryLabel(item.category) : null,
    [],
  );
  const sections = useGroupedList(data, groupKey);

  if (isLoading) {
    return (
      <View style={styles.center}>
        <ActivityIndicator size="large" color={colors.terracotta} />
      </View>
    );
  }

  if (error) {
    return (
      <View style={styles.center}>
        <Text style={styles.errorText}>{getErrorMessage(error)}</Text>
      </View>
    );
  }

  const renderItem = ({ item }: { item: ProductItem }) => {
    const imageUrl = item.images?.[0]?.url;
    return (
      <TouchableOpacity
        style={styles.row}
        onPress={() => router.push(`/product/${item.id}`)}
      >
        {imageUrl && (
          <Image source={{ uri: imageUrl }} style={styles.thumbnail} />
        )}
        <View style={styles.text}>
          <Text style={styles.name}>{item.name}</Text>
          {item.manufacturer && (
            <Text style={styles.subtitle}>{item.manufacturer}</Text>
          )}
          {!grouped && item.category && (
            <View style={styles.badgeRow}>
              <CategoryBadge category={item.category} />
            </View>
          )}
        </View>
      </TouchableOpacity>
    );
  };

  const listFooter = isFetchingNextPage ? (
    <View style={styles.footer}>
      <ActivityIndicator size="small" color={colors.terracotta} />
    </View>
  ) : null;

  const refreshControl = (
    <RefreshControl
      refreshing={isRefreshing}
      onRefresh={onRefresh}
      tintColor={colors.terracotta}
    />
  );

  const emptyComponent = (
    <View style={styles.empty}>
      <Text style={styles.emptyText}>No products found</Text>
    </View>
  );

  const headerRight = () => (
    <TouchableOpacity
      onPress={() => setGrouped((g) => !g)}
      style={styles.headerButton}
    >
      <MaterialIcons
        name={grouped ? "view-list" : "view-module"}
        size={24}
        color={colors.terracotta}
      />
    </TouchableOpacity>
  );

  return (
    <View style={styles.container}>
      <View style={styles.headerBar}>
        <Text style={styles.headerTitle}>Products</Text>
        {headerRight()}
      </View>
      {grouped ? (
        <SectionList
          sections={sections}
          keyExtractor={(item) => item.id}
          renderItem={renderItem}
          renderSectionHeader={({ section }) => (
            <SectionHeader
              title={section.title}
              count={section.data.length}
              color={getCategoryColor(section.data[0]?.category)}
            />
          )}
          stickySectionHeadersEnabled
          onEndReached={() => hasNextPage && fetchNextPage()}
          onEndReachedThreshold={0.5}
          refreshControl={refreshControl}
          ListFooterComponent={listFooter}
          ListEmptyComponent={emptyComponent}
        />
      ) : (
        <FlatList
          data={data}
          keyExtractor={(item) => item.id}
          renderItem={renderItem}
          onEndReached={() => hasNextPage && fetchNextPage()}
          onEndReachedThreshold={0.5}
          refreshControl={refreshControl}
          ListFooterComponent={listFooter}
          ListEmptyComponent={emptyComponent}
        />
      )}
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
  headerBar: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: 16,
    paddingVertical: 8,
    borderBottomWidth: 1,
    borderBottomColor: colors.border,
  },
  headerTitle: {
    fontSize: 16,
    fontWeight: "600",
    color: colors.foreground,
  },
  headerButton: { padding: 4 },
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
  subtitle: { fontSize: 14, color: colors.shelf, marginTop: 4 },
  badgeRow: { marginTop: 4 },
  errorText: { color: colors.destructive },
  empty: { alignItems: "center", paddingVertical: 32 },
  emptyText: { color: colors.mutedForeground },
  footer: { paddingVertical: 16, alignItems: "center" },
});
