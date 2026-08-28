import { type LocationOut, locationOut } from "@cubby/schemas/location";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import { z } from "zod";

import { IngredientForm } from "~/app/_components/ingredients/ingredient-form";
import { LocationForm } from "~/app/_components/locations/location-form";
import { ProductForm } from "~/app/_components/products/product-form";
import { ResponsiveDialog } from "~/components/ui/responsive-dialog";
import { getErrorMessage } from "~/lib/error-utils";

import type { EntityEditResultFor } from "./intent-types";
import type { EntityEditMutationData } from "./types";
import { useEntityCommands } from "./use-entity-commands";

type FormDialogEntity = "product" | "ingredient" | "location";

interface EntityFormDialogSeed {
  name?: string;
  expectedQuantity?: number | null;
  manufacturer?: string;
  upc?: string | null;
  fdcId?: number | null;
  parentLocation?: LocationOut;
}

const presentation = {
  product: { title: "Create New Product", size: "xl" as const },
  ingredient: { title: "Create New Ingredient", size: "md" as const },
  location: { title: "Create New Location", size: "md" as const },
};

/**
 * Generic dialog host for the three rich entity forms that deliberately own
 * specialized RHF state (images, hierarchy, and food metadata). Their final
 * standard CRUD write still crosses the entity-editing command seam here.
 */
export function EntityFormDialog<E extends FormDialogEntity>({
  entity,
  open,
  onOpenChange,
  seed = {},
  onSuccess,
}: {
  entity: E;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  seed?: EntityFormDialogSeed;
  onSuccess?: (result: EntityEditResultFor<E>) => void;
}) {
  const commands = useEntityCommands(entity);
  const [error, setError] = useState<string>();
  useEffect(() => {
    if (open) setError(undefined);
  }, [open]);
  const submit = async (data: EntityEditMutationData<E>) => {
    setError(undefined);
    try {
      const execution = await commands.submit({
        operation: "create",
        intent: "full",
        data,
      });
      if (execution.operation !== "create") {
        throw new Error(`${entity} create returned ${execution.operation}.`);
      }
      const result = execution.result;
      const namedResult = z
        .object({ name: z.string().nullable().optional() })
        .safeParse(result);
      const name = namedResult.success
        ? namedResult.data.name || entity
        : entity;
      toast.success(`Created "${name}"`);
      onOpenChange(false);
      onSuccess?.(result);
      return result;
    } catch (cause) {
      setError(getErrorMessage(cause));
      throw cause;
    }
  };
  const close = () => {
    setError(undefined);
    onOpenChange(false);
  };

  return (
    <ResponsiveDialog
      open={open}
      onOpenChange={onOpenChange}
      title={
        entity === "location" && seed.parentLocation
          ? "Create Child Location"
          : presentation[entity].title
      }
      description={
        entity === "location" && seed.parentLocation
          ? `Create a new location inside "${seed.parentLocation.name}"`
          : undefined
      }
      size={presentation[entity].size}
    >
      {entity === "product" ? (
        <ProductForm
          mode="create"
          isPending={commands.isPending}
          error={error}
          onCancel={close}
          onCreate={(data) => void submit(data)}
          initialName={seed.name}
          initialExpectedQuantity={seed.expectedQuantity}
          initialManufacturer={seed.manufacturer}
          initialUpc={seed.upc}
          initialFdcId={seed.fdcId}
          embedded
        />
      ) : entity === "ingredient" ? (
        <IngredientForm
          mode="create"
          isPending={commands.isPending}
          error={error}
          onCancel={close}
          onCreate={(data) => void submit(data)}
          initialName={seed.name}
        />
      ) : (
        <LocationForm
          mode="create"
          isPending={commands.isPending}
          error={error}
          onCancel={close}
          onCreate={async (data) => locationOut.parse(await submit(data))}
          initialName={seed.name}
          initialParent={seed.parentLocation}
        />
      )}
    </ResponsiveDialog>
  );
}
