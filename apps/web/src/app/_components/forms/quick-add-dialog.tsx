import { zodResolver } from "@hookform/resolvers/zod";
import type { QueryKey } from "@tanstack/react-query";
import type { ReactNode } from "react";
import {
  type DefaultValues,
  type FieldValues,
  type UseFormReturn,
  useForm,
} from "react-hook-form";
import type { z } from "zod";
import {
  type DataOf,
  type MutationOptionsFn,
  useActionMutation,
  type VariablesOf,
} from "~/app/_components/hooks/useActionMutation";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "~/components/ui/dialog";
import { FormWrapper } from "../form-utils";

/**
 * Shared shell for a "quick add" entity dialog — the shape every
 * create-task/purchase/project dialog needs: a `useForm` + `zodResolver`
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
   * re-evaluated each time the dialog opens/resets — e.g. a purchase's date
   * defaulting to "today".
   */
  defaultValues: TFieldValues | (() => TFieldValues);
  title: ReactNode;
  description: ReactNode;
  /** A tRPC `*.create.mutationOptions` reference. */
  mutationFn: TFn;
  /** Success toast — a fixed message or one derived from the created entity. */
  successMessage: ReactNode | ((data: DataOf<TFn>) => ReactNode);
  /** Entity lists to invalidate on success (forwarded to `useActionMutation`). */
  invalidateKeys: readonly QueryKey[];
  /** Map validated form values to the mutation's input (branding happens here). */
  buildPayload: (values: TFieldValues) => VariablesOf<TFn>;
  submitButtonText?: string;
  /** Render the form fields; receives the `useForm` instance for `Controller`-based fields. */
  children: (form: UseFormReturn<TFieldValues>) => ReactNode;
}) {
  const resolveDefaults = (): TFieldValues =>
    typeof defaultValues === "function"
      ? (defaultValues as () => TFieldValues)()
      : defaultValues;

  const form = useForm<TFieldValues>({
    resolver: zodResolver(schema),
    // react-hook-form's `DefaultValues<T>` is a `DeepPartial<T>` mapped type
    // that doesn't resolve cleanly against a generic (unresolved) `T` — the
    // values themselves are already a complete, validated `TFieldValues`.
    defaultValues: resolveDefaults() as DefaultValues<TFieldValues>,
  });

  const createMutation = useActionMutation({
    mutationFn,
    success: successMessage,
    invalidateKeys,
    onSuccess: () => {
      form.reset(resolveDefaults());
      onOpenChange(false);
    },
  });

  const onSubmit = (values: TFieldValues) => {
    createMutation.mutate(buildPayload(values));
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) form.reset(resolveDefaults());
        onOpenChange(next);
      }}
    >
      <DialogContent size="sm">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>{description}</DialogDescription>
        </DialogHeader>
        <FormWrapper<TFieldValues>
          form={form}
          onSubmit={onSubmit}
          isPending={createMutation.isPending}
          error={
            createMutation.error ? createMutation.error.message : undefined
          }
          onCancel={() => onOpenChange(false)}
          submitButtonText={submitButtonText}
        >
          {children(form)}
        </FormWrapper>
      </DialogContent>
    </Dialog>
  );
}
