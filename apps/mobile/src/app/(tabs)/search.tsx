import { FlashList } from "@shopify/flash-list";
import { useQuery } from "@tanstack/react-query";
import { Image } from "expo-image";
import { router } from "expo-router";
import { useState } from "react";
import {
  ActivityIndicator,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { useTRPC } from "@/lib/trpc";

// Search results are a discriminated union by entityType — route each to its
// detail. Literal-prefixed paths keep expo-router's typed routes happy.
function openDetail(entityType: string, id: string) {
  switch (entityType) {
    case "product":
      return router.push(`/product/${id}`);
    case "recipe":
      return router.push(`/recipe/${id}`);
    case "ingredient":
      return router.push(`/ingredient/${id}`);
    case "location":
      return router.push(`/location/${id}`);
    case "inventory":
      return router.push(`/inventory/${id}`);
  }
}

export default function SearchScreen() {
  const trpc = useTRPC();
  const [query, setQuery] = useState("");
  const enabled = query.trim().length >= 2;

  const q = useQuery(
    trpc.search.global.queryOptions(
      { query: query.trim(), limit: 25 },
      { enabled },
    ),
  );

  return (
    <SafeAreaView style={styles.flex} edges={["top"]}>
      <View style={styles.header}>
        <Text style={styles.title}>Search</Text>
      </View>
      <View style={styles.searchWrap}>
        <TextInput
          style={styles.input}
          placeholder="Search products, recipes, locations…"
          autoCapitalize="none"
          autoCorrect={false}
          value={query}
          onChangeText={setQuery}
          returnKeyType="search"
          clearButtonMode="while-editing"
        />
      </View>

      {enabled && q.isLoading ? (
        <View style={styles.center}>
          <ActivityIndicator size="large" />
        </View>
      ) : q.error ? (
        <View style={styles.center}>
          <Text style={styles.error}>{q.error.message}</Text>
        </View>
      ) : (
        <View style={styles.listWrap}>
          <FlashList
            data={enabled ? (q.data ?? []) : []}
            keyExtractor={(item) => `${item.entityType}:${item.id}`}
            contentContainerStyle={styles.listContent}
            keyboardShouldPersistTaps="handled"
            renderItem={({ item }) => (
              <Pressable
                style={({ pressed }) => [
                  styles.row,
                  pressed && styles.rowPressed,
                ]}
                onPress={() => openDetail(item.entityType, item.id)}
              >
                {item.imageUrl ? (
                  <Image
                    style={styles.thumb}
                    source={{ uri: item.imageUrl }}
                    contentFit="cover"
                    transition={150}
                    cachePolicy="memory-disk"
                  />
                ) : (
                  <View style={[styles.thumb, styles.thumbPlaceholder]}>
                    <Text style={styles.thumbInitial}>
                      {item.name.trim().charAt(0).toUpperCase() || "?"}
                    </Text>
                  </View>
                )}
                <View style={styles.rowText}>
                  <Text style={styles.name} numberOfLines={2}>
                    {item.name}
                  </Text>
                  <Text style={styles.sub}>
                    {item.entityType}
                    {item.subtitle ? ` · ${item.subtitle}` : ""}
                  </Text>
                </View>
                <Text style={styles.chevron}>›</Text>
              </Pressable>
            )}
            ListEmptyComponent={
              <Text style={styles.empty}>
                {enabled ? "No results." : "Type at least 2 characters."}
              </Text>
            }
          />
        </View>
      )}
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1, backgroundColor: "#fff" },
  header: { paddingHorizontal: 16, paddingTop: 8 },
  title: { fontSize: 28, fontWeight: "800" },
  searchWrap: { paddingHorizontal: 16, paddingVertical: 12 },
  input: {
    borderWidth: 1,
    borderColor: "#ccc",
    borderRadius: 10,
    paddingHorizontal: 12,
    paddingVertical: 10,
    fontSize: 16,
  },
  center: { flex: 1, alignItems: "center", justifyContent: "center" },
  listWrap: { flex: 1 },
  listContent: { paddingHorizontal: 16, paddingBottom: 24 },
  row: {
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
    paddingVertical: 12,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: "#ddd",
  },
  rowPressed: { opacity: 0.55 },
  rowText: { flex: 1 },
  chevron: { fontSize: 24, color: "#c4c4c4", marginLeft: 4 },
  thumb: {
    width: 48,
    height: 48,
    borderRadius: 8,
    backgroundColor: "#f0f0f0",
  },
  thumbPlaceholder: { alignItems: "center", justifyContent: "center" },
  thumbInitial: { fontSize: 18, fontWeight: "700", color: "#999" },
  name: { fontSize: 16, fontWeight: "600" },
  sub: {
    fontSize: 13,
    color: "#666",
    marginTop: 2,
    textTransform: "capitalize",
  },
  error: { color: "#c0392b", paddingHorizontal: 24, textAlign: "center" },
  empty: { color: "#666", paddingVertical: 24, textAlign: "center" },
});
