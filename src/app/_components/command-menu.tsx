"use client";

import * as React from "react";
import { Settings } from "lucide-react";

import {
  CommandDialog,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
  CommandSeparator,
} from "~/components/ui/command";

import { useRouter } from "next/navigation";
import { entities } from "~/entities/entities";

export function GlobalCommandMenu() {
  const [open, setOpen] = React.useState(false);
  const router = useRouter();

  React.useEffect(() => {
    const down = (e: KeyboardEvent) => {
      if (e.key === "k" && (e.metaKey || e.ctrlKey)) {
        e.preventDefault();
        setOpen((open) => !open);
      }
    };

    document.addEventListener("keydown", down);
    return () => document.removeEventListener("keydown", down);
  }, []);

  const goToPage = (path: string) => {
    router.push(path);
    setOpen(false);
  };
  return (
    <>
      <CommandDialog open={open} onOpenChange={setOpen}>
        <CommandInput placeholder="Type a command or search..." />
        <CommandList>
          <CommandEmpty>No results found.</CommandEmpty>
          <CommandGroup heading="Entities">
            {Object.entries(entities).map(([name, entity]) => (
              <CommandItem
                key={entity.basePath}
                onSelect={() => goToPage(`/${entity.basePath}`)}
              >
                {entity.icon}
                <span>{entity.pluralLabel}</span>
              </CommandItem>
            ))}
          </CommandGroup>
          <CommandSeparator />
          <CommandGroup heading="Settings">
            <CommandItem onSelect={() => goToPage(`/api/panel`)}>
              <Settings />
              <span>API Panel</span>
            </CommandItem>
          </CommandGroup>
        </CommandList>
      </CommandDialog>
    </>
  );
}
