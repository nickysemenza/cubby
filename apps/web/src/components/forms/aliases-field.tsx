import { type Control, Controller, type FieldValues } from "react-hook-form";
import { Input } from "~/components/ui/input";
import { ArrayFieldManager } from "./array-field-manager";

/**
 * The shared editor for a plain `string[]` form field: a labeled, add/remove
 * list. Extracted from the ingredient form so ingredients, products, and
 * locations all edit their `aliases` column through one control (all three are
 * searched + embedded on those aliases). The labels default to "Aliases" for
 * those callers; `product.tags` reuses it with its own.
 *
 * Callers are responsible for stripping blank entries before submit — see
 * `filterAliases`.
 */
export function AliasesField<TFieldValues extends FieldValues>({
  form,
  name = "aliases",
  placeholder = "Alias name",
  title = "Aliases",
  addButtonText = "Add Alias",
}: {
  form: { control: Control<TFieldValues> };
  /** Form path holding the `string[]`. Defaults to `aliases`. */
  name?: string;
  placeholder?: string;
  title?: string;
  addButtonText?: string;
}) {
  return (
    <ArrayFieldManager<string, TFieldValues>
      form={form}
      name={name}
      title={title}
      addButtonText={addButtonText}
      emptyValue=""
    >
      {(_field, index) => (
        <Controller
          control={form.control}
          // Cast: the row path is built from a caller-supplied `name`, so it
          // can't be verified against TFieldValues at compile time (same
          // constraint ArrayFieldManager documents).
          name={
            `${name}.${index}` as Parameters<
              typeof Controller<TFieldValues>
            >[0]["name"]
          }
          render={({ field: controllerField }) => (
            <Input
              {...controllerField}
              value={(controllerField.value as string | undefined) ?? ""}
              placeholder={placeholder}
              className="flex-1"
            />
          )}
        />
      )}
    </ArrayFieldManager>
  );
}

/** Drop blank/whitespace-only aliases before they hit the API. */
export const filterAliases = (aliases: string[]): string[] =>
  aliases.filter((alias) => alias.trim() !== "");
