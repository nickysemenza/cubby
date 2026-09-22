import { getErrorMessage } from "@cubby/shared";
import { isEqual } from "es-toolkit";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { FieldValues, Path, UseFormReturn } from "react-hook-form";
import { useForm } from "react-hook-form";
import { z } from "zod";

import type { UnparsedError } from "~/lib/error-utils";

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
  EntityEditValue,
  EntityMutationPort,
  RuntimeEntityEditRequest,
} from "./types";
import { useEntityCommands } from "./use-entity-commands";
import { entityEditValueBagSchema } from "./value-schema";

type RuntimeEntityEditDraft = FieldValues;

export interface EntityEditSession<E extends EditableEntity> {
  /** Exposed so specialized form adapters can use RHF's native field helpers. */
  readonly form: UseFormReturn<RuntimeEntityEditDraft>;
  readonly access: EntityEditAccess | null;
  readonly isPending: boolean;
  readonly issues: readonly EntityEditIssue[];
  set(field: Path<RuntimeEntityEditDraft>, value: EntityEditValue): void;
  reset(): void;
  submit(): Promise<EntityEditResult<E>>;
}

export interface EntityEditSessionOptions {
  /** A browser-local command adapter for a surface whose remote transport is unavailable. */
  readonly mutationPort?: EntityMutationPort;
}

function isDraftField<T extends object>(
  values: T,
  field: string,
): field is Path<T> {
  return field in values;
}

const NO_ISSUES: readonly EntityEditIssue[] = [];

/**
 * A build or submit that *throws* (a create/update input schema rejecting a
 * value the kernel let through, an invariant failure) becomes issues rather
 * than an unhandled rejection the dialog's submit chain would swallow. Raw
 * diagnostics, per the product constraint: a Zod failure keeps every issue's
 * path so it lands beside its control, and the headline is the unmasked
 * message.
 */
function issuesFromThrown(error: UnparsedError): readonly EntityEditIssue[] {
  if (error instanceof z.ZodError) {
    return [
      { message: z.prettifyError(error), source: "client" },
      ...error.issues.map((issue): EntityEditIssue => ({
        field: issue.path.map(String).join("."),
        message: issue.message,
        source: "client",
      })),
    ];
  }
  return [{ message: getErrorMessage(error), source: "client" }];
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
  options?: EntityEditSessionOptions,
): EntityEditSession<E> {
  const stableRequest = useStableEntityEditRequest(request);
  const commands = useEntityCommands(stableRequest.entity, options);
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
  const [thrownIssues, setThrownIssues] =
    useState<readonly EntityEditIssue[]>(NO_ISSUES);
  const issues = !isResolvedEntityEdit(resolved)
    ? resolved.issues
    : thrownIssues.length > 0
      ? thrownIssues
      : commands.issues;

  const applyIssues = useCallback(
    (nextIssues: readonly EntityEditIssue[]) => {
      form.clearErrors();
      let focusRequested = false;
      for (const nextIssue of nextIssues) {
        const error = {
          type: nextIssue.source,
          message: nextIssue.message,
        };
        const values = form.getValues();
        if (nextIssue.field && isDraftField(values, nextIssue.field)) {
          form.setError(nextIssue.field, error, {
            shouldFocus: !focusRequested,
          });
          focusRequested = true;
        } else {
          form.setError("root.server", error);
        }
      }
    },
    [form],
  );
  const set = useCallback(
    (field: Path<RuntimeEntityEditDraft>, value: EntityEditValue) => {
      form.setValue(field, value, { shouldDirty: true });
    },
    [form],
  );
  const reset = useCallback(() => {
    setThrownIssues(NO_ISSUES);
    form.reset(initialValues);
  }, [form, initialValues]);
  const submit = useCallback(async (): Promise<EntityEditResult<E>> => {
    if (!isResolvedEntityEdit(resolved)) {
      applyIssues(resolved.issues);
      return { ok: false, issues: resolved.issues };
    }
    setThrownIssues(NO_ISSUES);
    let result: EntityEditResult<E>;
    try {
      const values = entityEditValueBagSchema.parse(form.getValues());
      result = await commands.commit(
        buildEntityEdit(resolved, stableRequest, values),
      );
    } catch (error) {
      const issues = issuesFromThrown(error);
      setThrownIssues(issues);
      result = { ok: false, issues };
    }
    if (!result.ok) applyIssues(result.issues);
    else form.clearErrors();
    return result;
  }, [applyIssues, commands, form, resolved, stableRequest]);

  return {
    form,
    access,
    isPending: commands.isPending,
    issues,
    set,
    reset,
    submit,
  };
}
