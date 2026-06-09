import { useQuery } from "@tanstack/react-query";
import { Image } from "expo-image";
import { useState } from "react";
import {
  ActivityIndicator,
  FlatList,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { useTRPC } from "@/lib/trpc";

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
        <FlatList
          data={enabled ? (q.data ?? []) : []}
          keyExtractor={(item) => `${item.entityType}:${item.id}`}
          contentContainerStyle={styles.listContent}
          keyboardShouldPersistTaps="handled"
          renderItem={({ item }) => (
            <View style={styles.row}>
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
            </View>
          )}
          ListEmptyComponent={
            <Text style={styles.empty}>
              {enabled ? "No results." : "Type at least 2 characters."}
            </Text>
          }
        />
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
  listContent: { paddingHorizontal: 16, paddingBottom: 24 },
  row: {
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
    paddingVertical: 12,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: "#ddd",
  },
  rowText: { flex: 1 },
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
