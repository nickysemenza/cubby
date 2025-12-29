import type { FC } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "~/components/ui/card";
import { EntityIcon, entities } from "~/entities/entities";
import type { Entity } from "~/entities/types";
import { useDebug } from "~/hooks/useDebug";
import { cn } from "~/lib/utils";
import JsonRenderer from "../json-renderer";

export interface DetailSection {
  title: string;
  content: React.ReactNode;
  icon: React.ElementType;
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

  return (
    <div className="space-y-4 sm:space-y-6">
      <h1 className="flex items-center gap-2 font-heading font-semibold text-xl tracking-tight sm:text-2xl">
        <EntityIcon entity={entity} colored className="h-6 w-6" />
        <span>
          {entityDetails.label}: <span className="text-foreground">{name}</span>
        </span>
      </h1>

      {/* Grid sections */}
      <div className="grid gap-4 sm:gap-6 md:grid-cols-2">
        {sections.map((section, index) => (
          <Card
            key={section.title}
            className={cn(
              "transition-all duration-200",
              "hover:-translate-y-0.5 hover:shadow-md",
              "fade-in slide-in-from-bottom-2 animate-in",
            )}
            style={{
              animationDelay: `${index * 75}ms`,
              animationFillMode: "both",
            }}
          >
            <CardHeader className="pb-3">
              <div className="flex items-center gap-2">
                <section.icon className="h-4 w-4 text-muted-foreground" />
                <CardTitle className="text-base">{section.title}</CardTitle>
              </div>
            </CardHeader>
            <CardContent>{section.content}</CardContent>
          </Card>
        ))}
      </div>

      {/* Debug raw details section - full width */}
      {isDebugEnabled && (
        <Card className="fade-in slide-in-from-bottom-2 animate-in duration-300">
          <CardHeader className="pb-3">
            <CardTitle className="text-base">Raw Details</CardTitle>
          </CardHeader>
          <CardContent>
            <JsonRenderer input={rawData} pretty />
          </CardContent>
        </Card>
      )}
    </div>
  );
};
