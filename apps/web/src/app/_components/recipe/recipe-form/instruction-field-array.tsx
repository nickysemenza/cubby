import type { FC } from "react";
import { useFieldArray, type UseFormReturn } from "react-hook-form";
import { Button } from "~/components/ui/button";
import { Plus } from "lucide-react";
import { RequiredTextareaField } from "../../form-utils";
import type { RecipeFormValues } from "./types";
import { FieldArrayItemControls } from "./field-array-item-controls";

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
    <div className="w-full space-y-2">
      {fields.length === 0 ? (
        <div className="text-muted-foreground text-sm italic">
          No instructions added yet
        </div>
      ) : (
        <div className="space-y-2">
          {fields.map((field, instructionIndex) => (
            <div key={field.id} className="flex items-start space-x-1">
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
            </div>
          ))}
        </div>
      )}

      <div className="mt-2 flex justify-end">
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={() => append({ instruction: "" })}
        >
          <Plus className="mr-2 h-4 w-4" />
          Add Instruction
        </Button>
      </div>
    </div>
  );
};
