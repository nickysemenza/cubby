"use client";

import React from "react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "~/components/ui/dialog";
import JsonRenderer from "../json-renderer";

interface DebugDialogProps {
  data: unknown;
  trigger: React.ReactNode;
  title?: string;
}

export function DebugDialog({
  data,
  trigger,
  title = "Debug Data",
}: DebugDialogProps) {
  return (
    <Dialog>
      <DialogTrigger asChild>{trigger}</DialogTrigger>
      <DialogContent className="flex max-h-[80vh] max-w-6xl flex-col overflow-hidden">
        <DialogHeader className="flex-shrink-0">
          <DialogTitle>{title}</DialogTitle>
        </DialogHeader>
        <div className="flex-1 overflow-auto">
          <div className="bg-muted overflow-auto rounded-md p-4">
            <JsonRenderer input={data} pretty />
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
