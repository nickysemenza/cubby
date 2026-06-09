import { unsafeIngredientId } from "@cubby/schemas/identifiers";
import { useQuery } from "@tanstack/react-query";
import { useLocalSearchParams } from "expo-router";
import { DetailView } from "@/components/detail-view";
import { useTRPC } from "@/lib/trpc";

export default function IngredientDetail() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const trpc = useTRPC();
  const q = useQuery(
    trpc.ingredient.getByID.queryOptions({ id: unsafeIngredientId(id) }),
  );
  const ing = q.data;

  return (
    <DetailView
      isLoading={q.isLoading}
      error={q.error}
      title={ing?.name}
      rows={[]}
    />
  );
}
