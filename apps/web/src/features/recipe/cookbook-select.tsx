import type { CookbookShortcode } from "@cubby/schemas/identifiers";
import { useId } from "react";

import { EntityReferencePicker } from "~/entity/picker/entity-reference-picker";
import { Row } from "~/ui/layout";

interface CookbookSelectProps {
  value: CookbookShortcode | undefined;
  onChange: (id: CookbookShortcode | undefined) => void;
}

/**
 * "Cookbook" scope filter: a labeled Cookbook record picker whose cleared
 * state is "All cookbooks". Callers deal only in branded ids.
 */
export function CookbookSelect({ value, onChange }: CookbookSelectProps) {
  const inputId = useId();
  return (
    <Row align="center" gap="sm" className="w-fit text-sm">
      <label htmlFor={inputId} className="text-muted-foreground">
        Cookbook
      </label>
      <EntityReferencePicker
        entity="cookbook"
        inputId={inputId}
        label="Cookbook"
        className="w-48"
        placeholder="All cookbooks"
        clearable
        value={value ? { id: value, name: value } : null}
        setValue={(item) => onChange(item?.id)}
      />
    </Row>
  );
}
