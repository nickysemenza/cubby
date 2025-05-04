"use client";

import { type FC } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "~/components/ui/card";
import { type Entity } from "~/entities/types";

export interface DetailSection {
  title: string;
  content: React.ReactNode;
}

interface DetailPageProps {
  sections: DetailSection[];
  title: Entity;
}

export const DetailPage: FC<DetailPageProps> = ({ sections, title }) => {
  return (
    <div className="space-y-6 p-6">
      <h1 className="text-2xl font-bold capitalize">{title} Details</h1>
      <div className="container mx-auto p-4">
        <div className="grid gap-6 md:grid-cols-2">
          {sections.map((section, index) => (
            <Card key={index} className="overflow-hidden">
              <CardHeader className="bg-muted/50 px-6 py-4">
                <CardTitle className="text-lg font-medium">
                  {section.title}
                </CardTitle>
              </CardHeader>
              <CardContent className="p-6">{section.content}</CardContent>
            </Card>
          ))}
        </div>
      </div>
    </div>
  );
};
