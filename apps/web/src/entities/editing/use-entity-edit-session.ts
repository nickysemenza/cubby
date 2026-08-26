import { isEqual } from "es-toolkit";
import { useCallback, useEffect, useMemo, useRef } from "react";
import type { Path, UseFormReturn } from "react-hook-form";
import { useForm, useWatch } from "react-hook-form";
import { entityEditRegistry } from "./definitions";
import {
  buildEntityEdit,
  initialEntityEditValues,
  isResolvedEntityEdit,
  resolveEntityEdit,
} from "./kernel";
import type {
  EditableEntity,
  EntityEditAccess,
  EntityEditIssue,
  EntityEditResult,
  RuntimeEntityEditRequest,
} from "./types";
import { useEntityCommands } from "./use-entity-commands";

type RuntimeEntityEditDraft = Record<string, unknown>;

export interface EntityEditSession<E extends EditableEntity> {
  /** Exposed so specialized form adapters can use RHF's native field helpers. */
  readonly form: UseFormReturn<RuntimeEntityEditDraft>;
  readonly values: Readonly<RuntimeEntityEditDraft>;
  readonly access: EntityEditAccess | null;
  readonly isPending: boolean;
  readonly issues: readonly EntityEditIssue[];
  set(field: Path<RuntimeEntityEditDraft>, value: unknown): void;
  reset(): void;
  submit(): Promise<EntityEditResult<E>>;
}

function isDraftField<T extends object>(
  values: T,
  field: string,
): field is Path<T> {
  return field in values;
}

/**
 * Hosts commonly construct a request inline. Preserve an in-progress draft
 * across referentially-new but structurally-identical request objects, while a
 * record, seed, context, intent, or surface change still resets deliberately.
 */
function useStableEntityEditRequest<E extends EditableEntity>(
  request: RuntimeEntityEditRequest<E>,
): RuntimeEntityEditRequest<E> {
  const last = useRef(request);
  if (!isEqual(last.current, request)) last.current = request;
  return last.current;
}

/**
 * Form-state adapter over the declarative editing kernel. It has no UI opinion:
 * page forms, sheets, dialogs, and previews choose their own presentation.
 */
export function useEntityEditSession<E extends EditableEntity>(
  request: RuntimeEntityEditRequest<E>,
): EntityEditSession<E> {
  const stableRequest = useStableEntityEditRequest(request);
  const commands = useEntityCommands(stableRequest.entity);
  const resolved = useMemo(
    () => resolveEntityEdit(entityEditRegistry, stableRequest),
    [stableRequest],
  );
  const initialValues = useMemo(
    () =>
      isResolvedEntityEdit(resolved)
        ? initialEntityEditValues(resolved, stableRequest)
        : {},
    [stableRequest, resolved],
  );
  const form = useForm<RuntimeEntityEditDraft>({
    defaultValues: initialValues,
  });
  useWatch({ control: form.control });
  const values = form.getValues();

  useEffect(() => {
    form.reset(initialValues);
  }, [form, initialValues]);

  const access = isResolvedEntityEdit(resolved)
    ? resolved.intentDefinition.access({
        surface: stableRequest.surface,
        record: stableRequest.record,
        context: resolved.context,
      })
    : null;
  const issues = isResolvedEntityEdit(resolved)
    ? commands.issues
    : resolved.issues;

  const applyIssues = useCallback(
    (nextIssues: readonly EntityEditIssue[]) => {
      form.clearErrors();
      for (const nextIssue of nextIssues) {
        const error = {
          type: nextIssue.source,
          message: nextIssue.message,
        };
        const values = form.getValues();
        if (nextIssue.field && isDraftField(values, nextIssue.field)) {
          form.setError(nextIssue.field, error);
        } else {
          form.setError("root.server", error);
        }
      }
    },
    [form],
  );
  const set = useCallback(
    (field: Path<RuntimeEntityEditDraft>, value: unknown) => {
      form.setValue(field, value, { shouldDirty: true });
    },
    [form],
  );
  const reset = useCallback(
    () => form.reset(initialValues),
    [form, initialValues],
  );
  const submit = useCallback(async (): Promise<EntityEditResult<E>> => {
    if (!isResolvedEntityEdit(resolved)) {
      applyIssues(resolved.issues);
      return { ok: false, issues: resolved.issues };
    }
    const result = await commands.commit(
      buildEntityEdit(resolved, stableRequest, form.getValues()),
    );
    if (!result.ok) applyIssues(result.issues);
    else form.clearErrors();
    return result;
  }, [applyIssues, commands, form, resolved, stableRequest]);

  return {
    form,
    values,
    access,
    isPending: commands.isPending,
    issues,
    set,
    reset,
    submit,
  };
}
