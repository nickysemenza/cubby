import { type FC } from "react";
import { useFieldArray, UseFormReturn } from "react-hook-form";
import { Button } from "~/components/ui/button";
import { Plus, Trash, ChevronDown, ChevronUp } from "lucide-react";
import { RequiredTextareaField } from "../../form-utils";
import { type RecipeFormValues } from "./types";

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
    <div className="w-full space-y-4">
      <div className="flex justify-end">
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

      {fields.length === 0 ? (
        <div className="text-sm text-gray-500 italic">
          No instructions added yet
        </div>
      ) : (
        <div className="space-y-4">
          {fields.map((field, instructionIndex) => (
            <div key={field.id} className="flex items-start space-x-2">
              <div className="flex-grow">
                <RequiredTextareaField
                  form={form}
                  name={`sections.${sectionIndex}.instructions.${instructionIndex}.instruction`}
                  label={`Step ${instructionIndex + 1}`}
                  placeholder="Enter instruction step"
                />
              </div>
              <div className="mt-8 flex flex-col space-y-1">
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  onClick={() =>
                    move(instructionIndex, Math.max(0, instructionIndex - 1))
                  }
                  disabled={instructionIndex === 0}
                >
                  <ChevronUp className="h-4 w-4" />
                </Button>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  onClick={() =>
                    move(
                      instructionIndex,
                      Math.min(fields.length - 1, instructionIndex + 1),
                    )
                  }
                  disabled={instructionIndex === fields.length - 1}
                >
                  <ChevronDown className="h-4 w-4" />
                </Button>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  onClick={() => remove(instructionIndex)}
                >
                  <Trash className="h-4 w-4" />
                </Button>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
};
