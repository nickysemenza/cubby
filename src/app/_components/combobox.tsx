"use client";

import * as React from "react";
import { Check, ChevronsUpDown } from "lucide-react";

import { cn } from "~/lib/utils";
import { Button } from "~/components/ui/button";
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "~/components/ui/command";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "~/components/ui/popover";
import { z } from "zod";
import useDebounce from "~/misc/useDebounce";

export const ComboboxItem = z.object({
  name: z.string(),
  id: z.string(),
});
export const NullableComboboxItem = ComboboxItem.nullable();

export type ComboboxItem = z.infer<typeof ComboboxItem>;
export type NullableComboboxItem = z.infer<typeof NullableComboboxItem>;

export const Combobox: React.FC<{
  label: string;
  findItems: (searchQuery: string) => Promise<ComboboxItem[]>;
  value: NullableComboboxItem;
  setValue: (item: NullableComboboxItem) => void;
  onCreateNew?: (name: string) => Promise<ComboboxItem>;
}> = ({ label, findItems, value, setValue, onCreateNew }) => {
  const [open, setOpen] = React.useState(false);

  const [commandInput, setCommandInput] = React.useState<string>("");
  const [results, setResults] = React.useState<ComboboxItem[]>([]);
  const debouncedInput = useDebounce(commandInput, 300);

  React.useEffect(() => {
    async function handleValueChange() {
      const result = await findItems(debouncedInput);
      setResults(result);
    }
    handleValueChange();
  }, [debouncedInput, findItems]);

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          variant="outline"
          role="combobox"
          aria-expanded={open}
          className="w-[200px] justify-between"
        >
          {value?.name || "none"}
          <ChevronsUpDown className="ml-2 h-4 w-4 shrink-0 opacity-50" />
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-[200px] p-0">
        <Command shouldFilter={false}>
          <CommandInput
            placeholder={`Search ${label}...`}
            value={commandInput}
            onValueChange={setCommandInput}
          />
          <CommandList>
            <CommandEmpty>
              No {label} found.
              {onCreateNew && commandInput.trim() !== "" && (
                <Button
                  variant="outline"
                  className="mt-2 w-full"
                  onClick={async () => {
                    const newItem = await onCreateNew(commandInput);
                    setValue(newItem);
                    setOpen(false);
                    setCommandInput("");
                  }}
                >
                  Create new {label}: {commandInput}
                </Button>
              )}
            </CommandEmpty>
            <CommandGroup>
              {results.map((result: ComboboxItem) => (
                <CommandItem
                  key={result.id}
                  value={result.id}
                  onSelect={(selectedId) => {
                    if (selectedId === value?.id) {
                      setValue(null);
                      setOpen(false);
                      return;
                    }
                    setValue(result);
                    setOpen(false);
                  }}
                >
                  <Check
                    className={cn(
                      "mr-2 h-4 w-4",
                      value?.id === result.id ? "opacity-100" : "opacity-0",
                    )}
                  />
                  {result.name}
                </CommandItem>
              ))}
            </CommandGroup>
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
};
