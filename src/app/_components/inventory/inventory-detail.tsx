"use client";

import JsonRenderer from "~/app/_components/json-renderer";
import { useWasm } from "~/wasmContext";
import { type inventoryWithLocationAndProductOut } from "~/schemas/combo";
import { z } from "zod";
import { type FC, useState } from "react";
import { showAmountAndPrice } from "./format-amount";
import { LocationPillLink, ProductPillLink } from "../EntityPill";
import { buildunitMappingsGraph } from "../units/UnitMappingGraph";
import { DetailPage, type DetailSection } from "../data-table/detail-page";
import { Input } from "~/components/ui/input";
import { Button } from "~/components/ui/button";
import { Amount } from "~/codec/codec";
import { api } from "~/trpc/react";
import {
  clientSideFilter,
  Combobox,
  ComboboxItem,
  NullableComboboxItem,
} from "../combobox";
import {
  buildProductComboboxItem,
  buildLocationComboboxItem,
} from "../combobox/utils";

type InventoryItem = z.infer<typeof inventoryWithLocationAndProductOut>;

interface InventoryDetailProps {
  inventoryitem: InventoryItem;
}

export const InventoryDetail: FC<InventoryDetailProps> = ({
  inventoryitem,
}) => {
  const { w } = useWasm();
  const [isEditing, setIsEditing] = useState(false);
  const [isEditingLocation, setIsEditingLocation] = useState(false);
  const [isEditingProduct, setIsEditingProduct] = useState(false);
  const [amountValue, setAmountValue] = useState(
    inventoryitem.amount.value.toString(),
  );
  const [amountUnit, setAmountUnit] = useState(inventoryitem.amount.unit);

  const currentLocationSelection = buildLocationComboboxItem(
    inventoryitem.location,
  );
  const [selectedLocation, setSelectedLocation] =
    useState<NullableComboboxItem>(currentLocationSelection);

  const currentProductSelection = buildProductComboboxItem(
    inventoryitem.product,
  );
  const [selectedProductId, setSelectedProductId] =
    useState<NullableComboboxItem>(currentProductSelection);
  const [errorMessage, setErrorMessage] = useState("");

  // Fetch locations and products for dropdowns
  const [locations] = api.location.list.useSuspenseQuery({
    pagination: { pageIndex: 0, pageSize: 100 },
    sort: { orderBy: "name", direction: "asc" },
  });
  const findLocations = async (searchQuery: string) =>
    // todo: server side search here
    clientSideFilter(
      locations.items.map(buildLocationComboboxItem),
      searchQuery,
    );

  const [products] = api.product.list.useSuspenseQuery({
    pagination: { pageIndex: 0, pageSize: 100 },
    sort: { orderBy: "name", direction: "asc" },
  });

  const findProducts = async (searchQuery: string): Promise<ComboboxItem[]> =>
    // todo: server side search here
    clientSideFilter(products.items.map(buildProductComboboxItem), searchQuery);

  const updateMutation = api.inventoryItem.update.useMutation({
    onSuccess: () => {
      setIsEditing(false);
      setIsEditingLocation(false);
      setIsEditingProduct(false);
      setErrorMessage("");
      // Refresh the page to get updated data
      window.location.reload();
    },
    onError: (error) => {
      setErrorMessage(`Error: ${error.message}`);
    },
  });

  const handleSaveAmount = () => {
    const numValue = parseFloat(amountValue);
    if (isNaN(numValue)) {
      setErrorMessage("Please enter a valid number");
      return;
    }

    const newAmount: Amount = {
      value: numValue,
      unit: amountUnit,
    };

    updateMutation.mutate({
      id: inventoryitem.id,
      data: { amount: newAmount },
    });
  };

  const handleSaveLocation = () => {
    if (!selectedLocation) {
      setErrorMessage("Please select a location");
      return;
    }

    updateMutation.mutate({
      id: inventoryitem.id,
      data: { locationId: selectedLocation.id },
    });
  };

  const handleSaveProduct = () => {
    if (!selectedProductId) {
      setErrorMessage("Please select a product");
      return;
    }

    updateMutation.mutate({
      id: inventoryitem.id,
      data: { productId: selectedProductId.id },
    });
  };

  if (!w) {
    return <div>Loading...</div>;
  }

  const AmountContent = () => {
    if (isEditing) {
      return (
        <div className="space-y-4">
          <div className="flex space-x-4">
            <div className="flex-1">
              <label className="mb-2 block text-sm font-medium">Value</label>
              <Input
                type="number"
                step="0.01"
                value={amountValue}
                onChange={(e) => setAmountValue(e.target.value)}
              />
            </div>
            <div className="flex-1">
              <label className="mb-2 block text-sm font-medium">Unit</label>
              <Input
                type="text"
                value={amountUnit}
                onChange={(e) => setAmountUnit(e.target.value)}
              />
            </div>
          </div>
          {errorMessage && isEditing && (
            <div className="text-sm text-red-500">{errorMessage}</div>
          )}
          <div className="flex space-x-2">
            <Button
              onClick={handleSaveAmount}
              disabled={updateMutation.isPending}
            >
              {updateMutation.isPending ? "Saving..." : "Save"}
            </Button>
            <Button
              variant="outline"
              onClick={() => {
                setIsEditing(false);
                setAmountValue(inventoryitem.amount.value.toString());
                setAmountUnit(inventoryitem.amount.unit);
                setErrorMessage("");
              }}
              disabled={updateMutation.isPending}
            >
              Cancel
            </Button>
          </div>
        </div>
      );
    }

    return (
      <div className="space-y-4">
        <div className="text-lg">
          {showAmountAndPrice(
            w,
            inventoryitem.amount,
            inventoryitem.product.unitMappings,
          )}
        </div>
        <Button variant="outline" onClick={() => setIsEditing(true)}>
          Edit Amount
        </Button>
      </div>
    );
  };

  const LocationContent = () => {
    if (isEditingLocation) {
      return (
        <div className="space-y-4">
          <div>
            <label className="mb-2 block text-sm font-medium">Location</label>
            <Combobox
              label="location"
              findItems={findLocations}
              value={selectedLocation}
              setValue={setSelectedLocation}
            />
          </div>
          {errorMessage && isEditingLocation && (
            <div className="text-sm text-red-500">{errorMessage}</div>
          )}
          <div className="flex space-x-2">
            <Button
              onClick={handleSaveLocation}
              disabled={updateMutation.isPending}
            >
              {updateMutation.isPending ? "Saving..." : "Save"}
            </Button>
            <Button
              variant="outline"
              onClick={() => {
                setIsEditingLocation(false);
                setSelectedLocation(currentLocationSelection);
                setErrorMessage("");
              }}
              disabled={updateMutation.isPending}
            >
              Cancel
            </Button>
          </div>
        </div>
      );
    }

    return (
      <div className="space-y-4">
        <LocationPillLink location={inventoryitem.location} />
        <Button variant="outline" onClick={() => setIsEditingLocation(true)}>
          Change Location
        </Button>
      </div>
    );
  };

  const ProductContent = () => {
    if (isEditingProduct) {
      return (
        <div className="space-y-4">
          <div>
            <label className="mb-2 block text-sm font-medium">Product</label>
            <Combobox
              label="product"
              findItems={findProducts}
              value={selectedProductId}
              setValue={setSelectedProductId}
            />
          </div>
          {errorMessage && isEditingProduct && (
            <div className="text-sm text-red-500">{errorMessage}</div>
          )}
          <div className="flex space-x-2">
            <Button
              onClick={handleSaveProduct}
              disabled={updateMutation.isPending}
            >
              {updateMutation.isPending ? "Saving..." : "Save"}
            </Button>
            <Button
              variant="outline"
              onClick={() => {
                setIsEditingProduct(false);
                setSelectedProductId(currentProductSelection);
                setErrorMessage("");
              }}
              disabled={updateMutation.isPending}
            >
              Cancel
            </Button>
          </div>
        </div>
      );
    }

    return (
      <div className="space-y-4">
        <ProductPillLink product={inventoryitem.product} />
        <div className="bg-muted rounded-md p-4">
          {w && buildunitMappingsGraph(w, inventoryitem.product.unitMappings)}
        </div>
        <Button variant="outline" onClick={() => setIsEditingProduct(true)}>
          Change Product
        </Button>
      </div>
    );
  };

  const sections: DetailSection[] = [
    {
      title: "Amount",
      content: <AmountContent />,
    },
    {
      title: "Location",
      content: <LocationContent />,
    },
    {
      title: "Product",
      content: <ProductContent />,
    },
    {
      title: "Raw Details",
      content: (
        <div className="bg-muted rounded-md p-4">
          <JsonRenderer input={inventoryitem} />
        </div>
      ),
    },
  ];

  return <DetailPage sections={sections} title="inventory-item" />;
};
