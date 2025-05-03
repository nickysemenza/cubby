"use client";

import { type FC } from "react";
import { cn } from "~/lib/utils";

interface NoneStateProps {
    className?: string;
}

export const NoneState: FC<NoneStateProps> = ({ className }) => {
    return (
        <div
            className={cn(
                "inline-flex items-center justify-center rounded-md bg-muted px-3 py-1 text-sm text-muted-foreground",
                className,
            )}
        >
            None
        </div>
    );
}; 