import * as React from "react";
import { useFieldArray, type FieldValues, type Control } from "react-hook-form";
import { Button } from "~/components/ui/button";
import { Plus, X } from "lucide-react";
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
export interface ArrayFieldManagerProps<
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
    <div className={cn("space-y-4", className)}>
      <div className="flex items-center justify-between">
        <h3 className="text-lg font-medium">{title}</h3>
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={handleAdd}
          disabled={!canAdd}
        >
          <Plus className="mr-2 h-4 w-4" />
          {addButtonText}
        </Button>
      </div>

      {fields.length === 0 && (
        <div className="text-muted-foreground text-sm">
          No {title.toLowerCase()} added yet
        </div>
      )}

      {fields.map((field, index) => (
        <div
          key={field.id}
          className={cn("space-y-4 rounded-lg border p-4", itemClassName)}
        >
          <div className="flex items-start justify-between">
            <h4 className="font-medium">
              {title.slice(0, -1)} {index + 1}
            </h4>
            {showRemoveButton && (
              <Button
                type="button"
                variant="ghost"
                size="sm"
                onClick={() => handleRemove(index)}
              >
                <X className="h-4 w-4" />
              </Button>
            )}
          </div>
          {children(field as T, index, handleRemove)}
        </div>
      ))}
    </div>
  );
};
