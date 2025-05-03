"use client";

import JsonRenderer from "~/app/_components/json-renderer";
import { useWasm } from "~/wasmContext";
import { type inventoryWithLocationAndProductOut } from "~/schemas/combo";
import { z } from "zod";
import { type FC } from "react";
import { formatAmount } from "./format-amount";
import { LocationPillLink, ProductPillLink } from "../EntityPill";
import { buildunitMappingsGraph } from "../units/UnitMappingGraph";
import { DetailPage, type DetailSection } from "../data-table/detail-page";

type InventoryItem = z.infer<typeof inventoryWithLocationAndProductOut>;

interface InventoryDetailProps {
    inventoryitem: InventoryItem;
}

export const InventoryDetail: FC<InventoryDetailProps> = ({ inventoryitem }) => {
    const { w } = useWasm();

    if (!w) {
        return <div>Loading...</div>;
    }

    const sections: DetailSection[] = [
        {
            title: "Amount",
            content: (
                <div className="text-lg">
                    {formatAmount(w, inventoryitem.amount, inventoryitem.product.unitMappings)}
                </div>
            ),
        },
        {
            title: "Location",
            content: <LocationPillLink location={inventoryitem.location} />,
        },
        {
            title: "Product",
            content: (
                <div className="space-y-4">
                    <ProductPillLink product={inventoryitem.product} />
                    <div className="rounded-md bg-muted p-4">
                        {w && buildunitMappingsGraph(w, inventoryitem.product.unitMappings)}
                    </div>
                </div>
            ),
        },
        {
            title: "Raw Details",
            content: (
                <div className="rounded-md bg-muted p-4">
                    <JsonRenderer input={inventoryitem} />
                </div>
            ),
            isWide: true,
        },
    ];

    return <DetailPage sections={sections} title="inventory-item" />;
}; 