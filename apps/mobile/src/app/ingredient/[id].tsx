import { unsafeIngredientId } from "@cubby/schemas/identifiers";
import { useQuery } from "@tanstack/react-query";
import { router, useLocalSearchParams } from "expo-router";
import {
  DetailLine,
  DetailNavRow,
  DetailSection,
  DetailView,
} from "@/components/detail-view";
import { useTRPC } from "@/lib/trpc";

export default function IngredientDetail() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const trpc = useTRPC();
  const q = useQuery(
    trpc.ingredient.getByID.queryOptions({ id: unsafeIngredientId(id) }),
  );
  const ing = q.data;
  const recipes = ing?.appearsInRecipes ?? [];
  const products = ing?.product ?? [];
  const food = products.find((p) => p.food)?.food;
  const nutrition = products.find((p) => p.food?.nutritionInfo)?.food
    ?.nutritionInfo;

  return (
    <DetailView
      isLoading={q.isLoading}
      error={q.error}
      title={ing?.name}
      subtitle={ing?.aliases.length ? ing.aliases.join(", ") : null}
      rows={[{ label: "USDA", value: food?.foodInfo.description }]}
    >
      {recipes.length ? (
        <DetailSection title={`Appears in recipes (${recipes.length})`}>
          {recipes.map((r) => (
            <DetailNavRow
              key={r.id}
              label={r.name ?? "Untitled recipe"}
              sublabel={r.tags?.length ? r.tags.join(", ") : null}
              onPress={() => router.push(`/recipe/${r.id}`)}
            />
          ))}
        </DetailSection>
      ) : null}

      {products.length ? (
        <DetailSection title={`Products (${products.length})`}>
          {products.map((p) => (
            <DetailNavRow
              key={p.id}
              label={p.name}
              sublabel={p.manufacturer}
              onPress={() => router.push(`/product/${p.id}`)}
            />
          ))}
        </DetailSection>
      ) : null}

      {nutrition ? (
        <DetailSection title="Nutrition">
          {nutrition.nutrientSummary.map((n) => (
            <DetailLine
              key={n.name}
            >{`${n.name}: ${n.amount} ${n.unit}`}</DetailLine>
          ))}
        </DetailSection>
      ) : null}
    </DetailView>
  );
}
