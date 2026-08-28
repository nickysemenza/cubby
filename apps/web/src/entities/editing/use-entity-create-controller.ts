import { useNavigate } from "@tanstack/react-router";
import { useState } from "react";

import { entities, entityDetailLink } from "~/entities/entities";
import { getErrorMessage } from "~/lib/error-utils";

import type { EditableEntity } from "./types";
import { useEntityCommands } from "./use-entity-commands";

/** Surface lifecycle adapter for rich create forms that own specialized RHF
 * state. The form supplies one domain payload; commands own the write. */
export function useEntityCreateController<
  E extends EditableEntity,
  TData extends object,
  TResult extends { id: string },
>(
  entity: E,
  callbacks?: {
    onSuccess?: (result: TResult) => void;
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
      const result = execution.result as TResult;
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
    submit: (data: TData) => void submitAsync(data).catch(() => undefined),
    submitAsync,
    cancel: () => navigate({ to: `/${entities[entity].basePath}` }),
  };
}
