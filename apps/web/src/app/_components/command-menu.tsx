import { useNavigate } from "@tanstack/react-router";
import { Barcode, ScanBarcode, Settings } from "lucide-react";
import * as React from "react";
import {
  CommandDialog,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
  CommandSeparator,
} from "~/components/ui/command";
import { entities } from "~/entities/entities";

export function GlobalCommandMenu() {
  const [open, setOpen] = React.useState(false);
  const navigate = useNavigate();

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
    navigate({ to: path });
    setOpen(false);
  };
  return (
    <CommandDialog open={open} onOpenChange={setOpen}>
      <CommandInput placeholder="Type a command or search..." />
      <CommandList>
        <CommandEmpty>No results found.</CommandEmpty>
        <CommandGroup heading="Entities">
          {Object.values(entities).map((entity) => (
            <CommandItem
              key={entity.basePath}
              onSelect={() => goToPage(`/${entity.basePath}`)}
            >
              <entity.lucideIcon className="h-4 w-4" />
              <span>{entity.pluralLabel}</span>
            </CommandItem>
          ))}
        </CommandGroup>
        <CommandSeparator />
        <CommandGroup heading="Quick Actions">
          <CommandItem onSelect={() => goToPage("/inventory/scanner")}>
            <ScanBarcode />
            <span>Scanner</span>
          </CommandItem>
          <CommandItem onSelect={() => goToPage("/inventory/quick-capture")}>
            <Barcode />
            <span>Quick Capture</span>
          </CommandItem>
        </CommandGroup>
        <CommandSeparator />
        <CommandGroup heading="Settings">
          <CommandItem onSelect={() => goToPage("/api/panel")}>
            <Settings />
            <span>API Panel</span>
          </CommandItem>
        </CommandGroup>
      </CommandList>
    </CommandDialog>
  );
}
