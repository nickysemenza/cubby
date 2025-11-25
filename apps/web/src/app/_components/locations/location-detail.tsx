"use client";
import { type FC } from "react";
import { type DetailSection } from "../data-table/detail-page";
import { DetailPage } from "../data-table/detail-page";
import { InfLocation } from "~/schemas/location";
import { NoneState } from "../NoneState";
import { InventoryEntryPillLink, LocationPillLink } from "../EntityPill";
import { Button } from "~/components/ui/button";
import { LocationForm } from "./location-form";
import { type LocationUpdateInput } from "~/schemas/location";
import { useTRPC } from "~/trpc/react";
import Link from "next/link";
import EntityImageList from "../EntityImageList";
import { LocationCardGrid } from "./location-card-grid";
import { LocationIconWithLabel } from "./location-icons";
import { InventoryValueSummary } from "./inventory-value-summary";
import { useEditMode } from "../hooks/useEditMode";

import { useQuery } from "@tanstack/react-query";
import { EntityPillLinkList } from "../EntityPillLinkList";

interface LocationDetailProps {
  location: InfLocation;
}

export const LocationDetail: FC<LocationDetailProps> = ({ location }) => {
  const api = useTRPC();

  const editMode = useEditMode<LocationUpdateInput>({
    mutationOptions: api.location.update.mutationOptions(),
    useRouterRefresh: true,
  });

  const { data: inventoryItemsData } = useQuery(
    api.inventoryItem.list.queryOptions({
      sort: { orderBy: "createdAt", direction: "desc" },
      pagination: { pageIndex: 0, pageSize: 100 },
      filters: { locationIdFilter: location.id },
    }),
  );

  // Get location images from the location object
  const locationImages = location.images;

  const sections: DetailSection[] = [
    {
      title: "Basic Information",
      content: editMode.isEditing ? (
        <div className="container mx-auto py-10">
          <h1 className="mb-6 text-2xl font-bold">Edit Location</h1>
          <LocationForm
            mode="edit"
            entity={location}
            onEdit={editMode.handleEdit}
            isPending={editMode.isPending}
            error={editMode.error}
            onCancel={editMode.handleCancel}
          />
        </div>
      ) : (
        <div className="space-y-4">
          <div className="flex items-center gap-3">
            <LocationIconWithLabel
              type={location.type}
              label={location.name}
              size={20}
            />
          </div>
          <div>
            <span className="font-medium">Type:</span> {location.type}
          </div>
          <div>
            <span className="font-medium">Parent Location:</span>{" "}
            {location.parent ? (
              <LocationPillLink location={location.parent} />
            ) : (
              <NoneState />
            )}
          </div>
          <div className="mt-4 space-x-2">
            <Button onClick={editMode.startEditing}>Edit</Button>
            <Link href={`/inventory/bulk-edit?locationId=${location.id}`}>
              <Button variant="outline">Bulk Edit Inventory</Button>
            </Link>
          </div>
        </div>
      ),
    },
    {
      title: "Inventory Value",
      content: (
        <div className="py-1">
          <InventoryValueSummary locationId={location.id} variant="full" />
        </div>
      ),
    },
    {
      title: "Images",
      content: <EntityImageList images={locationImages} />,
    },
    {
      title: "Child Locations",
      content:
        location.children && location.children.length > 0 ? (
          <LocationCardGrid
            locations={location.children}
            showParentPath={false}
          />
        ) : (
          <NoneState />
        ),
    },
    {
      title: "Inventory Items",
      content: (
        <EntityPillLinkList
          items={inventoryItemsData?.items}
          Pill={InventoryEntryPillLink}
          pillPropName="entry"
        />
      ),
    },
  ];

  return (
    <DetailPage
      sections={sections}
      entity="location"
      name={location.name}
      rawData={location}
    />
  );
};
