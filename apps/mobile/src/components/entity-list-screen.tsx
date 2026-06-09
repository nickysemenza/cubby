import { Image } from "expo-image";
import type { ReactNode } from "react";
import {
  ActivityIndicator,
  FlatList,
  RefreshControl,
  StyleSheet,
  Text,
  View,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";

type EntityListScreenProps<T> = {
  title: string;
  items: T[];
  isLoading: boolean;
  isRefetching?: boolean;
  error: { message: string } | null;
  onRefresh?: () => void;
  count?: number;
  keyExtractor: (item: T) => string;
  primaryText: (item: T) => string;
  secondaryText?: (item: T) => string | null | undefined;
  /** Thumbnail URL for the row; when provided, a leading image column is shown. */
  imageUrl?: (item: T) => string | null | undefined;
  headerRight?: ReactNode;
  emptyText?: string;
};

/** Shared presentational list screen used by inventory / recipes / locations. */
export function EntityListScreen<T>({
  title,
  items,
  isLoading,
  isRefetching,
  error,
  onRefresh,
  count,
  keyExtractor,
  primaryText,
  secondaryText,
  imageUrl,
  headerRight,
  emptyText = "Nothing here yet.",
}: EntityListScreenProps<T>) {
  const showImages = imageUrl != null;

  return (
    <SafeAreaView style={styles.flex} edges={["top"]}>
      <View style={styles.header}>
        <Text style={styles.title}>
          {title}
          {count != null ? ` (${count})` : ""}
        </Text>
        {headerRight}
      </View>

      {isLoading ? (
        <View style={styles.center}>
          <ActivityIndicator size="large" />
        </View>
      ) : error ? (
        <View style={styles.center}>
          <Text style={styles.error}>{error.message}</Text>
        </View>
      ) : (
        <FlatList
          data={items}
          keyExtractor={keyExtractor}
          contentContainerStyle={styles.listContent}
          refreshControl={
            onRefresh ? (
              <RefreshControl
                refreshing={isRefetching ?? false}
                onRefresh={onRefresh}
              />
            ) : undefined
          }
          renderItem={({ item }) => {
            const secondary = secondaryText?.(item);
            const uri = imageUrl?.(item);
            return (
              <View style={styles.row}>
                {showImages ? (
                  uri ? (
                    <Image
                      style={styles.thumb}
                      source={{ uri }}
                      contentFit="cover"
                      transition={150}
                      cachePolicy="memory-disk"
                    />
                  ) : (
                    <View style={[styles.thumb, styles.thumbPlaceholder]}>
                      <Text style={styles.thumbInitial}>
                        {primaryText(item).trim().charAt(0).toUpperCase() ||
                          "?"}
                      </Text>
                    </View>
                  )
                ) : null}
                <View style={styles.rowText}>
                  <Text style={styles.name} numberOfLines={2}>
                    {primaryText(item)}
                  </Text>
                  {secondary ? (
                    <Text style={styles.sub} numberOfLines={1}>
                      {secondary}
                    </Text>
                  ) : null}
                </View>
              </View>
            );
          }}
          ListEmptyComponent={<Text style={styles.empty}>{emptyText}</Text>}
        />
      )}
    </SafeAreaView>
  );
}

const THUMB = 48;

const styles = StyleSheet.create({
  flex: { flex: 1, backgroundColor: "#fff" },
  header: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: 16,
    paddingTop: 8,
    paddingBottom: 12,
  },
  title: { fontSize: 28, fontWeight: "800" },
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
    width: THUMB,
    height: THUMB,
    borderRadius: 8,
    backgroundColor: "#f0f0f0",
  },
  thumbPlaceholder: { alignItems: "center", justifyContent: "center" },
  thumbInitial: { fontSize: 18, fontWeight: "700", color: "#999" },
  name: { fontSize: 16, fontWeight: "600" },
  sub: { fontSize: 14, color: "#666", marginTop: 2 },
  error: { color: "#c0392b", paddingHorizontal: 24, textAlign: "center" },
  empty: { color: "#666", paddingVertical: 24, textAlign: "center" },
});
