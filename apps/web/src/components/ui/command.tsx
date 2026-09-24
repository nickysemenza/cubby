
import * as React from "react";
import { Command as CommandPrimitive } from "cmdk";

import { cn } from "~/lib/utils";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "~/components/ui/dialog";
import { InputGroup, InputGroupAddon } from "~/components/ui/input-group";
import { MagnifyingGlassIcon as SearchIcon } from "@phosphor-icons/react/dist/csr/MagnifyingGlass";
import { CheckIcon } from "@phosphor-icons/react/dist/csr/Check";

function Command({
  className,
  ...props
}: React.ComponentProps<typeof CommandPrimitive>) {
  return (
    <CommandPrimitive
      data-slot="command"
      className={cn(
        "bg-popover text-popover-foreground flex size-full flex-col overflow-hidden rounded-lg p-1",
        className,
      )}
      {...props}
    />
  );
}

function CommandDialog({
  title = "Command Palette",
  description = "Search for a command to run...",
  children,
  className,
  showCloseButton = false,
  shouldFilter,
  ...props
}: Omit<React.ComponentProps<typeof Dialog>, "children"> & {
  title?: string;
  description?: string;
  className?: string;
  showCloseButton?: boolean;
  shouldFilter?: boolean;
  children: React.ReactNode;
}) {
  return (
    <Dialog {...props}>
      <DialogHeader className="sr-only">
        <DialogTitle>{title}</DialogTitle>
        <DialogDescription>{description}</DialogDescription>
      </DialogHeader>
      <DialogContent
        className={cn(
          "overflow-hidden rounded-xl! bg-popover p-0 shadow-[var(--shadow-overlay)]",
          className,
        )}
        showCloseButton={showCloseButton}
      >
        <Command shouldFilter={shouldFilter}>{children}</Command>
      </DialogContent>
    </Dialog>
  );
}

function CommandInput({
  className,
  startAdornment,
  ...props
}: React.ComponentProps<typeof CommandPrimitive.Input> & {
  startAdornment?: React.ReactNode;
}) {
  return (
    <div data-slot="command-input-wrapper" className="p-1 pb-0">
      <InputGroup className="bg-input/20 h-8!">
        <CommandPrimitive.Input
          data-slot="command-input"
          className={cn(
            "w-full text-xs/relaxed outline-hidden disabled:cursor-not-allowed disabled:opacity-50",
            className,
          )}
          {...props}
        />
        <InputGroupAddon>
          <SearchIcon className="size-3.5 shrink-0 opacity-50" />
          {startAdornment}
        </InputGroupAddon>
      </InputGroup>
    </div>
  );
}

function CommandList({
  className,
  ...props
}: React.ComponentProps<typeof CommandPrimitive.List>) {
  return (
    <CommandPrimitive.List
      data-slot="command-list"
      className={cn(
        "no-scrollbar max-h-72 scroll-py-1 overflow-x-hidden overflow-y-auto outline-none",
        className,
      )}
      {...props}
    />
  );
}

function CommandGroup({
  className,
  ...props
}: React.ComponentProps<typeof CommandPrimitive.Group>) {
  return (
    <CommandPrimitive.Group
      data-slot="command-group"
      className={cn(
        "text-foreground [&_[cmdk-group-heading]]:text-muted-foreground overflow-hidden p-1 [&_[cmdk-group-heading]]:px-2.5 [&_[cmdk-group-heading]]:py-1.5 [&_[cmdk-group-heading]]:text-xs [&_[cmdk-group-heading]]:font-medium",
        className,
      )}
      {...props}
    />
  );
}

function CommandSeparator({
  className,
  ...props
}: React.ComponentProps<typeof CommandPrimitive.Separator>) {
  return (
    <CommandPrimitive.Separator
      data-slot="command-separator"
      className={cn("bg-border/50 -mx-1 my-1 h-px", className)}
      {...props}
    />
  );
}

function CommandItem({
  className,
  children,
  ...props
}: React.ComponentProps<typeof CommandPrimitive.Item>) {
  return (
    <CommandPrimitive.Item
      data-slot="command-item"
      className={cn(
        "data-selected:bg-primary/10 data-selected:text-foreground data-selected:*:[svg]:text-foreground group/command-item relative flex min-h-8 cursor-default items-center gap-2 rounded-md px-2.5 py-1.5 text-xs/relaxed outline-hidden transition-colors duration-150 select-none data-[disabled=true]:pointer-events-none data-[disabled=true]:opacity-50 [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-3.5",
        className,
      )}
      {...props}
    >
      {children}
      <CheckIcon className="ml-auto opacity-0 group-has-[[data-slot=command-shortcut]]/command-item:hidden group-data-[checked=true]/command-item:opacity-100" />
    </CommandPrimitive.Item>
  );
}

export {

  CommandDialog,
  CommandInput,
  CommandList,
  CommandGroup,
  CommandItem,

  CommandSeparator,
};
