"use client";

import React from "react";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "~/components/ui/card";
import { cn } from "~/lib/utils";
import { SummaryGrid } from "~/components/ui/summary-grid";

export interface SummaryItem {
  label: string;
  value: string | number;
  formatter?: (value: string | number) => string;
}

export interface SummaryCardProps {
  items: SummaryItem[];
  title?: string;
  description?: string;
  className?: string;
}

export const SummaryCard: React.FC<SummaryCardProps> = ({
  items,
  title = "Summary",
  description,
  className,
}) => {
  return (
    <Card className={cn("mb-4", className)}>
      <CardHeader className="pb-2">
        <CardTitle>{title}</CardTitle>
        {description && <CardDescription>{description}</CardDescription>}
      </CardHeader>
      <CardContent>
        <SummaryGrid>
          {items.map((item, index) => (
            <div key={index}>
              <div className="text-muted-foreground text-sm">{item.label}</div>
              <div className="font-medium">
                {item.formatter ? item.formatter(item.value) : item.value}
              </div>
            </div>
          ))}
        </SummaryGrid>
      </CardContent>
    </Card>
  );
};
