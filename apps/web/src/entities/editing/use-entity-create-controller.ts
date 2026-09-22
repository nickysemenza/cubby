import { useNavigate } from "@tanstack/react-router";
import { useState } from "react";

import { entities, entityDetailLink } from "~/entities/entities";
import { getErrorMessage } from "~/lib/error-utils";

import type { EntityEditResultFor } from "./intent-types";
import type { EditableEntity, EntityEditMutationData } from "./types";
import { useEntityCommands } from "./use-entity-commands";

/** Surface lifecycle adapter for rich create forms that own specialized RHF
 * state. The form supplies one domain payload; commands own the write. */
export function useEntityCreateController<
  E extends EditableEntity,
  TData extends EntityEditMutationData<E, "create">,
>(
  entity: E,
  callbacks?: {
    onSuccess?: (result: EntityEditResultFor<E>) => void;
    onError?: () => void;
  },
) {
  const navigate = useNavigate();
  const commands = useEntityCommands(entity);
  const [error, setError] = useState<string>();
  const submitAsync = async (data: TData) => {
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
      callbacks?.onSuccess?.(result);
      await navigate(entityDetailLink(entity, result.id));
      return result;
    } catch (cause) {
      setError(getErrorMessage(cause));
      callbacks?.onError?.();
      throw cause;
    }
  };
  return {
    error,
    isPending: commands.isPending,
    // SILENT: `submitAsync` stores the failure in `error` above before
    // rethrowing; `submit` is the fire-and-forget form of the same call.
    submit: (data: TData) => void submitAsync(data).catch(() => undefined),
    submitAsync,
    cancel: () => navigate({ to: `/${entities[entity].basePath}` }),
  };
}
