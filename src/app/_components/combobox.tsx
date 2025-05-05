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

export const ComboboxItem = z.object({
  name: z.string(),
  id: z.string(),
});
export const NullableComboboxItem = ComboboxItem.nullable();

export type ComboboxItem = z.infer<typeof ComboboxItem>;
export type NullableComboboxItem = z.infer<typeof NullableComboboxItem>;
export const clientSideFilter = (
  items: ComboboxItem[] | undefined,
  query: string,
) => {
  if (!items) {
    return [];
  }
  const normalizedQuery = query.toLowerCase().trim();
  if (normalizedQuery === "") {
    return items;
  }
  return normalizedQuery === ""
    ? items
    : items.filter((item) => {
        return item.name.toLowerCase().includes(normalizedQuery);
      });
};
export const Combobox: React.FC<{
  label: string;
  findItems: (searchQuery: string) => Promise<ComboboxItem[]>;
  value: NullableComboboxItem;
  setValue: (item: NullableComboboxItem) => void;
}> = ({ label, findItems, value, setValue }) => {
  const [open, setOpen] = React.useState(false);

  const [commandInput, setCommandInput] = React.useState<string>("");
  const [results, setResults] = React.useState<ComboboxItem[]>([]);
  React.useEffect(() => {
    async function handleValueChange() {
      const result = await findItems(commandInput);
      setResults(result);
    }
    handleValueChange();
  }, [commandInput, findItems]);

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
            <CommandEmpty>No {label} found.</CommandEmpty>
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
