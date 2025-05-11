import { type Table } from "@tanstack/react-table";

import { Button } from "~/components/ui/button";
import { useTRPC } from "~/trpc/react";
import { toast } from "sonner";
import { IngredientPillLink } from "../_components/EntityPill";
import { type IngredientWithRecipesAndProductOut } from "~/schemas/combo";

import { useMutation } from "@tanstack/react-query";

interface IngredientMergerProps {
  table: Table<IngredientWithRecipesAndProductOut>;
}
export function IngredientMerger({ table }: IngredientMergerProps) {
  const api = useTRPC();
  const merge = useMutation(api.ingredient.merge.mutationOptions());
  const selected = table.getFilteredSelectedRowModel().rows.map((x) => {
    const { id, name } = x.original;
    return { id, name };
  });
  if (selected.length < 2) {
    return null;
  }
  const target = selected[0];
  if (target === undefined) {
    return null;
  }
  const aliases = selected.slice(1);

  const doMerge = async () => {
    await merge.mutateAsync({
      target: target.id,
      aliases: aliases.map((x) => x.id),
    });
    toast.success(
      `Merged ${target.name} with ${aliases.map((a) => a.name).join(", ")}`,
    );
  };

  return (
    <div className="border-1 border-dashed border-orange-500 p-2">
      <h3>target</h3>
      <IngredientPillLink name={target.name} id={target.id} />
      <h3>aliases to create</h3>
      {aliases.map((a) => (
        <IngredientPillLink key={a.id} name={a.name} id={a.id} />
      ))}
      <Button onClick={() => doMerge()}>merge</Button>
    </div>
  );
}
