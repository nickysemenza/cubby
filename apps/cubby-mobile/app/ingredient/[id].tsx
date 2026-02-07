import { useQuery } from "@tanstack/react-query";
import { colors } from "@cubby/shared";
import { Stack, useLocalSearchParams } from "expo-router";
import {
  ActivityIndicator,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from "react-native";

import { api } from "@/lib/api";

export default function IngredientDetail() {
  const { id } = useLocalSearchParams<{ id: string }>();

  const { data: ingredient, isLoading } = useQuery(
    api.ingredient.getByID.queryOptions({ id: id! }),
  );

  if (isLoading) {
    return (
      <View style={styles.center}>
        <ActivityIndicator size="large" color={colors.terracotta} />
      </View>
    );
  }

  if (!ingredient) {
    return (
      <View style={styles.center}>
        <Text style={styles.notFound}>Ingredient not found</Text>
      </View>
    );
  }

  return (
    <ScrollView style={styles.container}>
      <Stack.Screen options={{ title: ingredient.name }} />
      <View style={styles.content}>
        <Text style={styles.title}>{ingredient.name}</Text>
        {ingredient.shortcode && (
          <Detail label="Shortcode" value={ingredient.shortcode} />
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
  content: { padding: 16 },
  title: { fontSize: 24, fontWeight: "bold", color: colors.foreground },
  notFound: { color: colors.mutedForeground },
  detail: { marginTop: 12 },
  detailLabel: { fontSize: 14, color: colors.shelf },
  detailValue: { fontSize: 16, color: colors.foreground },
});
