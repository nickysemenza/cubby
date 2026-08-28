import { locationOut } from "@cubby/schemas/location";
import { useNavigate } from "@tanstack/react-router";
import { useState } from "react";

import { IngredientForm } from "~/app/_components/ingredients/ingredient-form";
import { LocationForm } from "~/app/_components/locations/location-form";
import { ProductForm } from "~/app/_components/products/product-form";
import { entities, entityDetailLink } from "~/entities/entities";
import { getErrorMessage } from "~/lib/error-utils";

import {
  parseEntityEditCreateInput,
  type UnparsedEntityEditData,
} from "./mutation-data";
import { useEntityCommands } from "./use-entity-commands";

/** Full-page adapter for rich create forms. Navigation is page-owned; the
 * ordinary entity write and invalidation still cross the editing module. */
export function EntityEditPage({
  entity,
}: {
  entity: "product" | "ingredient" | "location";
}) {
  const navigate = useNavigate();
  const commands = useEntityCommands(entity);
  const [error, setError] = useState<string>();
  const submit = async (data: UnparsedEntityEditData) => {
    setError(undefined);
    try {
      const execution = await commands.submit({
        operation: "create",
        intent: "full",
        data: parseEntityEditCreateInput(entity, data),
      });
      if (execution.operation !== "create") {
        throw new Error(`${entity} create returned ${execution.operation}.`);
      }
      await navigate(entityDetailLink(entity, execution.id));
      return execution.result;
    } catch (cause) {
      setError(getErrorMessage(cause));
      throw cause;
    }
  };
  const cancel = () => navigate({ to: `/${entities[entity].basePath}` });

  if (entity === "product") {
    return (
      <ProductForm
        mode="create"
        isPending={commands.isPending}
        error={error}
        onCreate={(data) => void submit(data)}
        onCancel={cancel}
      />
    );
  }
  if (entity === "ingredient") {
    return (
      <IngredientForm
        mode="create"
        isPending={commands.isPending}
        error={error}
        onCreate={(data) => void submit(data)}
        onCancel={cancel}
      />
    );
  }
  return (
    <LocationForm
      mode="create"
      isPending={commands.isPending}
      error={error}
      onCreate={async (data) => locationOut.parse(await submit(data))}
      onCancel={cancel}
    />
  );
}
