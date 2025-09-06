"use client";
import { type FC, useState } from "react";
import { type DetailSection } from "../data-table/detail-page";
import { DetailPage } from "../data-table/detail-page";
import { InfLocation } from "~/schemas/location";
import { NoneState } from "../NoneState";
import { InventoryEntryPillLink, LocationPillLink } from "../EntityPill";
import { Button } from "~/components/ui/button";
import { LocationForm } from "./location-form";
import { type LocationUpdateInput } from "~/schemas/location";
import { useTRPC } from "~/trpc/react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import EntityImageList from "../EntityImageList";

import { useMutation, useQuery } from "@tanstack/react-query";
import { EntityPillLinkList } from "../EntityPillLinkList";

interface LocationDetailProps {
  location: InfLocation;
}

export const LocationDetail: FC<LocationDetailProps> = ({ location }) => {
  const api = useTRPC();
  const router = useRouter();
  const [isEditing, setIsEditing] = useState(false);
  const [error, setError] = useState<string | undefined>();

  const updateLocation = useMutation(
    api.location.update.mutationOptions({
      onSuccess: () => {
        setIsEditing(false);
        router.refresh();
      },
      onError: (error) => {
        setError(error.message);
      },
    }),
  );

  const handleEdit = (data: LocationUpdateInput) => {
    updateLocation.mutate(data);
  };

  const handleCancel = () => {
    setIsEditing(false);
    setError(undefined);
  };

  const { data: inventoryItemsData } = useQuery(
    api.inventoryItem.list.queryOptions({
      sort: { orderBy: "createdAt", direction: "desc" },
      pagination: { pageIndex: 0, pageSize: 100 },
      filters: { locationIdFilter: location.id },
    }),
  );

  // Get location images from the location object
  const locationImages = location.images || [];

  const sections: DetailSection[] = [
    {
      title: "Basic Information",
      content: isEditing ? (
        <div className="container mx-auto py-10">
          <h1 className="mb-6 text-2xl font-bold">Edit Location</h1>
          <LocationForm
            mode="edit"
            entity={location}
            onEdit={handleEdit}
            isPending={updateLocation.isPending}
            error={error}
            onCancel={handleCancel}
          />
        </div>
      ) : (
        <div className="space-y-2">
          <div>
            <span className="font-medium">Name:</span> {location.name}
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
            <Button onClick={() => setIsEditing(true)}>Edit</Button>
            <Link href={`/inventory/bulk-edit?locationId=${location.id}`}>
              <Button variant="outline">Bulk Edit Inventory</Button>
            </Link>
          </div>
        </div>
      ),
    },
    {
      title: "Images",
      content: <EntityImageList images={locationImages} />,
    },
    {
      title: "Child Locations",
      content: (
        <EntityPillLinkList
          items={location.children}
          Pill={LocationPillLink}
          pillPropName="location"
        />
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
