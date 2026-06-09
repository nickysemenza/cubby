import type { RichItem, WAmount } from "@cubby/recipebridge";
import { unsafeRecipeId } from "@cubby/schemas/identifiers";
import { useQuery } from "@tanstack/react-query";
import { router, useLocalSearchParams } from "expo-router";
import { Pressable, StyleSheet, Text, View } from "react-native";
import { DetailView } from "@/components/detail-view";
import { type RouterOutputs, useTRPC } from "@/lib/trpc";
import {
  useFormattedAmountLists,
  useFormattedAmounts,
} from "@/lib/use-formatted-amounts";
import { useRichInstructions } from "@/lib/use-rich-instructions";

type Recipe = RouterOutputs["recipe"]["getByID"];
type Section = Recipe["sections"][number];
type SectionIngredient = Section["ingredients"][number];

const ingredientName = (ing: SectionIngredient): string =>
  ing.type === "ingredient" ? ing.ingredient.name : ing.recipe.name;

const measureText = (amounts: WAmount[]): string => {
  const last = amounts.at(-1);
  if (!last) return "";
  return last.unit === "whole" ? `${last.value}` : `${last.value} ${last.unit}`;
};

export default function RecipeDetail() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const trpc = useTRPC();
  const q = useQuery(
    trpc.recipe.getByID.queryOptions({ id: unsafeRecipeId(id) }),
  );
  const r = q.data;
  const book = r?.source && r.source.type === "book" ? r.source.book : null;
  const sections = r?.sections ?? [];
  const ingredients = sections.flatMap((s) => s.ingredients);
  const stepTexts = sections.flatMap((s) =>
    s.instructions.map((i) => i.instruction),
  );

  // Amounts formatted on-device (recipebridge), one round-trip, joined " / ".
  const formattedAmounts = useFormattedAmountLists(
    ingredients,
    (ing) => ing.id,
    (ing) => ing.amounts,
    " / ",
  );

  // Map an ingredient name (as it appears in instruction text) → its detail route.
  const linkByName = new Map<string, { id: string; isRecipe: boolean }>();
  for (const ing of ingredients) {
    linkByName.set(
      ingredientName(ing).toLowerCase(),
      ing.type === "ingredient"
        ? { id: ing.ingredient.id, isRecipe: false }
        : { id: ing.recipe.id, isRecipe: true },
    );
  }

  // Instruction steps parsed into ingredient/measurement spans on-device.
  const richSteps = useRichInstructions(
    stepTexts,
    ingredients.map(ingredientName),
  );

  // Format the measurement spans through the same WASM format_amount as the
  // ingredient list, so an amount renders identically in both places.
  const measures: { key: string; amount: WAmount }[] = [];
  richSteps.forEach((items, si) => {
    items?.forEach((it, j) => {
      if (it.kind === "Measure") {
        const last = it.value.at(-1);
        if (last) measures.push({ key: `${si}:${j}`, amount: last });
      }
    });
  });
  const measureFmt = useFormattedAmounts(
    measures,
    (m) => m.key,
    (m) => m.amount,
  );

  const renderSpan = (item: RichItem, stepIdx: number, spanIdx: number) => {
    const key = `${stepIdx}:${spanIdx}`;
    if (item.kind === "Ing") {
      const link = linkByName.get(item.value.toLowerCase());
      if (!link) {
        return (
          <Text key={key} style={styles.ingHi}>
            {item.value}
          </Text>
        );
      }
      return (
        <Text
          key={key}
          style={styles.ingLink}
          onPress={() =>
            link.isRecipe
              ? router.push(`/recipe/${link.id}`)
              : router.push(`/ingredient/${link.id}`)
          }
        >
          {item.value}
        </Text>
      );
    }
    if (item.kind === "Measure") {
      return (
        <Text key={key} style={styles.measure}>
          {measureFmt.get(key) ?? measureText(item.value)}
        </Text>
      );
    }
    return <Text key={key}>{item.value}</Text>;
  };

  return (
    <DetailView
      isLoading={q.isLoading}
      error={q.error}
      imageUrl={r?.images[0]?.url}
      title={r?.name ?? "Untitled recipe"}
      subtitle={book}
      rows={[
        {
          label: "Servings",
          value: r?.servings != null ? String(r.servings) : null,
        },
        {
          label: "Yield",
          value: r?.yield ? `${r.yield.value} ${r.yield.unit}` : null,
        },
        { label: "Tags", value: r?.tags?.length ? r.tags.join(", ") : null },
      ]}
    >
      {ingredients.length ? (
        <View style={styles.block}>
          <View style={styles.rule} />
          <Text style={styles.heading}>Ingredients</Text>
          {ingredients.map((ing) => {
            const name = ingredientName(ing);
            const amount = ing.amounts.length
              ? (formattedAmounts.get(ing.id) ??
                ing.amounts.map((a) => `${a.value} ${a.unit}`).join(" / "))
              : "";
            const showRaw = ing.rawLine && ing.rawLine !== name;
            return (
              <Pressable
                key={ing.id}
                style={({ pressed }) => [
                  styles.ingRow,
                  pressed && styles.pressed,
                ]}
                onPress={() =>
                  ing.type === "ingredient"
                    ? router.push(`/ingredient/${ing.ingredient.id}`)
                    : router.push(`/recipe/${ing.recipe.id}`)
                }
              >
                <Text style={styles.amount}>{amount}</Text>
                <View style={styles.nameCol}>
                  <Text style={styles.name}>{name}</Text>
                  {showRaw ? (
                    <Text style={styles.raw}>{ing.rawLine}</Text>
                  ) : null}
                </View>
              </Pressable>
            );
          })}
        </View>
      ) : null}

      {stepTexts.length ? (
        <View style={styles.block}>
          <View style={styles.rule} />
          <Text style={styles.heading}>Instructions</Text>
          {stepTexts.map((text, i) => {
            const items = richSteps[i];
            return (
              // biome-ignore lint/suspicious/noArrayIndexKey: stable order, no ids.
              <View key={i} style={styles.step}>
                <Text style={styles.stepNum}>Step {i + 1}</Text>
                <Text style={styles.stepText}>
                  {items ? items.map((it, j) => renderSpan(it, i, j)) : text}
                </Text>
              </View>
            );
          })}
        </View>
      ) : null}
    </DetailView>
  );
}

const styles = StyleSheet.create({
  block: { marginTop: 24 },
  rule: { borderTopWidth: 3, borderTopColor: "#111", marginBottom: 8 },
  heading: {
    fontSize: 13,
    fontWeight: "800",
    letterSpacing: 0.5,
    textTransform: "uppercase",
    color: "#111",
    marginBottom: 8,
  },
  ingRow: {
    flexDirection: "row",
    alignItems: "flex-start",
    paddingVertical: 7,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: "#eee",
  },
  pressed: { opacity: 0.5 },
  amount: {
    width: "42%",
    paddingRight: 12,
    textAlign: "right",
    color: "#888",
    fontSize: 15,
    fontWeight: "300",
    fontVariant: ["tabular-nums"],
  },
  nameCol: { flex: 1 },
  name: { fontSize: 15, color: "#111" },
  raw: { fontSize: 11, color: "#aaa", fontStyle: "italic", marginTop: 2 },
  step: { paddingVertical: 10 },
  stepNum: { fontSize: 16, fontWeight: "700", color: "#111" },
  stepText: { fontSize: 15, color: "#333", marginTop: 3, lineHeight: 21 },
  ingLink: { color: "#208AEF", fontWeight: "600" },
  ingHi: { color: "#111", fontWeight: "600" },
  measure: { color: "#111", fontWeight: "700" },
});
