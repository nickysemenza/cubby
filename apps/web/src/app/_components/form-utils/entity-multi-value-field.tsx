import { X } from "lucide-react";
import type { ReactNode } from "react";
import {
  Controller,
  type FieldValues,
  type Path,
  type PathValue,
  type UseFormReturn,
} from "react-hook-form";
import { z } from "zod";

import { Row } from "~/components/layout";
import { Badge } from "~/components/ui/badge";
import { Button } from "~/components/ui/button";
import { preserveSelectedPickerItems } from "~/entities/editing/reference-scope";

import type { ComboboxItem, PickerEntity } from "../combobox/combobox-types";
import { EntityPicker } from "../combobox/entity-picker";
import type { EntitySearchScope } from "../combobox/entity-search-hooks";
import type { WithEntitySearchProps } from "../combobox/with-search-hook";
import { FormFieldGroup } from "../forms/form-field-group";

const idList = z.array(z.string()).catch([]);

/**
 * React Hook Form adapter for a multi-reference field whose persisted value
 * is the full id set (`blockedByIds`, `candidateProductIds`): removable
 * chips for the current set plus the shared entity picker to add one. Names
 * are known only for ids the search has returned; the rest read as their
 * shortcode.
 */
export function EntityMultiValueField<
  TFieldValues extends FieldValues,
  E extends PickerEntity,
>({
  form,
  name,
  entity,
  label,
  SearchProvider,
  scope,
}: {
  form: UseFormReturn<TFieldValues>;
  name: Path<TFieldValues>;
  entity: E;
  label: string;
  SearchProvider: (props: WithEntitySearchProps<string>) => ReactNode;
  /** Dependent-field filters for the candidate picker; null keeps it scoped but idle. */
  scope?: EntitySearchScope | null;
}) {
  return (
    <SearchProvider scope={scope}>
      {({ items, onSearchChange, isLoading, onOpenChange }) => (
        <Controller
          control={form.control}
          name={name}
          render={({ field, fieldState }) => {
            const ids = idList.parse(field.value);
            const selectedItems = preserveSelectedPickerItems(items, ids);
            const commit = (next: string[]) =>
              field.onChange(
                // SAFETY: `name` is a caller-owned Path whose value is the
                // selected id list; RHF cannot derive that from this
                // generic form type.
                next as PathValue<TFieldValues, Path<TFieldValues>>,
              );
            return (
              <FormFieldGroup
                htmlFor={name}
                label={label}
                invalid={fieldState.invalid}
                error={fieldState.error}
              >
                {ids.length > 0 && (
                  <Row wrap gap="xs" className="mb-1">
                    {selectedItems.map((item) => (
                      <Badge key={item.id} variant="outline">
                        {item.name}
                        <Button
                          type="button"
                          variant="ghost"
                          size="sm"
                          aria-label={`Remove ${item.name}`}
                          onClick={() =>
                            commit(
                              ids.filter((candidate) => candidate !== item.id),
                            )
                          }
                        >
                          <X />
                        </Button>
                      </Badge>
                    ))}
                  </Row>
                )}
                <EntityPicker
                  entity={entity}
                  label={label}
                  items={items.filter((item) => !ids.includes(item.id))}
                  value={null}
                  setValue={(item: ComboboxItem<string> | null) => {
                    if (item && !ids.includes(item.id))
                      commit([...ids, item.id]);
                  }}
                  onSearchChange={onSearchChange}
                  isLoading={isLoading}
                  onOpenChange={onOpenChange}
                />
              </FormFieldGroup>
            );
          }}
        />
      )}
    </SearchProvider>
  );
}
