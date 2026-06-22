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
  // Cast required: useFieldArray expects ArrayPath<TFieldValues> but we accept any string
  // for flexibility. Consumers must pass valid array field names.
  const { fields, append, remove } = useFieldArray({
    control: form.control,
    name: name as Parameters<typeof useFieldArray<TFieldValues>>["0"]["name"],
  });

  const handleAdd = () => {
    if (maxItems && fields.length >= maxItems) return;
    // Cast required: append expects the exact array element type which varies per form
    append(emptyValue as Parameters<typeof append>[0]);
  };

  const handleRemove = (index: number) => {
    remove(index);
  };

  const canAdd = !maxItems || fields.length < maxItems;

  return (
    <div className={cn("space-y-1.5", className)}>
      <div className="flex items-center justify-between">
        <h3 className={cn("eyebrow my-0 font-medium", titleClassName)}>
          {title}
        </h3>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="border-[1.5px] border-border border-dashed"
          onClick={handleAdd}
          disabled={!canAdd}
        >
          <Plus className="mr-1.5 h-3.5 w-3.5" />
          {addButtonText}
        </Button>
      </div>

      {fields.length === 0 && (
        <div className="text-muted-foreground text-sm italic">
          No {title.toLowerCase()} added yet
        </div>
      )}

      {/* Ledger rows: dashed rules between entries instead of boxed cards */}
      <div className="divide-y divide-dashed divide-border">
        {fields.map((field, index) => (
          <div
            key={field.id}
            className={cn(
              "flex flex-wrap items-end gap-2 py-1.5",
              itemClassName,
            )}
          >
            {children(field as T, index, handleRemove)}
            {showRemoveButton && (
              <Button
                type="button"
                variant="ghost"
                size="icon-sm"
                className="mb-0.5"
                aria-label={`Remove ${title.slice(0, -1).toLowerCase()} ${index + 1}`}
                onClick={() => handleRemove(index)}
              >
                <X className="h-3.5 w-3.5" />
              </Button>
            )}
          </div>
        ))}
      </div>
    </div>
  );
};
