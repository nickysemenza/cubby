import { PlusIcon } from "@phosphor-icons/react/dist/csr/Plus";
import { XIcon } from "@phosphor-icons/react/dist/csr/X";
import type * as React from "react";
import { type Control, type FieldValues, useFieldArray } from "react-hook-form";

import { Button } from "~/components/ui/button";
import { cn } from "~/lib/utils";

import { FormSection } from "./form-section";

/**
 * Generic array field manager for react-hook-form.
 *
 * Note on typing: This component uses `as unknown` casts for react-hook-form interop.
 * react-hook-form's useFieldArray expects ArrayPath<TFieldValues> which requires
 * compile-time verification that `name` maps to an array field. Since this is a
 * generic reusable component, we can't enforce that constraint at the type level
 * without losing flexibility. The runtime behavior is correct - consumers are
 * responsible for passing valid array field names.
 */
interface ArrayFieldManagerProps<
  T,
  TFieldValues extends FieldValues = FieldValues,
> {
  form: {
    control: Control<TFieldValues>;
  };
  name: string;
  title: string;
  addButtonText: string;
  emptyValue: T;
  children: (
    item: T,
    index: number,
    remove: (index: number) => void,
  ) => React.ReactNode;
  className?: string;
  titleClassName?: string;
  itemClassName?: string;
  showRemoveButton?: boolean;
  maxItems?: number;
  /**
   * Tabular mode: one header row of the given column labels above the
   * unlabeled row controls (`children` still owns each row's actual
   * fields), and the title + "+ Add" button move into `FormSection`'s own
   * header slot instead of this component's plain title row. `className`
   * on a column aligns its header label with the matching row control's own
   * width class; omit it to fall back to `flex-1`, matching a row control
   * with no explicit width of its own.
   */
  columns?: readonly { label: string; className?: string }[];
}

/** 28px, no dashed border — the shared "+ Add" affordance for every array
 * field, tabular or not (DESIGN.md: ghost buttons are quiet at rest). */
function AddRowButton({
  addButtonText,
  onClick,
  disabled,
}: {
  addButtonText: string;
  onClick: () => void;
  disabled: boolean;
}) {
  return (
    <Button
      type="button"
      variant="ghost"
      size="sm"
      onClick={onClick}
      disabled={disabled}
    >
      <PlusIcon className="mr-2 size-3.5" />
      {addButtonText}
    </Button>
  );
}

export const ArrayFieldManager = <
  T,
  TFieldValues extends FieldValues = FieldValues,
>({
  form,
  name,
  title,
  addButtonText,
  emptyValue,
  children,
  className,
  titleClassName,
  itemClassName,
  showRemoveButton = true,
  maxItems,
  columns,
}: ArrayFieldManagerProps<T, TFieldValues>) => {
  const { fields, append, remove } = useFieldArray({
    control: form.control,
    // SAFETY: each caller supplies the name of an array field in its
    // TFieldValues; the reusable component keeps that path open because form
    // schemas vary.
    name: name as Parameters<typeof useFieldArray<TFieldValues>>["0"]["name"],
  });

  const handleAdd = () => {
    if (maxItems && fields.length >= maxItems) return;
    // SAFETY: emptyValue is the exact element contract for the caller's named
    // array field, even though the generic field path is intentionally open.
    append(emptyValue as Parameters<typeof append>[0]);
  };

  const handleRemove = (index: number) => {
    remove(index);
  };

  const renderField = (field: (typeof fields)[number], index: number) => {
    // SAFETY: useFieldArray fields preserve the caller-declared row shape and
    // only add its bookkeeping id.
    return children(field as T, index, handleRemove);
  };

  const canAdd = !maxItems || fields.length < maxItems;
  const emptyLabel = (
    <div className="text-sm text-muted-foreground italic">
      No {title.toLowerCase()} added yet
    </div>
  );

  // Ledger rows: dashed rules between entries instead of boxed cards.
  const rows = (
    <div className="divide-y divide-dashed divide-border">
      {fields.map((field, index) => (
        <div
          key={field.id}
          className={cn("flex flex-wrap items-end gap-2 py-2", itemClassName)}
        >
          {renderField(field, index)}
          {showRemoveButton && (
            <Button
              type="button"
              variant="ghost"
              size="icon-sm"
              className="mb-1"
              aria-label={`Remove ${title.slice(0, -1).toLowerCase()} ${index + 1}`}
              onClick={() => handleRemove(index)}
            >
              <XIcon className="size-3.5" />
            </Button>
          )}
        </div>
      ))}
    </div>
  );

  if (columns) {
    return (
      <FormSection
        title={title}
        action={
          <AddRowButton
            addButtonText={addButtonText}
            onClick={handleAdd}
            disabled={!canAdd}
          />
        }
      >
        <div className={cn("space-y-2", className)}>
          {fields.length === 0 ? (
            emptyLabel
          ) : (
            <div className="flex flex-wrap gap-2 text-xs font-medium text-muted-foreground">
              {columns.map((column) => (
                <span
                  key={column.label}
                  className={column.className ?? "flex-1"}
                >
                  {column.label}
                </span>
              ))}
              {/* Reserves the trailing ✕ column's width so labels line up
                  with their row controls, not the remove button. */}
              {showRemoveButton && <span className="w-9" aria-hidden />}
            </div>
          )}
          {rows}
        </div>
      </FormSection>
    );
  }

  return (
    <div className={cn("space-y-2", className)}>
      <div className="flex items-center justify-between">
        <h3
          className={cn(
            "my-0 text-xs font-medium text-muted-foreground",
            titleClassName,
          )}
        >
          {title}
        </h3>
        <AddRowButton
          addButtonText={addButtonText}
          onClick={handleAdd}
          disabled={!canAdd}
        />
      </div>
      {fields.length === 0 && emptyLabel}
      {rows}
    </div>
  );
};
