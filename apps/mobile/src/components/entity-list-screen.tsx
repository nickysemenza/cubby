import { getAppErrorDetails } from "@cubby/api-contract";
import { FlashList } from "@shopify/flash-list";
import { Image } from "expo-image";
import type { ReactNode } from "react";
import {
  ActivityIndicator,
  Pressable,
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
  error: unknown;
  onRefresh?: () => void;
  count?: number;
  keyExtractor: (item: T) => string;
  primaryText: (item: T) => string;
  secondaryText?: (item: T) => string | null | undefined;
  /** Thumbnail URL for the row; when provided, a leading image column is shown. */
  imageUrl?: (item: T) => string | null | undefined;
  /** When provided, rows become tappable and call this on press. */
  onPressItem?: (item: T) => void;
  /** Called when the list nears the end — load the next page. */
  onEndReached?: () => void;
  /** Show a footer spinner while the next page loads. */
  isFetchingMore?: boolean;
  /**
   * Up to 2 right-aligned values per row (first emphasized, second muted) —
   * e.g. a price/quantity, like the web mobile cards. Falsy entries are dropped.
   */
  rightValues?: (item: T) => (string | null | undefined)[];
  headerRight?: ReactNode;
  emptyText?: string;
  /**
   * When true, the screen is rendered under a navigation Stack header (which
   * supplies the title + back button), so the internal title row and top
   * safe-area inset are skipped to avoid duplication.
   */
  embedded?: boolean;
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
  onPressItem,
  onEndReached,
  isFetchingMore,
  rightValues,
  headerRight,
  emptyText = "Nothing here yet.",
  embedded = false,
}: EntityListScreenProps<T>) {
  const showImages = imageUrl != null;

  return (
    <SafeAreaView style={styles.flex} edges={embedded ? [] : ["top"]}>
      {embedded ? null : (
        <View style={styles.header}>
          <Text style={styles.title}>
            {title}
            {count != null ? ` (${count})` : ""}
          </Text>
          {headerRight}
        </View>
      )}

      {isLoading ? (
        <View style={styles.center}>
          <ActivityIndicator size="large" />
        </View>
      ) : error ? (
        <View style={styles.center}>
          <Text style={styles.error}>{getAppErrorDetails(error).message}</Text>
        </View>
      ) : (
        <View style={styles.listWrap}>
          <FlashList
            data={items}
            keyExtractor={keyExtractor}
            contentContainerStyle={styles.listContent}
            onEndReached={onEndReached}
            onEndReachedThreshold={1.5}
            drawDistance={600}
            ListFooterComponent={
              isFetchingMore ? (
                <ActivityIndicator style={styles.footer} />
              ) : null
            }
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
              const rights = (rightValues?.(item) ?? []).filter(
                (v): v is string => !!v,
              );
              return (
                <Pressable
                  style={({ pressed }) => [
                    styles.row,
                    pressed && onPressItem ? styles.rowPressed : null,
                  ]}
                  onPress={onPressItem ? () => onPressItem(item) : undefined}
                  disabled={!onPressItem}
                >
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
                  {rights.length ? (
                    <View style={styles.rightCol}>
                      <Text style={styles.rightPrimary} numberOfLines={1}>
                        {rights[0]}
                      </Text>
                      {rights[1] ? (
                        <Text style={styles.rightSecondary} numberOfLines={1}>
                          {rights[1]}
                        </Text>
                      ) : null}
                    </View>
                  ) : null}
                  {onPressItem ? <Text style={styles.chevron}>›</Text> : null}
                </Pressable>
              );
            }}
            ListEmptyComponent={<Text style={styles.empty}>{emptyText}</Text>}
          />
        </View>
      )}
    </SafeAreaView>
  );
}

const THUMB = 40;

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
  listWrap: { flex: 1 },
  listContent: { paddingHorizontal: 16, paddingBottom: 24 },
  row: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    paddingVertical: 8,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: "#e6e6e6",
  },
  rowPressed: { opacity: 0.55 },
  rowText: { flex: 1 },
  rightCol: { alignItems: "flex-end", maxWidth: 120 },
  rightPrimary: { fontSize: 14, fontWeight: "700", color: "#222" },
  rightSecondary: { fontSize: 11, color: "#888", marginTop: 1 },
  chevron: { fontSize: 22, color: "#c4c4c4", marginLeft: 2 },
  footer: { paddingVertical: 16 },
  thumb: {
    width: THUMB,
    height: THUMB,
    borderRadius: 6,
    backgroundColor: "#f0f0f0",
  },
  thumbPlaceholder: { alignItems: "center", justifyContent: "center" },
  thumbInitial: { fontSize: 16, fontWeight: "700", color: "#999" },
  name: { fontSize: 15, fontWeight: "600" },
  sub: { fontSize: 13, color: "#666", marginTop: 1 },
  error: { color: "#c0392b", paddingHorizontal: 24, textAlign: "center" },
  empty: { color: "#666", paddingVertical: 24, textAlign: "center" },
});
