import { type Table } from "@tanstack/react-table";

import { Button } from "~/components/ui/button";
import { type IngredientOut } from "~/schemas/ingredient";
import { api } from "~/trpc/react";
import { toast } from "react-toastify";
import { IngredientPillLink } from "../_components/EntityPill";

interface IngredientMergerProps {
  table: Table<IngredientOut>;
}
export function IngredientMerger({ table }: IngredientMergerProps) {
  const merge = api.ingredient.merge.useMutation();
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
    toast(
      `Merged ${target.name} with ${aliases.map((a) => a.name).join(", ")}`,
      { type: "success" },
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
