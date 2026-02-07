import { useQuery } from "@tanstack/react-query";
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
        <ActivityIndicator size="large" />
      </View>
    );
  }

  if (error) {
    return (
      <View style={styles.center}>
        <Text style={styles.errorText}>
          {error instanceof Error ? error.message : "Failed to load products"}
        </Text>
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
  container: { flex: 1, backgroundColor: "#fff" },
  center: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: "#fff",
  },
  row: {
    flexDirection: "row",
    alignItems: "center",
    paddingHorizontal: 16,
    paddingVertical: 12,
    borderBottomWidth: 1,
    borderBottomColor: "#f3f4f6",
  },
  thumbnail: {
    width: 48,
    height: 48,
    borderRadius: 6,
    backgroundColor: "#f3f4f6",
    marginRight: 12,
  },
  text: { flex: 1 },
  name: { fontSize: 16, fontWeight: "500" },
  subtitle: { fontSize: 14, color: "#6b7280", marginTop: 4 },
  errorText: { color: "#ef4444" },
  empty: { alignItems: "center", paddingVertical: 32 },
  emptyText: { color: "#9ca3af" },
});
