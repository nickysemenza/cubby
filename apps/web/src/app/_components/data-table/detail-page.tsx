"use client";

import type { FC } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "~/components/ui/card";
import { entities } from "~/entities/entities";
import type { Entity } from "~/entities/types";
import { useDebug } from "~/hooks/useDebug";
import JsonRenderer from "../json-renderer";

export interface DetailSection {
  title: string;
  content: React.ReactNode;
}

interface DetailPageProps {
  sections: DetailSection[];
  entity: Entity;
  name: string;
  rawData: unknown; // The full entity data for debug display
}

export const DetailPage: FC<DetailPageProps> = ({
  sections,
  entity,
  name,
  rawData,
}) => {
  const entityDetails = entities[entity];
  const { isDebugEnabled } = useDebug();

  // All regular sections go in the grid
  const gridSections = sections;

  return (
    <div className="space-y-4 sm:space-y-6">
      <h1 className="font-bold text-xl capitalize sm:text-2xl">
        <span>{entityDetails.icon}</span>
        {entityDetails.label} Detail: {name}
      </h1>

      {/* Grid sections */}
      <div className="stagger-children grid gap-4 sm:gap-6 md:grid-cols-2">
        {gridSections.map((section, index) => (
          <Card key={index} className="card-hover overflow-hidden">
            <CardHeader className="bg-muted/50 px-4 py-3 sm:px-6 sm:py-4">
              <CardTitle className="font-medium text-base sm:text-lg">
                {section.title}
              </CardTitle>
            </CardHeader>
            <CardContent className="p-4 sm:p-6">{section.content}</CardContent>
          </Card>
        ))}
      </div>

      {/* Debug raw details section - full width */}
      {isDebugEnabled && (
        <Card className="overflow-hidden">
          <CardHeader className="bg-muted/50 px-4 py-3 sm:px-6 sm:py-4">
            <CardTitle className="font-medium text-base sm:text-lg">
              Raw Details
            </CardTitle>
          </CardHeader>
          <CardContent className="p-4 sm:p-6">
            <JsonRenderer input={rawData} pretty />
          </CardContent>
        </Card>
      )}
    </div>
  );
};
