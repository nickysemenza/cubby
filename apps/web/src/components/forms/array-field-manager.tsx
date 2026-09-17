import { Plus, X } from "lucide-react";
import type * as React from "react";
import { type Control, type FieldValues, useFieldArray } from "react-hook-form";

import { Button } from "~/components/ui/button";
import { cn } from "~/lib/utils";

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
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="border-[1.5px] border-dashed border-border"
          onClick={handleAdd}
          disabled={!canAdd}
        >
          <Plus className="mr-2 size-3.5" />
          {addButtonText}
        </Button>
      </div>

      {fields.length === 0 && (
        <div className="text-sm text-muted-foreground italic">
          No {title.toLowerCase()} added yet
        </div>
      )}

      {/* Ledger rows: dashed rules between entries instead of boxed cards */}
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
                <X className="size-3.5" />
              </Button>
            )}
          </div>
        ))}
      </div>
    </div>
  );
};
