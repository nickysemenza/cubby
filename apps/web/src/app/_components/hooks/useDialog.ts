"use client";

import { useState, useCallback } from "react";

export interface UseDialogOptions {
  defaultOpen?: boolean;
  onOpenChange?: (open: boolean) => void;
}

export interface UseDialogReturn {
  isOpen: boolean;
  open: () => void;
  close: () => void;
  toggle: () => void;
  setOpen: (open: boolean) => void;
}

/**
 * Hook for managing simple dialog open/close state.
 *
 * Provides convenient methods for opening, closing, and toggling dialogs
 * while maintaining compatibility with shadcn/ui Dialog components.
 *
 * @example
 * ```tsx
 * const dialog = useDialog();
 *
 * return (
 *   <Dialog open={dialog.isOpen} onOpenChange={dialog.setOpen}>
 *     <DialogTrigger asChild>
 *       <Button onClick={dialog.open}>Open</Button>
 *     </DialogTrigger>
 *     <DialogContent>
 *       <DialogHeader>
 *         <DialogTitle>Title</DialogTitle>
 *       </DialogHeader>
 *       <Button onClick={dialog.close}>Close</Button>
 *     </DialogContent>
 *   </Dialog>
 * );
 * ```
 */
export function useDialog({
  defaultOpen = false,
  onOpenChange,
}: UseDialogOptions = {}): UseDialogReturn {
  const [isOpen, setIsOpenInternal] = useState(defaultOpen);

  const setOpen = useCallback(
    (open: boolean) => {
      setIsOpenInternal(open);
      onOpenChange?.(open);
    },
    [onOpenChange],
  );

  const open = useCallback(() => setOpen(true), [setOpen]);
  const close = useCallback(() => setOpen(false), [setOpen]);
  const toggle = useCallback(() => setOpen(!isOpen), [setOpen, isOpen]);

  return {
    isOpen,
    open,
    close,
    toggle,
    setOpen,
  };
}
