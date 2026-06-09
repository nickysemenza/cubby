import { unsafeRecipeId } from "@cubby/schemas/identifiers";
import { useQuery } from "@tanstack/react-query";
import { useLocalSearchParams } from "expo-router";
import { View } from "react-native";
import {
  DetailLine,
  DetailSection,
  DetailView,
} from "@/components/detail-view";
import { type RouterOutputs, useTRPC } from "@/lib/trpc";

type Recipe = RouterOutputs["recipe"]["getByID"];
type Section = Recipe["sections"][number];
type SectionIngredient = Section["ingredients"][number];

function ingredientLine(ing: SectionIngredient): string {
  if (ing.rawLine) return ing.rawLine;
  const amt = ing.amounts.map((a) => `${a.value} ${a.unit}`).join(" + ");
  const name =
    ing.type === "ingredient" ? ing.ingredient.name : ing.recipe.name;
  const mod = ing.modifier ? `, ${ing.modifier}` : "";
  return `${amt ? `${amt} ` : ""}${name}${mod}`.trim();
}

export default function RecipeDetail() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const trpc = useTRPC();
  const q = useQuery(
    trpc.recipe.getByID.queryOptions({ id: unsafeRecipeId(id) }),
  );
  const r = q.data;
  const book = r?.source && r.source.type === "book" ? r.source.book : null;
  const sections = r?.sections ?? [];

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
      {sections.map((s, si) => (
        <View key={s.id}>
          {s.ingredients.length ? (
            <DetailSection
              title={
                s.name ??
                (sections.length > 1 ? `Part ${si + 1}` : "Ingredients")
              }
            >
              {s.ingredients.map((ing) => (
                <DetailLine
                  key={ing.id}
                >{`•  ${ingredientLine(ing)}`}</DetailLine>
              ))}
            </DetailSection>
          ) : null}
          {s.instructions.length ? (
            <DetailSection
              title={s.name ? `${s.name} — Steps` : "Instructions"}
            >
              {s.instructions.map((ins, idx) => (
                <DetailLine
                  key={`${s.id}-${idx}`}
                >{`${idx + 1}.  ${ins.instruction}`}</DetailLine>
              ))}
            </DetailSection>
          ) : null}
        </View>
      ))}
    </DetailView>
  );
}
