import { useQuery } from "@tanstack/react-query";
import { colors } from "@cubby/shared";
import { Stack, useLocalSearchParams } from "expo-router";
import {
  ActivityIndicator,
  Dimensions,
  Image,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from "react-native";

import { CategoryBadge } from "@/components/CategoryBadge";
import { api } from "@/lib/api";

const screenWidth = Dimensions.get("window").width;

export default function ProductDetail() {
  const { id } = useLocalSearchParams<{ id: string }>();

  const { data: product, isLoading } = useQuery(
    api.product.getByID.queryOptions({ id: id! }),
  );

  if (isLoading) {
    return (
      <View style={styles.center}>
        <ActivityIndicator size="large" color={colors.terracotta} />
      </View>
    );
  }

  if (!product) {
    return (
      <View style={styles.center}>
        <Text style={styles.notFound}>Product not found</Text>
      </View>
    );
  }

  const images = product.images?.filter((img) => img.url) ?? [];

  return (
    <ScrollView style={styles.container}>
      <Stack.Screen options={{ title: product.name }} />
      {images.length > 0 && (
        <ScrollView
          horizontal
          pagingEnabled
          showsHorizontalScrollIndicator={false}
          style={styles.imageScroller}
        >
          {images.map((img) => (
            <Image
              key={img.id}
              source={{ uri: img.url }}
              style={styles.heroImage}
              resizeMode="cover"
            />
          ))}
        </ScrollView>
      )}
      <View style={styles.content}>
        <Text style={styles.title}>{product.name}</Text>
        {product.category && (
          <View style={styles.badgeRow}>
            <CategoryBadge category={product.category} />
          </View>
        )}
        {product.manufacturer && (
          <Detail label="Manufacturer" value={product.manufacturer} />
        )}
        {product.upc && <Detail label="UPC" value={product.upc} />}
        {product.shortcode && (
          <Detail label="Shortcode" value={product.shortcode} />
        )}
        {product.description && (
          <Detail label="Description" value={product.description} />
        )}
      </View>
    </ScrollView>
  );
}

function Detail({ label, value }: { label: string; value: string }) {
  return (
    <View style={styles.detail}>
      <Text style={styles.detailLabel}>{label}</Text>
      <Text style={styles.detailValue}>{value}</Text>
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
  imageScroller: { flexGrow: 0 },
  heroImage: {
    width: screenWidth,
    height: 250,
    backgroundColor: colors.muted,
  },
  content: { padding: 16 },
  title: { fontSize: 24, fontWeight: "bold", color: colors.foreground },
  badgeRow: { marginTop: 8 },
  notFound: { color: colors.mutedForeground },
  detail: { marginTop: 12 },
  detailLabel: { fontSize: 14, color: colors.shelf },
  detailValue: { fontSize: 16, color: colors.foreground },
});
