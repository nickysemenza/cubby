import { useQuery } from "@tanstack/react-query";
import { colors, getErrorMessage } from "@cubby/shared";
import { useRouter } from "expo-router";
import {
  ActivityIndicator,
  FlatList,
  Image,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from "react-native";

import { CategoryBadge } from "@/components/CategoryBadge";
import { api } from "@/lib/api";

export default function ProductsScreen() {
  const router = useRouter();
  const { data, isLoading, error } = useQuery(
    api.product.list.queryOptions({
      filters: {},
      pagination: { pageIndex: 0, pageSize: 50 },
    }),
  );

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

  return (
    <View style={styles.container}>
      <FlatList
        data={data?.items ?? []}
        keyExtractor={(item) => item.id}
        renderItem={({ item }) => {
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
                {item.category && (
                  <View style={styles.badgeRow}>
                    <CategoryBadge category={item.category} />
                  </View>
                )}
              </View>
            </TouchableOpacity>
          );
        }}
        ListEmptyComponent={
          <View style={styles.empty}>
            <Text style={styles.emptyText}>No products found</Text>
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
});
