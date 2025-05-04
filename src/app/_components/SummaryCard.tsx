"use client";

import React from "react";
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from "~/components/ui/card";

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
    <Card className={`mb-4 ${className || ""}`}>
      <CardHeader className="pb-2">
        <CardTitle>{title}</CardTitle>
        {description && <CardDescription>{description}</CardDescription>}
      </CardHeader>
      <CardContent>
        <div className="grid grid-cols-4 gap-4 md:grid-cols-8">
          {items.map((item, index) => (
            <div key={index}>
              <div className="text-muted-foreground text-sm">{item.label}</div>
              <div className="font-medium">
                {item.formatter ? item.formatter(item.value) : item.value}
              </div>
            </div>
          ))}
        </div>
      </CardContent>
    </Card>
  );
};
