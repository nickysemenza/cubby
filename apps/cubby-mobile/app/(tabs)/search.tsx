import MaterialIcons from "@expo/vector-icons/MaterialIcons";
import { useQuery } from "@tanstack/react-query";
import {
  colors,
  getCategoryColor,
  getErrorMessage,
  getLocationTypeColor,
} from "@cubby/shared";
import { useRouter } from "expo-router";
import { useCallback, useState } from "react";
import {
  ActivityIndicator,
  FlatList,
  Image,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from "react-native";

import { api } from "@/lib/api";

type SearchResultItem = {
  id: string;
  name: string;
  entityType: string;
  typeHint?: string | null;
  subtitle?: string | null;
  imageUrl?: string | null;
  price?: number | null;
  stockCount?: number | null;
  itemCount?: number | null;
  childCount?: number | null;
  amount?: { quantity: number; unit: string } | null;
  ingredientCount?: number | null;
  recipeCount?: number | null;
};

const ENTITY_ICONS: Record<string, keyof typeof MaterialIcons.glyphMap> = {
  product: "inventory-2",
  location: "place",
  inventory: "list-alt",
  recipe: "restaurant-menu",
  ingredient: "eco",
};

function getEntityColor(entityType: string, typeHint: string | null): string {
  switch (entityType) {
    case "product":
      return typeHint ? getCategoryColor(typeHint) : colors.terracotta;
    case "location":
      return typeHint ? getLocationTypeColor(typeHint) : colors.terracotta;
    case "recipe":
      return "hsl(25, 60%, 50%)";
    case "ingredient":
      return "hsl(140, 40%, 45%)";
    case "inventory":
      return colors.shelf;
    default:
      return colors.terracotta;
  }
}

function getEnrichmentText(item: SearchResultItem): string | null {
  switch (item.entityType) {
    case "product": {
      const parts: string[] = [];
      if (item.price != null) parts.push(`$${item.price.toFixed(2)}`);
      if (item.stockCount != null) parts.push(`${item.stockCount} in stock`);
      return parts.length > 0 ? parts.join(" · ") : null;
    }
    case "location": {
      const parts: string[] = [];
      if (item.itemCount != null) parts.push(`${item.itemCount} items`);
      if (item.childCount != null)
        parts.push(`${item.childCount} sub-locations`);
      return parts.length > 0 ? parts.join(" · ") : null;
    }
    case "inventory":
      return item.amount ? `${item.amount.quantity} ${item.amount.unit}` : null;
    case "recipe":
      return item.ingredientCount != null
        ? `${item.ingredientCount} ingredients`
        : null;
    case "ingredient":
      return item.recipeCount != null ? `${item.recipeCount} recipes` : null;
    default:
      return null;
  }
}

function getDetailRoute(item: SearchResultItem): string | null {
  switch (item.entityType) {
    case "product":
      return `/product/${item.id}`;
    case "location":
      return `/location/${item.id}`;
    case "recipe":
      return `/recipe/${item.id}`;
    case "ingredient":
      return `/ingredient/${item.id}`;
    default:
      return null;
  }
}

export default function SearchScreen() {
  const router = useRouter();
  const [searchText, setSearchText] = useState("");
  const [debouncedQuery, setDebouncedQuery] = useState("");
  const debounceRef = useState<ReturnType<typeof setTimeout> | null>(null);

  const handleSearch = useCallback(
    (text: string) => {
      setSearchText(text);
      if (debounceRef[0]) clearTimeout(debounceRef[0]);
      debounceRef[0] = setTimeout(() => {
        setDebouncedQuery(text.trim());
      }, 300);
    },
    [debounceRef],
  );

  const { data, isLoading, error } = useQuery({
    ...api.search.global.queryOptions({
      query: debouncedQuery,
      limit: 30,
    }),
    enabled: debouncedQuery.length > 0,
  });

  return (
    <View style={styles.container}>
      <View style={styles.searchBar}>
        <MaterialIcons name="search" size={20} color={colors.shelf} />
        <TextInput
          style={styles.input}
          placeholder="Search products, locations, recipes..."
          placeholderTextColor={colors.mutedForeground}
          value={searchText}
          onChangeText={handleSearch}
          autoCapitalize="none"
          autoCorrect={false}
          returnKeyType="search"
        />
        {searchText.length > 0 && (
          <TouchableOpacity onPress={() => handleSearch("")}>
            <MaterialIcons name="close" size={20} color={colors.shelf} />
          </TouchableOpacity>
        )}
      </View>

      {!debouncedQuery && (
        <View style={styles.emptyState}>
          <MaterialIcons name="search" size={48} color={colors.muted} />
          <Text style={styles.emptyText}>Search across all your items</Text>
        </View>
      )}

      {debouncedQuery && isLoading && (
        <View style={styles.loadingContainer}>
          <ActivityIndicator size="large" color={colors.terracotta} />
        </View>
      )}

      {debouncedQuery && error && (
        <View style={styles.loadingContainer}>
          <Text style={styles.errorText}>{getErrorMessage(error)}</Text>
        </View>
      )}

      {debouncedQuery && !isLoading && !error && (
        <FlatList
          data={(data ?? []) as SearchResultItem[]}
          keyExtractor={(item) => `${item.entityType}-${item.id}`}
          renderItem={({ item }) => {
            const entityColor = getEntityColor(
              item.entityType,
              item.typeHint ?? null,
            );
            const enrichment = getEnrichmentText(item);
            const route = getDetailRoute(item);
            return (
              <TouchableOpacity
                style={styles.row}
                onPress={() => route && router.push(route)}
                disabled={!route}
              >
                {item.imageUrl ? (
                  <Image
                    source={{ uri: item.imageUrl }}
                    style={styles.thumbnail}
                  />
                ) : (
                  <View
                    style={[
                      styles.iconContainer,
                      { backgroundColor: `${entityColor}20` },
                    ]}
                  >
                    <MaterialIcons
                      name={ENTITY_ICONS[item.entityType] ?? "help-outline"}
                      size={24}
                      color={entityColor}
                    />
                  </View>
                )}
                <View style={styles.text}>
                  <Text style={styles.name} numberOfLines={1}>
                    {item.name}
                  </Text>
                  {item.subtitle && (
                    <Text style={styles.subtitle} numberOfLines={1}>
                      {item.subtitle}
                    </Text>
                  )}
                  {enrichment && (
                    <Text style={styles.enrichment}>{enrichment}</Text>
                  )}
                </View>
                <View style={styles.typeBadge}>
                  <Text style={[styles.typeLabel, { color: entityColor }]}>
                    {item.entityType}
                  </Text>
                </View>
              </TouchableOpacity>
            );
          }}
          ListEmptyComponent={
            <View style={styles.emptyState}>
              <Text style={styles.emptyText}>No results found</Text>
            </View>
          }
        />
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.cream },
  searchBar: {
    flexDirection: "row",
    alignItems: "center",
    margin: 12,
    paddingHorizontal: 12,
    paddingVertical: 10,
    backgroundColor: "#fff",
    borderRadius: 10,
    borderWidth: 1,
    borderColor: colors.border,
    gap: 8,
  },
  input: {
    flex: 1,
    fontSize: 16,
    color: colors.foreground,
    padding: 0,
  },
  loadingContainer: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
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
    width: 44,
    height: 44,
    borderRadius: 6,
    backgroundColor: colors.muted,
    marginRight: 12,
  },
  iconContainer: {
    width: 44,
    height: 44,
    borderRadius: 6,
    alignItems: "center",
    justifyContent: "center",
    marginRight: 12,
  },
  text: { flex: 1 },
  name: { fontSize: 16, fontWeight: "500", color: colors.foreground },
  subtitle: { fontSize: 14, color: colors.shelf, marginTop: 2 },
  enrichment: { fontSize: 13, color: colors.mutedForeground, marginTop: 2 },
  typeBadge: { marginLeft: 8 },
  typeLabel: { fontSize: 12, fontWeight: "600", textTransform: "capitalize" },
  emptyState: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    paddingTop: 60,
    gap: 12,
  },
  emptyText: { color: colors.mutedForeground, fontSize: 16 },
  errorText: { color: colors.destructive },
});
