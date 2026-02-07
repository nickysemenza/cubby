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

import { Pill } from "@/components/Pill";
import { api } from "@/lib/api";

const screenWidth = Dimensions.get("window").width;

export default function RecipeDetail() {
  const { id } = useLocalSearchParams<{ id: string }>();

  const { data: recipe, isLoading } = useQuery(
    api.recipe.getByID.queryOptions({ id: id! }),
  );

  if (isLoading) {
    return (
      <View style={styles.center}>
        <ActivityIndicator size="large" color={colors.terracotta} />
      </View>
    );
  }

  if (!recipe) {
    return (
      <View style={styles.center}>
        <Text style={styles.notFound}>Recipe not found</Text>
      </View>
    );
  }

  const images = recipe.images?.filter((img) => img.url) ?? [];
  const totalIngredients =
    recipe.sections?.reduce(
      (sum, s) => sum + (s.ingredients?.length ?? 0),
      0,
    ) ?? 0;

  return (
    <ScrollView style={styles.container}>
      <Stack.Screen options={{ title: recipe.name }} />
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
        <Text style={styles.title}>{recipe.name}</Text>

        <View style={styles.metaRow}>
          {recipe.servings && (
            <Pill
              label={`${recipe.servings} servings`}
              color={colors.terracotta}
            />
          )}
          {recipe.yield && (
            <Pill
              label={`${recipe.yield.value} ${recipe.yield.unit}`}
              color={colors.shelf}
            />
          )}
          {totalIngredients > 0 && (
            <Pill
              label={`${totalIngredients} ingredients`}
              color="hsl(140, 40%, 45%)"
            />
          )}
        </View>

        {recipe.tags && recipe.tags.length > 0 && (
          <View style={styles.tagsRow}>
            {recipe.tags.map((tag) => (
              <Pill key={tag} label={tag} color={colors.mutedForeground} />
            ))}
          </View>
        )}

        {recipe.meta?.url && (
          <Detail label="Source URL" value={recipe.meta.url} />
        )}

        {recipe.sections?.map((section, idx) => (
          <View key={section.id ?? idx} style={styles.section}>
            {section.name && (
              <Text style={styles.sectionTitle}>{section.name}</Text>
            )}
            {section.ingredients?.length > 0 && (
              <View style={styles.ingredientList}>
                <Text style={styles.listHeader}>Ingredients</Text>
                {section.ingredients.map((si) => {
                  const name =
                    si.type === "ingredient"
                      ? si.ingredient?.name
                      : si.recipe?.name;
                  const amountStr = si.amounts
                    ?.map((a) => `${a.quantity} ${a.unit}`)
                    .join(", ");
                  return (
                    <Text key={si.id} style={styles.ingredientItem}>
                      {amountStr ? `${amountStr} ` : ""}
                      {name ?? "Unknown"}
                    </Text>
                  );
                })}
              </View>
            )}
            {section.instructions?.length > 0 && (
              <View style={styles.instructionList}>
                <Text style={styles.listHeader}>Instructions</Text>
                {section.instructions.map((inst, i) => (
                  // biome-ignore lint/suspicious/noArrayIndexKey: instructions have no stable ID
                  <Text key={i} style={styles.instructionItem}>
                    {i + 1}. {inst.instruction}
                  </Text>
                ))}
              </View>
            )}
          </View>
        ))}
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
  metaRow: { flexDirection: "row", gap: 8, marginTop: 8, flexWrap: "wrap" },
  tagsRow: { flexDirection: "row", gap: 6, marginTop: 8, flexWrap: "wrap" },
  notFound: { color: colors.mutedForeground },
  detail: { marginTop: 12 },
  detailLabel: { fontSize: 14, color: colors.shelf },
  detailValue: { fontSize: 16, color: colors.foreground },
  section: { marginTop: 20 },
  sectionTitle: {
    fontSize: 18,
    fontWeight: "600",
    color: colors.foreground,
    marginBottom: 8,
  },
  ingredientList: { marginTop: 8 },
  listHeader: {
    fontSize: 14,
    fontWeight: "600",
    color: colors.shelf,
    marginBottom: 4,
    textTransform: "uppercase",
    letterSpacing: 0.5,
  },
  ingredientItem: {
    fontSize: 15,
    color: colors.foreground,
    paddingVertical: 3,
  },
  instructionList: { marginTop: 12 },
  instructionItem: {
    fontSize: 15,
    color: colors.foreground,
    paddingVertical: 4,
    lineHeight: 22,
  },
});
