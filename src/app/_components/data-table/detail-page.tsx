"use client";

import { type FC } from "react";
import { type Entity } from "~/entities/types";

export interface DetailSection {
    title: string;
    content: React.ReactNode;
    isWide?: boolean;
}

interface DetailPageProps {
    sections: DetailSection[];
    title: Entity;
}

export const DetailPage: FC<DetailPageProps> = ({ sections, title }) => {
    return (
        <div className="space-y-6 p-6">
            <h1 className="text-2xl font-bold capitalize">{title} Details</h1>
            <div className="grid gap-6 md:grid-cols-2">
                {sections.map((section, index) => (
                    <div
                        key={index}
                        className={`rounded-lg border bg-card p-6 ${section.isWide ? "md:col-span-2" : ""
                            }`}
                    >
                        <h2 className="mb-4 text-lg font-semibold">{section.title}</h2>
                        {section.content}
                    </div>
                ))}
            </div>
        </div>
    );
}; 