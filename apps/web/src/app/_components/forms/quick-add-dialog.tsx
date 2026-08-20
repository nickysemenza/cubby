import { zodResolver } from "@hookform/resolvers/zod";
import type { QueryKey } from "@tanstack/react-query";
import { type ReactNode, useCallback, useEffect, useState } from "react";
import {
  type DefaultValues,
  type FieldValues,
  type UseFormReturn,
  useForm,
} from "react-hook-form";
import { toast } from "sonner";
import type { z } from "zod";
import {
  type DataOf,
  type MutationOptionsFn,
  useActionMutation,
  type VariablesOf,
} from "~/app/_components/hooks/useActionMutation";
import { ResponsiveDialog } from "~/components/ui/responsive-dialog";
import type { EditableEntity } from "~/entities/editing";
import { useEntityCommands } from "~/entities/editing";
import { getErrorMessage } from "~/lib/error-utils";
import { FormWrapper } from "../form-utils";

/**
 * Shared shell for a "quick add" entity dialog — the shape every
 * create-task/expense/project dialog needs: a `useForm` + `zodResolver`
 * around a small local schema, a single create mutation via
 * {@link useActionMutation}, and a Dialog > FormWrapper body that resets and
 * closes on success. Entity-specific bits (fields, defaults, payload mapping,
 * copy) stay in the caller; this only collapses the boilerplate shell.
 *
 * **`schema` constraint:** must have no transforms/refinements that change the
 * shape and no branded fields (Output must equal Input) — branding (e.g.
 * `unsafeProjectId`) happens exactly once, in `buildPayload`, at the
 * tRPC-call boundary. Branding in the schema itself fights `zodResolver`'s
 * input/output generic (the resolver's Input type ends up mismatched against
 * `useForm`'s form-values type).
 */
export function QuickAddDialog<
  TFieldValues extends FieldValues,
  TFn extends MutationOptionsFn,
>({
  open,
  onOpenChange,
  schema,
  defaultValues,
  title,
  description,
  entity,
  operation = "create",
  intent = "capture",
  specialized = false,
  mutationFn,
  successMessage,
  invalidateKeys,
  buildPayload,
  submitButtonText = "Create",
  children,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** The form's zod schema — see the no-transform/no-brand constraint above. */
  schema: z.ZodType<TFieldValues, TFieldValues>;
  /**
   * Initial form values. Pass a thunk (not a value) when a default needs to be
   * re-evaluated each time the dialog opens/resets — e.g. an expense's date
   * defaulting to "today".
   */
  defaultValues: TFieldValues | (() => TFieldValues);
  title: ReactNode;
  description: ReactNode;
  /** Registry entity whose command lifecycle owns this dialog's final write. */
  entity: EditableEntity;
  operation?: "create" | "update";
  intent?: string;
  /** Keep non-CRUD transactional commands on their specialized mutation. */
  specialized?: boolean;
  /** A tRPC `*.create.mutationOptions` reference. */
  mutationFn: TFn;
  /** Success toast — a fixed message or one derived from the created entity. */
  successMessage: ReactNode | ((data: DataOf<TFn>) => ReactNode);
  /** Entity lists to invalidate on success (forwarded to `useActionMutation`). */
  invalidateKeys: readonly QueryKey[];
  /** Map validated form values to the mutation's input (branding happens here). */
  buildPayload: (values: TFieldValues) => VariablesOf<TFn>;
  submitButtonText?: string;
  children: (form: UseFormReturn<TFieldValues>) => ReactNode;
}) {
  const commands = useEntityCommands(entity);
  const [error, setError] = useState<string>();
  // These compatibility props still anchor the exact tRPC variable/result
  // types. Execution and invalidation are centralized by entity commands.
  const specializedMutation = useActionMutation({
    mutationFn,
    invalidateKeys,
  });
  const resolveDefaults = useCallback(
    (): TFieldValues =>
      typeof defaultValues === "function"
        ? (defaultValues as () => TFieldValues)()
        : defaultValues,
    [defaultValues],
  );

  const form = useForm<TFieldValues>({
    resolver: zodResolver(schema),
    // react-hook-form's `DefaultValues<T>` is a `DeepPartial<T>` mapped type
    // that doesn't resolve cleanly against a generic (unresolved) `T` — the
    // values themselves are already a complete, validated `TFieldValues`.
    defaultValues: resolveDefaults() as DefaultValues<TFieldValues>,
  });
  useEffect(() => {
    if (open) {
      form.reset(resolveDefaults());
      setError(undefined);
    }
  }, [form, open, resolveDefaults]);

  const onSubmit = async (values: TFieldValues) => {
    setError(undefined);
    try {
      const payload = buildPayload(values) as object;
      const updatePayload = payload as { id?: string; data?: object };
      const result = specialized
        ? await specializedMutation.mutateAsync(payload as VariablesOf<TFn>)
        : ((
            await commands.executeOrThrow({
              entity,
              operation,
              intent,
              ...(operation === "update" ? { id: updatePayload.id } : {}),
              data:
                operation === "update" ? (updatePayload.data ?? {}) : payload,
            })
          ).result as DataOf<TFn>);
      toast.success(
        typeof successMessage === "function"
          ? successMessage(result)
          : successMessage,
      );
      form.reset(resolveDefaults());
      onOpenChange(false);
    } catch (cause) {
      const message = getErrorMessage(cause);
      setError(message);
      if (!specialized) toast.error(message);
    }
  };

  return (
    <ResponsiveDialog
      open={open}
      onOpenChange={(next) => {
        if (!next) {
          form.reset(resolveDefaults());
          setError(undefined);
        }
        onOpenChange(next);
      }}
      title={title}
      description={description}
    >
      <FormWrapper<TFieldValues>
        form={form}
        onSubmit={(values) => void onSubmit(values)}
        isPending={
          specialized ? specializedMutation.isPending : commands.isPending
        }
        error={error}
        onCancel={() => onOpenChange(false)}
        submitButtonText={submitButtonText}
      >
        {children(form)}
      </FormWrapper>
    </ResponsiveDialog>
  );
}
