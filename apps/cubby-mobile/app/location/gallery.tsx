import MaterialIcons from "@expo/vector-icons/MaterialIcons";
import { useQuery } from "@tanstack/react-query";
import { colors } from "@cubby/shared";
import { Stack, useRouter } from "expo-router";
import { useCallback, useState } from "react";
import {
  ActivityIndicator,
  FlatList,
  ScrollView,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from "react-native";

import { LocationCard } from "@/components/LocationCard";
import { api } from "@/lib/api";

type TreeLocation = {
  id: string;
  name: string;
  type: string;
  shortcode: string;
  images?: { url: string; id: string }[];
  children?: TreeLocation[];
  childCount?: number;
  directItemCount?: number;
  totalItemCount?: number;
};

type BreadcrumbItem = {
  id: string | null;
  name: string;
};

export default function LocationGallery() {
  const router = useRouter();
  const [path, setPath] = useState<BreadcrumbItem[]>([
    { id: null, name: "Home" },
  ]);

  const { data: tree, isLoading } = useQuery(
    api.location.makeTree.queryOptions(),
  );

  const currentId = path[path.length - 1]?.id ?? null;

  const getCurrentChildren = useCallback((): TreeLocation[] => {
    if (!tree) return [];
    if (currentId === null) return tree as TreeLocation[];

    // Walk the path to find the current node's children
    function findNode(
      nodes: TreeLocation[],
      targetId: string,
    ): TreeLocation | null {
      for (const node of nodes) {
        if (node.id === targetId) return node;
        if (node.children) {
          const found = findNode(node.children, targetId);
          if (found) return found;
        }
      }
      return null;
    }

    const node = findNode(tree as TreeLocation[], currentId);
    return node?.children ?? [];
  }, [tree, currentId]);

  const children = getCurrentChildren();

  const navigateInto = (loc: TreeLocation) => {
    if (loc.children && loc.children.length > 0) {
      setPath((prev) => [...prev, { id: loc.id, name: loc.name }]);
    } else {
      router.push(`/location/${loc.id}`);
    }
  };

  const navigateTo = (index: number) => {
    setPath((prev) => prev.slice(0, index + 1));
  };

  if (isLoading) {
    return (
      <View style={styles.center}>
        <Stack.Screen options={{ title: "Location Gallery" }} />
        <ActivityIndicator size="large" color={colors.terracotta} />
      </View>
    );
  }

  return (
    <View style={styles.container}>
      <Stack.Screen options={{ title: "Location Gallery" }} />

      {/* Breadcrumb */}
      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        style={styles.breadcrumbScroller}
        contentContainerStyle={styles.breadcrumbContent}
      >
        {path.map((crumb, i) => (
          <View key={crumb.id ?? "root"} style={styles.breadcrumbItem}>
            {i > 0 && (
              <MaterialIcons
                name="chevron-right"
                size={16}
                color={colors.mutedForeground}
              />
            )}
            <TouchableOpacity
              onPress={() => navigateTo(i)}
              disabled={i === path.length - 1}
            >
              <Text
                style={[
                  styles.breadcrumbText,
                  i === path.length - 1 && styles.breadcrumbActive,
                ]}
              >
                {crumb.name}
              </Text>
            </TouchableOpacity>
          </View>
        ))}
      </ScrollView>

      {/* Grid */}
      <FlatList
        data={children}
        numColumns={2}
        keyExtractor={(item) => item.id}
        contentContainerStyle={styles.grid}
        renderItem={({ item }) => (
          <LocationCard
            name={item.name}
            type={item.type}
            imageUrl={item.images?.[0]?.url}
            itemCount={item.directItemCount ?? 0}
            childCount={item.childCount ?? item.children?.length ?? 0}
            onPress={() => navigateInto(item)}
          />
        )}
        ListEmptyComponent={
          <View style={styles.empty}>
            <MaterialIcons name="folder-open" size={48} color={colors.muted} />
            <Text style={styles.emptyText}>No locations at this level</Text>
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
  breadcrumbScroller: {
    flexGrow: 0,
    borderBottomWidth: 1,
    borderBottomColor: colors.border,
  },
  breadcrumbContent: {
    paddingHorizontal: 12,
    paddingVertical: 10,
    alignItems: "center",
  },
  breadcrumbItem: {
    flexDirection: "row",
    alignItems: "center",
  },
  breadcrumbText: {
    fontSize: 14,
    color: colors.terracotta,
    paddingHorizontal: 4,
  },
  breadcrumbActive: {
    color: colors.foreground,
    fontWeight: "600",
  },
  grid: { padding: 6 },
  empty: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    paddingTop: 60,
    gap: 12,
  },
  emptyText: { color: colors.mutedForeground, fontSize: 16 },
});
