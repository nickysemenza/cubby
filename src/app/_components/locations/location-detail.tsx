"use client";

import { type FC } from "react";
import JsonRenderer from "~/app/_components/json-renderer";
import { type DetailSection } from "../data-table/detail-page";
import { DetailPage } from "../data-table/detail-page";
import { type LocationOutWithParentChildren } from "~/schemas/location";
import { NoneState } from "../NoneState";
import { LocationPillLink } from "../EntityPill";

interface LocationDetailProps {
    location: LocationOutWithParentChildren;
}

export const LocationDetail: FC<LocationDetailProps> = ({ location }) => {
    const sections: DetailSection[] = [
        {
            title: "Basic Information",
            content: (
                <div className="space-y-2">
                    <div>
                        <span className="font-medium">Name:</span> {location.name}
                    </div>
                    <div>
                        <span className="font-medium">Type:</span> {location.type}
                    </div>
                    <div>
                        <span className="font-medium">Parent Location:</span> {location.parent ? <LocationPillLink location={location.parent} /> : <NoneState />}
                    </div>
                </div>
            ),
        },
        {
            title: "Child Locations",
            content: (
                <div className="space-y-2">
                    {location.children && location.children.length > 0 ? (
                        location.children.map((child) => (
                            <div key={child.id}>
                                <LocationPillLink location={child} />
                            </div>
                        ))
                    ) : (
                        <NoneState />
                    )}
                </div>
            ),
        },
        {
            title: "Raw Details",
            content: (
                <div className="rounded-md bg-muted p-4">
                    <JsonRenderer input={location} />
                </div>
            ),
            isWide: true,
        },
    ];

    return <DetailPage sections={sections} title="location" />;
}; 