import {
  type CookbookShortcode,
  cookbookShortcode,
} from "@cubby/schemas/identifiers";
import { useQuery } from "@tanstack/react-query";
import { useId, useMemo } from "react";

import { cookbook } from "~/integrations/tanstack-query/generated/catalog.gen";
import { Picker } from "~/ui/combobox/picker";
import type { PickerOption } from "~/ui/combobox/picker-option";
import { Row } from "~/ui/layout";
import { Image } from "~/ui/primitives/image";

/**
 * The Cookbook list as picker options, led by an empty-value option
 * (`value: ""`) named `emptyLabel`. Each row carries the cookbook's cover.
 */
export function useCookbookOptions(): PickerOption[] {
  const { data: cookbooks } = useQuery(cookbook.list.queryOptions(null));
  return useMemo(
    () =>
      (cookbooks ?? []).map((book): PickerOption => {
        const cover = book.displayImages[0]?.url;
        return {
          value: book.id,
          label: book.name,
          ...(cover && {
            icon: (
              <Image
                src={cover}
                alt=""
                displayWidth={20}
                className="size-5 rounded-[3px] object-cover"
              />
            ),
          }),
        };
      }),
    [cookbooks],
  );
}

interface CookbookSelectProps {
  value: CookbookShortcode | undefined;
  onChange: (id: CookbookShortcode | undefined) => void;
}

/**
 * "Cookbook" scope filter: a labeled picker over the Cookbook list with an
 * "All cookbooks" empty option. Owns the query and the string →
 * CookbookShortcode boundary parse so callers deal only in branded ids.
 */
export function CookbookSelect({ value, onChange }: CookbookSelectProps) {
  const inputId = useId();
  const books = useCookbookOptions();
  const options = useMemo(
    () => [{ value: "", label: "All cookbooks" }, ...books],
    [books],
  );

  return (
    <Row align="center" gap="sm" className="w-fit text-sm">
      <label htmlFor={inputId} className="text-muted-foreground">
        Cookbook
      </label>
      <Picker
        inputId={inputId}
        label="Cookbook"
        className="w-48"
        options={options}
        value={value ?? ""}
        onValueChange={(next) =>
          onChange(next ? cookbookShortcode.parse(next) : undefined)
        }
      />
    </Row>
  );
}
