import { unsafeRecipeId } from "@cubby/schemas/identifiers";
import { useQuery } from "@tanstack/react-query";
import { useLocalSearchParams } from "expo-router";
import { DetailView } from "@/components/detail-view";
import { useTRPC } from "@/lib/trpc";

export default function RecipeDetail() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const trpc = useTRPC();
  const q = useQuery(
    trpc.recipe.getByID.queryOptions({ id: unsafeRecipeId(id) }),
  );
  const r = q.data;
  const book = r?.source && r.source.type === "book" ? r.source.book : null;

  return (
    <DetailView
      isLoading={q.isLoading}
      error={q.error}
      imageUrl={r?.images[0]?.url}
      title={r?.name ?? "Untitled recipe"}
      subtitle={book}
      rows={[{ label: "Source", value: r?.source?.type }]}
    />
  );
}
