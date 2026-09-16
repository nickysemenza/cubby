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

import type { ComboboxItem, PickerEntity } from "../combobox/combobox-types";
import { EntityPicker } from "../combobox/entity-picker";
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
}: {
  form: UseFormReturn<TFieldValues>;
  name: Path<TFieldValues>;
  entity: E;
  label: string;
  SearchProvider: (props: WithEntitySearchProps<string>) => ReactNode;
}) {
  return (
    <SearchProvider>
      {({ items, onSearchChange, isLoading, onOpenChange }) => (
        <Controller
          control={form.control}
          name={name}
          render={({ field, fieldState }) => {
            const ids = idList.parse(field.value);
            const commit = (next: string[]) =>
              field.onChange(
                // SAFETY: `name` is a caller-owned Path whose value is the
                // selected id list; RHF cannot derive that from this
                // generic form type.
                next as PathValue<TFieldValues, Path<TFieldValues>>,
              );
            const nameOf = (id: string) =>
              items.find((item) => item.id === id)?.name ?? id;
            return (
              <FormFieldGroup
                htmlFor={name}
                label={label}
                invalid={fieldState.invalid}
                error={fieldState.error}
              >
                {ids.length > 0 && (
                  <Row wrap gap="xs" className="mb-1">
                    {ids.map((id) => (
                      <Badge key={id} variant="outline">
                        {nameOf(id)}
                        <Button
                          type="button"
                          variant="ghost"
                          size="sm"
                          aria-label={`Remove ${nameOf(id)}`}
                          onClick={() =>
                            commit(ids.filter((candidate) => candidate !== id))
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
