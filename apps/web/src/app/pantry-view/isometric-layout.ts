import type { InfLocation } from "@cubby/schemas/location";
import {
  getCategoryColor,
  getLocationTypeColor,
  type LocationType,
  type ProductCategory,
} from "@cubby/shared";
import { sum, sumBy } from "es-toolkit";

import { formatCurrency } from "~/lib/utils";

import {
  type Camera,
  pointInPolygon,
  TILE_H,
  TILE_W,
  toScreen,
} from "./isometric-geometry";

const ZONE_OVERLAY_COLORS = [
  "rgba(34, 68, 204, 0.06)",
  "rgba(60, 60, 60, 0.05)",
  "rgba(34, 68, 204, 0.04)",
  "rgba(110, 110, 110, 0.05)",
  "rgba(34, 68, 204, 0.05)",
  "rgba(150, 150, 150, 0.05)",
];

const ZONE_LABEL_COLORS = [
  "rgba(34, 68, 204, 0.75)",
  "rgba(60, 60, 60, 0.75)",
  "rgba(34, 68, 204, 0.75)",
  "rgba(90, 90, 90, 0.75)",
  "rgba(34, 68, 204, 0.75)",
  "rgba(120, 120, 120, 0.75)",
];

// ─── Types ───────────────────────────────────────────────────────────────────

interface FurnitureItem {
  productName: string;
  category: ProductCategory | null;
  amount: string;
  color: string;
  inventoryId: string;
  valuation: number | null;
}

export interface FurniturePiece {
  gx: number;
  gy: number;
  gz: number;
  w: number;
  d: number;
  h: number;
  color: string;
  name: string;
  locationType: LocationType | null;
  locationId: string;
  locationShortcode: string;
  items: FurnitureItem[];
  shelfLevels: number[];
  /** Breadcrumb path from room root for tooltip display */
  path: string[];
  /** Immediate parent location ID for visual grouping within zones */
  parentGroupId: string;
  /** Immediate parent location name for group labels */
  parentGroupName: string;
  isEmpty: boolean;
  totalValuation: number;
}

export interface ZoneData {
  name: string;
  locationId: string;
  color: string;
  labelColor: string;
  startGx: number;
  endGx: number;
  pieces: FurniturePiece[];
  totalItemCount: number;
}

export interface RoomData {
  name: string;
  locationId: string;
  roomW: number;
  roomD: number;
  originX: number;
  originY: number;
  pieces: FurniturePiece[];
  zones: ZoneData[];
  totalItemCount: number;
}

export interface HoverTarget {
  type: "item" | "furniture";
  label: string;
  detail?: string;
  screenX: number;
  screenY: number;
  locationId: string;
  locationShortcode: string;
}

// ─── Furniture Specs ────────────────────────────────────────────────────────

interface FurnitureSpec {
  w: number;
  d: number;
  h: number;
  zone: "back-wall" | "left-wall" | "floor";
  shelfLevels: number[];
}

/**
 * `type` is the location's form factor and `productId` is a separate identity
 * link — a product-linked location can still carry its own `type` (e.g.
 * "box", "shelf") and hits that case directly. A null `type` just means
 * unknown, not "this location is a product".
 *
 * Null gets the box spec explicitly rather than falling through to `default`,
 * which is the back-wall shelving unit: a tote drawn 3.8 ft tall against the
 * wall is worse than a wrong-sized floor box. Of the locations with no
 * declared type, most are the crates, totes and packout boxes that predate
 * `type` being set on product-linked locations, so a floor box is right for
 * most and wrong for the handful of racks, carts and the one table.
 *
 * Getting those right needs a coarse shape on the Product, which it does not
 * carry — the deliberate trade in #749, where per-type glyphs were dropped
 * because nine of sixteen types already rendered identically. This switch is
 * the one consumer that actually wanted the distinction.
 */
function getFurnitureSpec(type: LocationType | null): FurnitureSpec {
  switch (type) {
    case null:
      return { w: 1.6, d: 1.6, h: 1.2, zone: "floor", shelfLevels: [0.1] };
    case "shelf":
      return {
        w: 2.5,
        d: 0.9,
        h: 3.8,
        zone: "back-wall",
        shelfLevels: [0, 1.0, 2.0, 3.0],
      };
    case "cabinet":
      return { w: 2.2, d: 1.0, h: 3.5, zone: "back-wall", shelfLevels: [3.5] };
    case "drawer":
      return { w: 2.0, d: 1.0, h: 2.0, zone: "left-wall", shelfLevels: [2.0] };
    case "table":
      return { w: 2.8, d: 1.8, h: 1.4, zone: "floor", shelfLevels: [1.3] };
    case "cart":
      return { w: 2.0, d: 1.2, h: 1.4, zone: "floor", shelfLevels: [1.3] };
    case "box":
      return { w: 1.6, d: 1.6, h: 1.2, zone: "floor", shelfLevels: [0.1] };
    case "bag":
      return { w: 1.2, d: 1.0, h: 0.9, zone: "floor", shelfLevels: [0.1] };
    default:
      return {
        w: 2.5,
        d: 0.9,
        h: 3.8,
        zone: "back-wall",
        shelfLevels: [0, 1.0, 2.0, 3.0],
      };
  }
}

export function getItemHeight(category: ProductCategory | null): number {
  switch (category?.feature) {
    case "food":
      return 0.5;
    case "tools":
      return 0.65;
    case "books":
      return 0.3;
    case "software":
      return 0.3;
    case "apparel":
      return 0.45;
    default:
      return 0.4;
  }
}

// ─── Room Building ──────────────────────────────────────────────────────────

/**
 * Deliberately NOT `Pick<InventoryListItemOut, ...>`: `id` here is a plain
 * string (unit-test fixtures construct rows with opaque local ids like
 * `"inventory-1"`, not branded `InventoryShortcode` values), and `amount` is
 * the minimal `{ value, unit }` the canvas actually reads — not the full
 * `amount` codec, which carries an extra `upperValue` refinement this layout
 * has no use for.
 */
export interface InventoryData {
  id: string;
  amount: { value: number; unit: string };
  valuation: number | null;
  product: { name: string; category: ProductCategory | null };
  location: { id: string; name: string; type: LocationType | null };
}

function isContainerType(type: LocationType | null): boolean {
  return type === "room" || type === "area";
}

/**
 * Walks a subtree and creates FurniturePieces with full hierarchy context.
 * Each piece gets a breadcrumb path and a parent group for visual clustering.
 */
function collectPiecesFromSubtree(
  root: InfLocation,
  itemsByLocation: Map<string, FurnitureItem[]>,
  basePath: string[],
  resolveColor: (color: string) => string,
): FurniturePiece[] {
  const pieces: FurniturePiece[] = [];

  function walk(
    node: InfLocation,
    path: string[],
    groupId: string,
    groupName: string,
  ) {
    const items = itemsByLocation.get(node.id) ?? [];
    // Create pieces for furniture-type locations even if empty (ghost furniture)
    if (!isContainerType(node.type)) {
      const spec = getFurnitureSpec(node.type);
      const totalValuation = sumBy(items, (it) => it.valuation ?? 0);
      pieces.push({
        gx: 0,
        gy: 0,
        gz: 0,
        w: spec.w,
        d: spec.d,
        h: spec.h,
        color: resolveColor(getLocationTypeColor(node.type)),
        name: node.name,
        locationType: node.type,
        locationId: node.id,
        locationShortcode: node.id,
        items,
        shelfLevels: spec.shelfLevels,
        path,
        parentGroupId: groupId,
        parentGroupName: groupName,
        isEmpty: items.length === 0,
        totalValuation,
      });
    }

    for (const child of node.children ?? []) {
      const childPath = [...path, child.name];
      // Container children start a new group; others inherit current group
      if (isContainerType(node.type)) {
        walk(child, childPath, node.id, node.name);
      } else {
        walk(child, childPath, groupId, groupName);
      }
    }
  }

  for (const child of root.children ?? []) {
    walk(child, [...basePath, child.name], root.id, root.name);
  }

  return pieces;
}

function calculateZoneWidth(pieces: FurniturePiece[]): number {
  const backWall = pieces.filter(
    (p) => getFurnitureSpec(p.locationType).zone === "back-wall",
  );
  const floorPieces = pieces.filter(
    (p) => getFurnitureSpec(p.locationType).zone !== "back-wall",
  );
  const backWallWidth = 1 + sumBy(backWall, (p) => p.w + 0.8);
  const floorCols = Math.max(1, Math.ceil(Math.sqrt(floorPieces.length)));
  return Math.max(4, Math.ceil(backWallWidth) + 1, floorCols * 3 + 2);
}

type ColorResolver = (color: string) => string;

function inventoryByLocation(
  inventory: InventoryData[],
  resolveColor: ColorResolver,
) {
  const result = new Map<string, FurnitureItem[]>();
  for (const item of inventory) {
    const locationItems = result.get(item.location.id) ?? [];
    locationItems.push({
      productName: item.product.name,
      category: item.product.category,
      amount: `${item.amount.value} ${item.amount.unit}`,
      color: resolveColor(getCategoryColor(item.product.category)),
      inventoryId: item.id,
      valuation: item.valuation,
    });
    result.set(item.location.id, locationItems);
  }
  return result;
}

function partitionRoomChildren(root: InfLocation) {
  const zoneContainers: InfLocation[] = [];
  const directFurniture: InfLocation[] = [];
  for (const child of root.children ?? []) {
    (isContainerType(child.type) ? zoneContainers : directFurniture).push(
      child,
    );
  }
  return { zoneContainers, directFurniture };
}

function containerZone(
  container: InfLocation,
  index: number,
  rootName: string,
  itemsByLocation: Map<string, FurnitureItem[]>,
  resolveColor: ColorResolver,
): ZoneData[] {
  const zonePath = [rootName, container.name];
  const pieces = collectPiecesFromSubtree(
    container,
    itemsByLocation,
    zonePath,
    resolveColor,
  );
  const containerItems = itemsByLocation.get(container.id) ?? [];
  if (containerItems.length > 0) {
    const spec = getFurnitureSpec("table");
    pieces.push({
      gx: 0,
      gy: 0,
      gz: 0,
      w: spec.w,
      d: spec.d,
      h: spec.h,
      color: resolveColor(getLocationTypeColor(container.type)),
      name: `${container.name} (items)`,
      locationType: "table",
      locationId: container.id,
      locationShortcode: container.id,
      items: containerItems,
      shelfLevels: spec.shelfLevels,
      path: zonePath,
      parentGroupId: container.id,
      parentGroupName: container.name,
      isEmpty: false,
      totalValuation: sumBy(containerItems, (item) => item.valuation ?? 0),
    });
  }
  if (pieces.every((piece) => piece.isEmpty)) return [];
  return [
    {
      name: container.name,
      locationId: container.id,
      color: ZONE_OVERLAY_COLORS[index % ZONE_OVERLAY_COLORS.length]!,
      labelColor: ZONE_LABEL_COLORS[index % ZONE_LABEL_COLORS.length]!,
      startGx: 0,
      endGx: 0,
      pieces,
      totalItemCount: sumBy(pieces, (piece) => piece.items.length),
    },
  ];
}

export function buildRooms(
  tree: InfLocation[],
  inventory: InventoryData[],
  resolveColor: (color: string) => string = (color) => color,
): RoomData[] {
  const itemsByLocation = inventoryByLocation(inventory, resolveColor);

  const rooms: RoomData[] = [];

  for (const rootNode of tree) {
    const { zoneContainers, directFurniture } = partitionRoomChildren(rootNode);
    const zones = zoneContainers.flatMap((container, index) =>
      containerZone(
        container,
        index,
        rootNode.name,
        itemsByLocation,
        resolveColor,
      ),
    );

    // Default zone: direct furniture children + room-level items
    const defaultPieces: FurniturePiece[] = [];
    for (const child of directFurniture) {
      const childPieces = collectPiecesFromSubtree(
        child,
        itemsByLocation,
        [rootNode.name, child.name],
        resolveColor,
      );
      // Also include the child itself if it has items (or as ghost furniture)
      const childItems = itemsByLocation.get(child.id) ?? [];
      if (!isContainerType(child.type)) {
        const spec = getFurnitureSpec(child.type);
        const totalValuation = sumBy(childItems, (it) => it.valuation ?? 0);
        childPieces.push({
          gx: 0,
          gy: 0,
          gz: 0,
          w: spec.w,
          d: spec.d,
          h: spec.h,
          color: resolveColor(getLocationTypeColor(child.type)),
          name: child.name,
          locationType: child.type,
          locationId: child.id,
          locationShortcode: child.id,
          items: childItems,
          shelfLevels: spec.shelfLevels,
          path: [rootNode.name, child.name],
          parentGroupId: rootNode.id,
          parentGroupName: rootNode.name,
          isEmpty: childItems.length === 0,
          totalValuation,
        });
      }
      defaultPieces.push(...childPieces);
    }

    const roomDirectItems = itemsByLocation.get(rootNode.id) ?? [];
    if (roomDirectItems.length > 0) {
      const spec = getFurnitureSpec("table");
      const totalValuation = sumBy(roomDirectItems, (it) => it.valuation ?? 0);
      defaultPieces.push({
        gx: 0,
        gy: 0,
        gz: 0,
        w: spec.w,
        d: spec.d,
        h: spec.h,
        color: resolveColor(getLocationTypeColor(rootNode.type)),
        name: `${rootNode.name} (direct)`,
        locationType: "table",
        locationId: rootNode.id,
        locationShortcode: rootNode.id,
        items: roomDirectItems,
        shelfLevels: spec.shelfLevels,
        path: [rootNode.name],
        parentGroupId: rootNode.id,
        parentGroupName: rootNode.name,
        isEmpty: false,
        totalValuation,
      });
    }

    if (defaultPieces.length > 0 && !defaultPieces.every((p) => p.isEmpty)) {
      let totalItems = 0;
      for (const p of defaultPieces) totalItems += p.items.length;

      const hasNamedZones = zones.length > 0;
      zones.push({
        name: hasNamedZones ? "Other" : "",
        locationId: rootNode.id,
        color: hasNamedZones
          ? ZONE_OVERLAY_COLORS[zones.length % ZONE_OVERLAY_COLORS.length]!
          : "transparent",
        labelColor: hasNamedZones
          ? ZONE_LABEL_COLORS[zones.length % ZONE_LABEL_COLORS.length]!
          : "transparent",
        startGx: 0,
        endGx: 0,
        pieces: defaultPieces,
        totalItemCount: totalItems,
      });
    }

    if (zones.length === 0) continue;

    // Calculate zone widths and room dimensions
    const zoneWidths = zones.map((z) => calculateZoneWidth(z.pieces));
    const totalZoneWidth = sum(zoneWidths);
    const gapCount = Math.max(0, zones.length - 1);
    const zoneGap = 0.6;
    const roomW = Math.max(6, totalZoneWidth + gapCount * zoneGap + 1);

    // Assign zone X ranges
    let currentX = 0.5;
    // zoneWidths is built via zones.map, so indices align and are in-bounds
    for (let i = 0; i < zones.length; i++) {
      zones[i]!.startGx = currentX;
      zones[i]!.endGx = currentX + zoneWidths[i]!;
      currentX += zoneWidths[i]! + zoneGap;
    }

    // Calculate room depth
    let maxDepth = 5;
    for (const zone of zones) {
      const floorPieces = zone.pieces.filter(
        (p) => getFurnitureSpec(p.locationType).zone !== "back-wall",
      );
      const floorRows = Math.max(1, Math.ceil(Math.sqrt(floorPieces.length)));
      maxDepth = Math.max(maxDepth, floorRows * 3 + 3);
    }
    const roomD = maxDepth;

    // Layout furniture within each zone
    for (const zone of zones) {
      layoutFurnitureInZone(zone.pieces, zone.startGx, zone.endGx, roomD);
    }

    const allPieces = zones.flatMap((z) => z.pieces);
    let totalItemCount = 0;
    for (const z of zones) totalItemCount += z.totalItemCount;

    rooms.push({
      name: rootNode.name,
      locationId: rootNode.id,
      roomW,
      roomD,
      originX: 0,
      originY: 0,
      pieces: allPieces,
      zones,
      totalItemCount,
    });
  }

  layoutRoomsGrid(rooms);
  return rooms;
}

/** Sort pieces by parent group so related furniture clusters together */
function sortByGroup(pieces: FurniturePiece[]): FurniturePiece[] {
  return [...pieces].sort((a, b) =>
    a.parentGroupId.localeCompare(b.parentGroupId),
  );
}

/** Extra gap inserted between pieces that belong to different parent groups */
const GROUP_GAP = 1.2;

function layoutFurnitureInZone(
  pieces: FurniturePiece[],
  startX: number,
  endX: number,
  roomD: number,
) {
  const backWall: FurniturePiece[] = [];
  const leftWall: FurniturePiece[] = [];
  const floor: FurniturePiece[] = [];

  for (const p of pieces) {
    const placement = getFurnitureSpec(p.locationType).zone;
    if (placement === "back-wall") backWall.push(p);
    else if (placement === "left-wall") leftWall.push(p);
    else floor.push(p);
  }

  // Back wall: grouped by parent, with extra gap between groups
  const sortedBack = sortByGroup(backWall);
  let bx = startX;
  let lastBackGroup = "";
  for (const p of sortedBack) {
    if (lastBackGroup && p.parentGroupId !== lastBackGroup) bx += GROUP_GAP;
    if (bx + p.w > endX - 0.3) {
      floor.push(p);
      continue;
    }
    p.gx = bx;
    p.gy = 0.3;
    lastBackGroup = p.parentGroupId;
    bx += p.w + 0.6;
  }

  // Left wall: only works if zone starts near room's left wall
  let ly = 1;
  for (const p of leftWall) {
    if (startX > 1 || ly + p.d > roomD - 0.5) {
      floor.push(p);
      continue;
    }
    p.gx = startX + 0.3;
    p.gy = ly;
    ly += p.d + 0.6;
  }

  // Floor: grouped by parent, with extra gap between groups
  const sortedFloor = sortByGroup(floor);
  const floorStartX = startX > 1 ? startX + 0.3 : startX + 2;
  const floorStartY = 2.5;
  let fx = floorStartX;
  let fy = floorStartY;
  let lastFloorGroup = "";

  for (const p of sortedFloor) {
    if (lastFloorGroup && p.parentGroupId !== lastFloorGroup) {
      fx += GROUP_GAP;
    }
    if (fx + p.w > endX - 0.3) {
      fx = floorStartX;
      fy += 3;
      lastFloorGroup = "";
    }
    p.gx = fx;
    p.gy = fy;
    lastFloorGroup = p.parentGroupId;
    fx += p.w + 0.8;
  }
}

function layoutRoomsGrid(rooms: RoomData[]) {
  if (rooms.length === 0) return;

  // Sort largest rooms first for better visual grouping
  rooms.sort((a, b) => b.totalItemCount - a.totalItemCount);

  const maxCols = rooms.length <= 4 ? 2 : 3;
  const gap = 6;
  const cols = Math.min(maxCols, rooms.length);
  const numRows = Math.ceil(rooms.length / cols);

  // Calculate max dimensions per row/col for alignment
  const rowMaxD = Array.from<number>({ length: numRows }).fill(0);
  const colMaxW = Array.from<number>({ length: cols }).fill(0);

  // r ∈ [0, numRows), c ∈ [0, cols); rowMaxD/colMaxW sized to exactly those
  for (let i = 0; i < rooms.length; i++) {
    const r = Math.floor(i / cols);
    const c = i % cols;
    rowMaxD[r] = Math.max(rowMaxD[r]!, rooms[i]!.roomD);
    colMaxW[c] = Math.max(colMaxW[c]!, rooms[i]!.roomW);
  }

  const rowY: number[] = [0];
  for (let r = 1; r < numRows; r++) {
    rowY.push(rowY[r - 1]! + rowMaxD[r - 1]! + gap);
  }
  const colX: number[] = [0];
  for (let c = 1; c < cols; c++) {
    colX.push(colX[c - 1]! + colMaxW[c - 1]! + gap);
  }

  for (let i = 0; i < rooms.length; i++) {
    const r = Math.floor(i / cols);
    const c = i % cols;
    rooms[i]!.originX = colX[c]!;
    rooms[i]!.originY = rowY[r]!;
  }
}

// ─── Camera ─────────────────────────────────────────────────────────────────

// ─── Hit Testing ────────────────────────────────────────────────────────────

function hitTestPieces(
  worldX: number,
  worldY: number,
  pieces: FurniturePiece[],
  cx: number,
  cy: number,
): HoverTarget | null {
  for (let pi = pieces.length - 1; pi >= 0; pi--) {
    const piece = pieces[pi]!; // guarded by pi >= 0 within pieces.length
    const maxPerShelf = Math.max(1, Math.floor((piece.w - 0.3) / 0.45));
    let itemIdx = 0;

    for (const level of piece.shelfLevels) {
      let col = 0;
      while (itemIdx < piece.items.length && col < maxPerShelf) {
        const item = piece.items[itemIdx]!; // guarded by itemIdx < piece.items.length
        const ix = piece.gx + 0.2 + col * 0.45;
        const iy = piece.gy + piece.d * 0.25;
        const shelfZ = piece.gz + level + 0.12;
        const itemH = getItemHeight(item.category);

        const tbl = toScreen(ix, iy, shelfZ + itemH, cx, cy);
        const tbr = toScreen(ix + 0.35, iy, shelfZ + itemH, cx, cy);
        const tfl = toScreen(ix, iy + 0.35, shelfZ + itemH, cx, cy);
        const rbf = toScreen(ix + 0.35, iy, shelfZ, cx, cy);
        const rff = toScreen(ix + 0.35, iy + 0.35, shelfZ, cx, cy);
        const lbf = toScreen(ix, iy + 0.35, shelfZ, cx, cy);

        const hitPoly = [tbl, tbr, rbf, rff, lbf, tfl];
        if (pointInPolygon(worldX, worldY, hitPoly)) {
          const breadcrumb = piece.path.join(" > ");
          return {
            type: "item",
            label: item.productName,
            detail: `${item.amount} — ${breadcrumb}`,
            screenX: 0,
            screenY: 0,
            locationId: piece.locationId,
            locationShortcode: piece.locationShortcode,
          };
        }
        itemIdx++;
        col++;
      }
      if (itemIdx >= piece.items.length) break;
    }

    // Furniture body hit test
    const ftl = toScreen(piece.gx, piece.gy, piece.gz + piece.h, cx, cy);
    const ftr = toScreen(
      piece.gx + piece.w,
      piece.gy,
      piece.gz + piece.h,
      cx,
      cy,
    );
    const fbr = toScreen(
      piece.gx + piece.w,
      piece.gy + piece.d,
      piece.gz + piece.h,
      cx,
      cy,
    );
    const fbl = toScreen(
      piece.gx,
      piece.gy + piece.d,
      piece.gz + piece.h,
      cx,
      cy,
    );
    const fbottom = toScreen(
      piece.gx + piece.w,
      piece.gy + piece.d,
      piece.gz,
      cx,
      cy,
    );
    const fbottomL = toScreen(piece.gx, piece.gy + piece.d, piece.gz, cx, cy);

    if (
      pointInPolygon(worldX, worldY, [ftl, ftr, fbr, fbottom, fbottomL, fbl])
    ) {
      const breadcrumb = piece.path.join(" > ");
      const valuationStr =
        piece.totalValuation > 0
          ? ` — ${formatCurrency(piece.totalValuation)}`
          : "";
      return {
        type: "furniture",
        label: piece.name,
        detail: `${breadcrumb} — ${piece.items.length} item${piece.items.length !== 1 ? "s" : ""}${valuationStr}`,
        screenX: 0,
        screenY: 0,
        locationId: piece.locationId,
        locationShortcode: piece.locationShortcode,
      };
    }
  }
  return null;
}

export function hitTestRooms(
  mouseX: number,
  mouseY: number,
  rooms: RoomData[],
  camera: Camera,
): HoverTarget | null {
  const worldX = (mouseX - camera.x) / camera.zoom;
  const worldY = (mouseY - camera.y) / camera.zoom;

  // Test in reverse depth order (front rooms first)
  const sorted = [...rooms].sort(
    (a, b) => b.originX + b.originY - (a.originX + a.originY),
  );

  for (const room of sorted) {
    const roomCx = (room.originX - room.originY) * (TILE_W / 2);
    const roomCy = (room.originX + room.originY) * (TILE_H / 2);

    const hit = hitTestPieces(worldX, worldY, room.pieces, roomCx, roomCy);
    if (hit) {
      hit.screenX = mouseX;
      hit.screenY = mouseY;
      return hit;
    }
  }
  return null;
}
