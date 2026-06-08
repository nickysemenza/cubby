import { useQuery } from "@tanstack/react-query";
import {
  ActivityIndicator,
  FlatList,
  StyleSheet,
  Text,
  View,
} from "react-native";
import { useTRPC } from "@/lib/trpc";

export function InventoryList() {
  const trpc = useTRPC();
  const { data, isLoading, error } = useQuery(
    trpc.inventory.list.queryOptions({ filters: {} }),
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
        <Text style={styles.error}>{error.message}</Text>
      </View>
    );
  }

  return (
    <View style={styles.container}>
      <Text style={styles.heading}>
        Inventory ({data?.meta.totalCount ?? 0})
      </Text>
      <FlatList
        data={data?.items ?? []}
        keyExtractor={(item) => item.id}
        renderItem={({ item }) => (
          <View style={styles.row}>
            <Text style={styles.name}>{item.product.name}</Text>
            <Text style={styles.sub}>{item.location.name}</Text>
          </View>
        )}
        ListEmptyComponent={<Text style={styles.sub}>No items yet.</Text>}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, padding: 16, gap: 8 },
  center: { flex: 1, alignItems: "center", justifyContent: "center" },
  heading: { fontSize: 22, fontWeight: "700", marginBottom: 8 },
  row: {
    paddingVertical: 12,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: "#ddd",
  },
  name: { fontSize: 16, fontWeight: "600" },
  sub: { fontSize: 14, color: "#666" },
  error: { color: "#c0392b" },
});
