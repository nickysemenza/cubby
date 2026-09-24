import { PlusIcon } from "@phosphor-icons/react/dist/csr/Plus";
import type { FC } from "react";
import { type UseFormReturn, useFieldArray } from "react-hook-form";

import { Row, Stack } from "~/components/layout";
import { Button } from "~/components/ui/button";

import { RequiredTextareaField } from "../../form-utils";
import { FieldArrayItemControls } from "./field-array-item-controls";
import type { RecipeFormValues } from "./types";

interface InstructionFieldArrayProps {
  form: UseFormReturn<RecipeFormValues>;
  sectionIndex: number;
}

export const InstructionFieldArray: FC<InstructionFieldArrayProps> = ({
  form,
  sectionIndex,
}) => {
  const { fields, append, remove, move } = useFieldArray({
    control: form.control,
    name: `sections.${sectionIndex}.instructions`,
  });

  return (
    <Stack gap="sm" className="w-full">
      {fields.length === 0 ? (
        <div className="text-sm text-muted-foreground italic">
          No instructions added yet
        </div>
      ) : (
        <Stack gap="sm">
          {fields.map((field, instructionIndex) => (
            <Row key={field.id} align="start" gap="xs">
              <div className="flex-grow">
                <RequiredTextareaField
                  form={form}
                  name={`sections.${sectionIndex}.instructions.${instructionIndex}.instruction`}
                  label={`Step ${instructionIndex + 1}`}
                  placeholder="Enter instruction step"
                  rows={2}
                />
              </div>
              <FieldArrayItemControls
                move={move}
                remove={remove}
                index={instructionIndex}
                fieldsLength={fields.length}
              />
            </Row>
          ))}
        </Stack>
      )}

      <Row justify="end" className="mt-2">
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={() => append({ instruction: "" })}
        >
          <PlusIcon className="mr-2 size-4" />
          Add Instruction
        </Button>
      </Row>
    </Stack>
  );
};
