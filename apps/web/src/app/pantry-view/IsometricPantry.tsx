/**
 * Isometric Pantry Visualization
 *
 * ⚠️ HIGHLY EXPERIMENTAL — this ~2,000-line single-file canvas visualization is a
 * prototype. It is intentionally not refactored, not unit-tested, and may change
 * or be removed. Do not treat its internal structure as a pattern to copy.
 *
 * A 2D Canvas isometric view of the user's inventory, inspired by
 * https://github.com/amilich/isometric-city. Each top-level location in the
 * tree becomes a separate isometric room rendered with walls, a checkerboard
 * floor, and furniture pieces representing child locations (shelves, boxes,
 * cabinets, tables, etc.). Inventory items appear as colored cuboids on the
 * furniture, sized and colored by product category.
 *
 * ## Hierarchy mapping
 *
 *   Location tree              Visual representation
 *   ─────────────              ─────────────────────
 *   Top-level node (room)  →   Separate isometric room
 *   area/room children     →   Zones (colored floor overlay + label)
 *   Furniture-type children →  3D furniture (shelf, cabinet, box, table…)
 *   Inventory items         →  Colored cuboids on shelf levels
 *
 * Within each zone, furniture is clustered by its nearest container ancestor
 * (parent group) with extra spacing between groups. Group labels appear above
 * back-wall clusters when there are multiple groups.
 *
 * ## Data sources
 *
 * - `location.makeTree` — hierarchical location tree (`InfLocation[]`)
 * - `inventory.list` — flat inventory with product category and location
 *   (the tree's own `inventoryItems` lacks `category`, so we fetch separately)
 *
 * ## Camera & interaction
 *
 * - Pan: mouse drag
 * - Zoom: scroll wheel (zooms towards cursor)
 * - Hover: hit-test items and furniture, show tooltip with breadcrumb path
 * - Reset View button: zoom-to-fit all rooms
 *
 * ## Canvas sizing
 *
 * The canvas uses CSS `w-full h-full` for layout and reads `clientWidth` /
 * `clientHeight` for the buffer (scaled by devicePixelRatio). A ResizeObserver
 * triggers re-renders. Do NOT use inline `style` or the `size` state for
 * buffer dimensions — that causes aspect-ratio mismatch.
 *
 * ## Code structure
 *
 *   Constants → Types → Projection → Color Utilities → Drawing Primitives →
 *   Room Drawing → Furniture Drawing → Furniture Specs → Room Building →
 *   Layout → Camera → Hit Testing → Zone Drawing → Group Labels →
 *   Rendering → Tooltip → React Component
 */

import type { InfLocation } from "@cubby/schemas/location";
import {
  formatCategoryLabel,
  getCategoryColor,
  getLocationTypeColor,
  type LocationType,
  type ProductCategory,
  productCategoryValues,
} from "@cubby/shared";
import { useQuery } from "@tanstack/react-query";
import { Link, useNavigate } from "@tanstack/react-router";
import { ArrowLeft, Loader2, Maximize2 } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Button } from "~/components/ui/button";
import { useTRPC } from "~/trpc/react";

// ─── Constants ───────────────────────────────────────────────────────────────

const TILE_W = 56;
const TILE_H = 28;
const Z_STEP = 26;
const ROOM_H = 5;

const FLOOR_COLOR_1 = "hsl(30, 35%, 58%)";
const FLOOR_COLOR_2 = "hsl(30, 30%, 52%)";
const WALL_BACK_COLOR = "hsl(40, 25%, 88%)";
const WALL_LEFT_COLOR = "hsl(40, 22%, 82%)";
const BASEBOARD_COLOR = "hsl(25, 35%, 40%)";
const BG_COLOR = "#1a1d24";

const ZONE_OVERLAY_COLORS = [
  "rgba(100, 180, 255, 0.07)",
  "rgba(255, 180, 100, 0.07)",
  "rgba(100, 255, 180, 0.07)",
  "rgba(200, 130, 255, 0.07)",
  "rgba(255, 130, 130, 0.07)",
  "rgba(130, 255, 255, 0.07)",
];

const ZONE_LABEL_COLORS = [
  "rgba(130, 200, 255, 0.75)",
  "rgba(255, 200, 130, 0.75)",
  "rgba(130, 255, 200, 0.75)",
  "rgba(220, 160, 255, 0.75)",
  "rgba(255, 160, 160, 0.75)",
  "rgba(160, 255, 255, 0.75)",
];

const MIN_ZOOM = 0.08;
const MAX_ZOOM = 2.5;

// ─── Types ───────────────────────────────────────────────────────────────────

interface Point {
  x: number;
  y: number;
}

interface Camera {
  x: number;
  y: number;
  zoom: number;
}

interface FurnitureItem {
  productName: string;
  category: ProductCategory | null;
  amount: string;
  color: string;
  inventoryId: string;
  valuation: number | null;
}

interface FurniturePiece {
  gx: number;
  gy: number;
  gz: number;
  w: number;
  d: number;
  h: number;
  color: string;
  name: string;
  locationType: LocationType;
  locationId: string;
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

interface ZoneData {
  name: string;
  locationId: string;
  color: string;
  labelColor: string;
  startGx: number;
  endGx: number;
  pieces: FurniturePiece[];
  totalItemCount: number;
}

interface RoomData {
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

interface HoverTarget {
  type: "item" | "furniture";
  label: string;
  detail?: string;
  screenX: number;
  screenY: number;
  locationId: string;
}

// ─── Projection ──────────────────────────────────────────────────────────────

function toScreen(
  gx: number,
  gy: number,
  gz: number,
  cx: number,
  cy: number,
): Point {
  return {
    x: cx + (gx - gy) * (TILE_W / 2),
    y: cy + (gx + gy) * (TILE_H / 2) - gz * Z_STEP,
  };
}

// ─── Color Utilities ─────────────────────────────────────────────────────────

function parseHSL(hsl: string): [number, number, number] {
  const m = hsl.match(/hsl\((\d+),\s*(\d+)%,\s*(\d+)%\)/);
  if (!m) return [0, 0, 50];
  // m matched the 3-capture-group regex, so m[1..3] are present
  return [parseInt(m[1]!, 10), parseInt(m[2]!, 10), parseInt(m[3]!, 10)];
}

function makeHSL(h: number, s: number, l: number): string {
  return `hsl(${h}, ${s}%, ${l}%)`;
}

function adjustLight(hsl: string, delta: number): string {
  const [h, s, l] = parseHSL(hsl);
  return makeHSL(h, s, Math.max(0, Math.min(100, l + delta)));
}

// ─── Drawing Primitives ─────────────────────────────────────────────────────

function drawCuboid(
  ctx: CanvasRenderingContext2D,
  gx: number,
  gy: number,
  gz: number,
  w: number,
  d: number,
  h: number,
  color: string,
  cx: number,
  cy: number,
  strokeColor = "rgba(0,0,0,0.12)",
  highlight = false,
) {
  const topColor = highlight ? adjustLight(color, 12) : color;
  const leftColor = highlight
    ? adjustLight(color, -4)
    : adjustLight(color, -10);
  const rightColor = highlight
    ? adjustLight(color, -14)
    : adjustLight(color, -22);

  const rbf = toScreen(gx + w, gy, gz, cx, cy);
  const rff = toScreen(gx + w, gy + d, gz, cx, cy);
  const rft = toScreen(gx + w, gy + d, gz + h, cx, cy);
  const rbt = toScreen(gx + w, gy, gz + h, cx, cy);

  ctx.fillStyle = rightColor;
  ctx.strokeStyle = strokeColor;
  ctx.lineWidth = 0.5;
  ctx.beginPath();
  ctx.moveTo(rbf.x, rbf.y);
  ctx.lineTo(rff.x, rff.y);
  ctx.lineTo(rft.x, rft.y);
  ctx.lineTo(rbt.x, rbt.y);
  ctx.closePath();
  ctx.fill();
  ctx.stroke();

  const lbf = toScreen(gx, gy + d, gz, cx, cy);
  const lrf = toScreen(gx + w, gy + d, gz, cx, cy);
  const lrt = toScreen(gx + w, gy + d, gz + h, cx, cy);
  const lbt = toScreen(gx, gy + d, gz + h, cx, cy);

  ctx.fillStyle = leftColor;
  ctx.beginPath();
  ctx.moveTo(lbf.x, lbf.y);
  ctx.lineTo(lrf.x, lrf.y);
  ctx.lineTo(lrt.x, lrt.y);
  ctx.lineTo(lbt.x, lbt.y);
  ctx.closePath();
  ctx.fill();
  ctx.stroke();

  const tbl = toScreen(gx, gy, gz + h, cx, cy);
  const tbr = toScreen(gx + w, gy, gz + h, cx, cy);
  const tfr = toScreen(gx + w, gy + d, gz + h, cx, cy);
  const tfl = toScreen(gx, gy + d, gz + h, cx, cy);

  ctx.fillStyle = topColor;
  ctx.beginPath();
  ctx.moveTo(tbl.x, tbl.y);
  ctx.lineTo(tbr.x, tbr.y);
  ctx.lineTo(tfr.x, tfr.y);
  ctx.lineTo(tfl.x, tfl.y);
  ctx.closePath();
  ctx.fill();
  ctx.stroke();
}

// ─── Room Drawing (parameterized) ───────────────────────────────────────────

function drawFloor(
  ctx: CanvasRenderingContext2D,
  cx: number,
  cy: number,
  roomW: number,
  roomD: number,
) {
  for (let gx = 0; gx < roomW; gx++) {
    for (let gy = 0; gy < roomD; gy++) {
      const color = (gx + gy) % 2 === 0 ? FLOOR_COLOR_1 : FLOOR_COLOR_2;
      const tl = toScreen(gx, gy, 0, cx, cy);
      const tr = toScreen(gx + 1, gy, 0, cx, cy);
      const br = toScreen(gx + 1, gy + 1, 0, cx, cy);
      const bl = toScreen(gx, gy + 1, 0, cx, cy);
      ctx.fillStyle = color;
      ctx.strokeStyle = "rgba(0,0,0,0.06)";
      ctx.lineWidth = 0.5;
      ctx.beginPath();
      ctx.moveTo(tl.x, tl.y);
      ctx.lineTo(tr.x, tr.y);
      ctx.lineTo(br.x, br.y);
      ctx.lineTo(bl.x, bl.y);
      ctx.closePath();
      ctx.fill();
      ctx.stroke();
    }
  }
}

function drawWalls(
  ctx: CanvasRenderingContext2D,
  cx: number,
  cy: number,
  roomW: number,
  roomD: number,
) {
  // Back wall
  const bbl = toScreen(0, 0, 0, cx, cy);
  const bbr = toScreen(roomW, 0, 0, cx, cy);
  const btr = toScreen(roomW, 0, ROOM_H, cx, cy);
  const btl = toScreen(0, 0, ROOM_H, cx, cy);
  ctx.fillStyle = WALL_BACK_COLOR;
  ctx.strokeStyle = "rgba(0,0,0,0.08)";
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(bbl.x, bbl.y);
  ctx.lineTo(bbr.x, bbr.y);
  ctx.lineTo(btr.x, btr.y);
  ctx.lineTo(btl.x, btl.y);
  ctx.closePath();
  ctx.fill();
  ctx.stroke();

  // Back baseboard
  const bblt = toScreen(0, 0, 0.3, cx, cy);
  const bbrt = toScreen(roomW, 0, 0.3, cx, cy);
  ctx.fillStyle = BASEBOARD_COLOR;
  ctx.beginPath();
  ctx.moveTo(bbl.x, bbl.y);
  ctx.lineTo(bbr.x, bbr.y);
  ctx.lineTo(bbrt.x, bbrt.y);
  ctx.lineTo(bblt.x, bblt.y);
  ctx.closePath();
  ctx.fill();

  // Left wall
  const lbl = toScreen(0, 0, 0, cx, cy);
  const lbr = toScreen(0, roomD, 0, cx, cy);
  const ltr = toScreen(0, roomD, ROOM_H, cx, cy);
  const ltl = toScreen(0, 0, ROOM_H, cx, cy);
  ctx.fillStyle = WALL_LEFT_COLOR;
  ctx.strokeStyle = "rgba(0,0,0,0.08)";
  ctx.beginPath();
  ctx.moveTo(lbl.x, lbl.y);
  ctx.lineTo(lbr.x, lbr.y);
  ctx.lineTo(ltr.x, ltr.y);
  ctx.lineTo(ltl.x, ltl.y);
  ctx.closePath();
  ctx.fill();
  ctx.stroke();

  // Left baseboard
  const lbrt = toScreen(0, roomD, 0.3, cx, cy);
  ctx.fillStyle = adjustLight(BASEBOARD_COLOR, -5);
  ctx.beginPath();
  ctx.moveTo(lbl.x, lbl.y);
  ctx.lineTo(lbr.x, lbr.y);
  ctx.lineTo(lbrt.x, lbrt.y);
  ctx.lineTo(bblt.x, bblt.y);
  ctx.closePath();
  ctx.fill();
}

// ─── Furniture Drawing ──────────────────────────────────────────────────────

function drawShelfUnit(
  ctx: CanvasRenderingContext2D,
  piece: FurniturePiece,
  cx: number,
  cy: number,
  hoveredItem: string | null,
) {
  const { gx, gy, gz, w, d, h, color, shelfLevels } = piece;
  const panelThick = 0.12;
  drawCuboid(ctx, gx, gy, gz, panelThick, d, h, adjustLight(color, -5), cx, cy);
  drawCuboid(
    ctx,
    gx + w - panelThick,
    gy,
    gz,
    panelThick,
    d,
    h,
    adjustLight(color, -5),
    cx,
    cy,
  );
  for (const level of shelfLevels) {
    drawCuboid(
      ctx,
      gx + panelThick,
      gy,
      gz + level,
      w - panelThick * 2,
      d,
      0.1,
      color,
      cx,
      cy,
    );
  }
  drawCuboid(ctx, gx, gy, gz + h - 0.1, w, d, 0.1, color, cx, cy);
  drawItemsOnLevels(ctx, piece, cx, cy, hoveredItem);
}

function drawBoxContainer(
  ctx: CanvasRenderingContext2D,
  piece: FurniturePiece,
  cx: number,
  cy: number,
  hoveredItem: string | null,
) {
  const { gx, gy, gz, w, d, h, color } = piece;
  const wallThick = 0.1;
  drawCuboid(ctx, gx, gy, gz, w, d, wallThick, adjustLight(color, -8), cx, cy);
  drawCuboid(ctx, gx, gy, gz, w, wallThick, h, color, cx, cy);
  drawCuboid(ctx, gx, gy, gz, wallThick, d, h, adjustLight(color, -5), cx, cy);
  drawCuboid(
    ctx,
    gx + w - wallThick,
    gy,
    gz,
    wallThick,
    d,
    h,
    adjustLight(color, -12),
    cx,
    cy,
  );
  drawCuboid(
    ctx,
    gx,
    gy + d - wallThick,
    gz,
    w,
    wallThick,
    h * 0.6,
    adjustLight(color, -3),
    cx,
    cy,
  );
  drawItemsOnLevels(ctx, piece, cx, cy, hoveredItem);
}

function drawTableSurface(
  ctx: CanvasRenderingContext2D,
  piece: FurniturePiece,
  cx: number,
  cy: number,
  hoveredItem: string | null,
) {
  const { gx, gy, gz, w, d, h, color } = piece;
  const legW = 0.15;
  const legH = h - 0.12;
  const legColor = adjustLight(color, -15);
  drawCuboid(ctx, gx + 0.1, gy + 0.1, gz, legW, legW, legH, legColor, cx, cy);
  drawCuboid(
    ctx,
    gx + w - 0.25,
    gy + 0.1,
    gz,
    legW,
    legW,
    legH,
    legColor,
    cx,
    cy,
  );
  drawCuboid(
    ctx,
    gx + 0.1,
    gy + d - 0.25,
    gz,
    legW,
    legW,
    legH,
    legColor,
    cx,
    cy,
  );
  drawCuboid(
    ctx,
    gx + w - 0.25,
    gy + d - 0.25,
    gz,
    legW,
    legW,
    legH,
    legColor,
    cx,
    cy,
  );
  drawCuboid(ctx, gx, gy, gz + h - 0.12, w, d, 0.12, color, cx, cy);
  drawItemsOnLevels(ctx, piece, cx, cy, hoveredItem);
}

function drawCabinetUnit(
  ctx: CanvasRenderingContext2D,
  piece: FurniturePiece,
  cx: number,
  cy: number,
  hoveredItem: string | null,
) {
  const { gx, gy, gz, w, d, h, color } = piece;
  drawCuboid(ctx, gx, gy, gz, w, d * 0.15, h, adjustLight(color, -8), cx, cy);
  drawCuboid(ctx, gx, gy, gz, 0.12, d, h, adjustLight(color, -3), cx, cy);
  drawCuboid(
    ctx,
    gx + w - 0.12,
    gy,
    gz,
    0.12,
    d,
    h,
    adjustLight(color, -10),
    cx,
    cy,
  );
  drawCuboid(ctx, gx, gy, gz + h - 0.1, w, d, 0.1, color, cx, cy);
  drawCuboid(ctx, gx, gy, gz, w, d, 0.1, adjustLight(color, -12), cx, cy);
  const doorW = w * 0.42;
  const doorH = h - 0.4;
  const doorGap = 0.04;
  drawCuboid(
    ctx,
    gx + 0.15,
    gy + d - 0.08,
    gz + 0.2,
    doorW - doorGap,
    0.08,
    doorH,
    adjustLight(color, 6),
    cx,
    cy,
  );
  drawCuboid(
    ctx,
    gx + 0.15 + doorW + doorGap,
    gy + d - 0.08,
    gz + 0.2,
    doorW - doorGap,
    0.08,
    doorH,
    adjustLight(color, 4),
    cx,
    cy,
  );
  drawItemsOnLevels(ctx, piece, cx, cy, hoveredItem);
}

function drawItemsOnLevels(
  ctx: CanvasRenderingContext2D,
  piece: FurniturePiece,
  cx: number,
  cy: number,
  hoveredItem: string | null,
) {
  const { gx, gy, gz, w, d, shelfLevels, items } = piece;
  if (items.length === 0) return;

  const maxPerShelf = Math.max(1, Math.floor((w - 0.3) / 0.45));
  let itemIdx = 0;

  for (const level of shelfLevels) {
    const shelfZ = gz + level + 0.12;
    let col = 0;
    while (itemIdx < items.length && col < maxPerShelf) {
      const item = items[itemIdx]!; // guarded by itemIdx < items.length
      const ix = gx + 0.2 + col * 0.45;
      const iy = gy + d * 0.25;
      const itemH = getItemHeight(item.category);
      const isHovered = hoveredItem === item.inventoryId;
      drawCuboid(
        ctx,
        ix,
        iy,
        shelfZ,
        0.35,
        0.35,
        itemH,
        item.color,
        cx,
        cy,
        "rgba(0,0,0,0.18)",
        isHovered,
      );
      itemIdx++;
      col++;
    }
    if (itemIdx >= items.length) break;
  }

  if (itemIdx < items.length) {
    const remaining = items.length - itemIdx;
    const lastLevel = shelfLevels[shelfLevels.length - 1] ?? 0;
    const p = toScreen(gx + w / 2, gy + d + 0.3, gz + lastLevel + 1, cx, cy);
    ctx.fillStyle = "rgba(0,0,0,0.6)";
    ctx.font = "bold 11px system-ui, sans-serif";
    ctx.textAlign = "center";
    ctx.fillText(`+${remaining} more`, p.x, p.y);
  }
}

function drawFloorShadow(
  ctx: CanvasRenderingContext2D,
  piece: FurniturePiece,
  cx: number,
  cy: number,
) {
  const off = 0.3;
  const tl = toScreen(piece.gx + off, piece.gy + off, 0, cx, cy);
  const tr = toScreen(piece.gx + piece.w + off, piece.gy + off, 0, cx, cy);
  const br = toScreen(
    piece.gx + piece.w + off,
    piece.gy + piece.d + off,
    0,
    cx,
    cy,
  );
  const bl = toScreen(piece.gx + off, piece.gy + piece.d + off, 0, cx, cy);
  ctx.fillStyle = "rgba(0,0,0,0.12)";
  ctx.beginPath();
  ctx.moveTo(tl.x, tl.y);
  ctx.lineTo(tr.x, tr.y);
  ctx.lineTo(br.x, br.y);
  ctx.lineTo(bl.x, bl.y);
  ctx.closePath();
  ctx.fill();
}

// ─── Furniture Specs ────────────────────────────────────────────────────────

interface FurnitureSpec {
  w: number;
  d: number;
  h: number;
  zone: "back-wall" | "left-wall" | "floor";
  shelfLevels: number[];
}

function getFurnitureSpec(type: LocationType): FurnitureSpec {
  switch (type) {
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
    case "crate":
    case "half-crate":
    case "quarter-crate":
    case "milk-crate":
    case "tote-bin":
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

function getDrawFunction(type: LocationType) {
  switch (type) {
    case "shelf":
      return drawShelfUnit;
    case "cabinet":
    case "drawer":
      return drawCabinetUnit;
    case "table":
    case "cart":
      return drawTableSurface;
    case "box":
    case "crate":
    case "half-crate":
    case "quarter-crate":
    case "milk-crate":
    case "tote-bin":
    case "bag":
      return drawBoxContainer;
    default:
      return drawShelfUnit;
  }
}

function getItemHeight(category: ProductCategory | null): number {
  switch (category) {
    case "food":
      return 0.5;
    case "tools":
      return 0.65;
    case "electronics":
      return 0.3;
    case "hardware":
      return 0.4;
    case "storage":
      return 0.5;
    case "tool-consumables":
      return 0.35;
    case "tool-accessories":
      return 0.45;
    case "household":
      return 0.45;
    case "supplies":
      return 0.38;
    default:
      return 0.4;
  }
}

// ─── Room Building ──────────────────────────────────────────────────────────

interface InventoryData {
  id: string;
  amount: { value: number; unit: string };
  valuation: number | null;
  product: { name: string; category: ProductCategory | null };
  location: { id: string; name: string; type: LocationType };
}

function isContainerType(type: LocationType): boolean {
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
      const totalValuation = items.reduce(
        (sum, it) => sum + (it.valuation ?? 0),
        0,
      );
      pieces.push({
        gx: 0,
        gy: 0,
        gz: 0,
        w: spec.w,
        d: spec.d,
        h: spec.h,
        color: getLocationTypeColor(node.type),
        name: node.name,
        locationType: node.type,
        locationId: node.id,
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
  const backWallWidth = backWall.reduce((sum, p) => sum + p.w + 0.8, 1);
  const floorCols = Math.max(1, Math.ceil(Math.sqrt(floorPieces.length)));
  return Math.max(4, Math.ceil(backWallWidth) + 1, floorCols * 3 + 2);
}

function buildRooms(
  tree: InfLocation[],
  inventory: InventoryData[],
): RoomData[] {
  const itemsByLocation = new Map<string, FurnitureItem[]>();
  for (const inv of inventory) {
    const locId = inv.location.id;
    if (!itemsByLocation.has(locId)) itemsByLocation.set(locId, []);
    itemsByLocation.get(locId)!.push({
      productName: inv.product.name,
      category: inv.product.category,
      amount: `${inv.amount.value} ${inv.amount.unit}`,
      color: getCategoryColor(inv.product.category),
      inventoryId: inv.id,
      valuation: inv.valuation,
    });
  }

  const rooms: RoomData[] = [];

  for (const rootNode of tree) {
    const zones: ZoneData[] = [];

    // Separate immediate children into container types (zones) vs furniture
    const zoneContainers: InfLocation[] = [];
    const directFurniture: InfLocation[] = [];
    for (const child of rootNode.children ?? []) {
      if (isContainerType(child.type)) {
        zoneContainers.push(child);
      } else {
        directFurniture.push(child);
      }
    }

    // Create a zone for each container child (area/room)
    for (const [zi, container] of zoneContainers.entries()) {
      const zonePath = [rootNode.name, container.name];
      const pieces = collectPiecesFromSubtree(
        container,
        itemsByLocation,
        zonePath,
      );

      // Items directly at the container level
      const containerItems = itemsByLocation.get(container.id) ?? [];
      if (containerItems.length > 0) {
        const spec = getFurnitureSpec("table");
        const totalValuation = containerItems.reduce(
          (sum, it) => sum + (it.valuation ?? 0),
          0,
        );
        pieces.push({
          gx: 0,
          gy: 0,
          gz: 0,
          w: spec.w,
          d: spec.d,
          h: spec.h,
          color: getLocationTypeColor(container.type),
          name: `${container.name} (items)`,
          locationType: "table",
          locationId: container.id,
          items: containerItems,
          shelfLevels: spec.shelfLevels,
          path: zonePath,
          parentGroupId: container.id,
          parentGroupName: container.name,
          isEmpty: false,
          totalValuation,
        });
      }

      // Skip zones with no pieces, or zones where ALL pieces are empty ghosts
      if (pieces.length === 0 || pieces.every((p) => p.isEmpty)) continue;

      let totalItems = 0;
      for (const p of pieces) totalItems += p.items.length;

      zones.push({
        name: container.name,
        locationId: container.id,
        // modulo into a non-empty const array is always in-bounds
        color: ZONE_OVERLAY_COLORS[zi % ZONE_OVERLAY_COLORS.length]!,
        labelColor: ZONE_LABEL_COLORS[zi % ZONE_LABEL_COLORS.length]!,
        startGx: 0,
        endGx: 0,
        pieces,
        totalItemCount: totalItems,
      });
    }

    // Default zone: direct furniture children + room-level items
    const defaultPieces: FurniturePiece[] = [];
    for (const child of directFurniture) {
      // Create a synthetic root for this child subtree
      const childPieces = collectPiecesFromSubtree(child, itemsByLocation, [
        rootNode.name,
        child.name,
      ]);
      // Also include the child itself if it has items (or as ghost furniture)
      const childItems = itemsByLocation.get(child.id) ?? [];
      if (!isContainerType(child.type)) {
        const spec = getFurnitureSpec(child.type);
        const totalValuation = childItems.reduce(
          (sum, it) => sum + (it.valuation ?? 0),
          0,
        );
        childPieces.push({
          gx: 0,
          gy: 0,
          gz: 0,
          w: spec.w,
          d: spec.d,
          h: spec.h,
          color: getLocationTypeColor(child.type),
          name: child.name,
          locationType: child.type,
          locationId: child.id,
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
      const totalValuation = roomDirectItems.reduce(
        (sum, it) => sum + (it.valuation ?? 0),
        0,
      );
      defaultPieces.push({
        gx: 0,
        gy: 0,
        gz: 0,
        w: spec.w,
        d: spec.d,
        h: spec.h,
        color: getLocationTypeColor(rootNode.type),
        name: `${rootNode.name} (direct)`,
        locationType: "table",
        locationId: rootNode.id,
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
    const totalZoneWidth = zoneWidths.reduce((sum, w) => sum + w, 0);
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
  const rowMaxD: number[] = new Array(numRows).fill(0);
  const colMaxW: number[] = new Array(cols).fill(0);

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

function calculateZoomToFit(
  rooms: RoomData[],
  canvasW: number,
  canvasH: number,
): Camera {
  if (rooms.length === 0) return { x: canvasW / 2, y: canvasH / 2, zoom: 1 };

  let minX = Infinity,
    maxX = -Infinity,
    minY = Infinity,
    maxY = -Infinity;

  for (const room of rooms) {
    const corners = [
      toScreen(room.originX, room.originY, 0, 0, 0),
      toScreen(room.originX + room.roomW, room.originY, 0, 0, 0),
      toScreen(room.originX, room.originY + room.roomD, 0, 0, 0),
      toScreen(room.originX + room.roomW, room.originY + room.roomD, 0, 0, 0),
      toScreen(room.originX, room.originY, ROOM_H, 0, 0),
      toScreen(room.originX + room.roomW, room.originY, ROOM_H, 0, 0),
      toScreen(room.originX, room.originY + room.roomD, ROOM_H, 0, 0),
      toScreen(
        room.originX + room.roomW,
        room.originY + room.roomD,
        ROOM_H,
        0,
        0,
      ),
    ];
    for (const c of corners) {
      minX = Math.min(minX, c.x);
      maxX = Math.max(maxX, c.x);
      minY = Math.min(minY, c.y);
      maxY = Math.max(maxY, c.y);
    }
  }

  const sceneW = maxX - minX;
  const sceneH = maxY - minY;
  const padding = 120;

  const zoom = Math.max(
    MIN_ZOOM,
    Math.min(
      MAX_ZOOM,
      Math.min((canvasW - padding) / sceneW, (canvasH - padding) / sceneH),
    ),
  );

  const sceneCenterX = (minX + maxX) / 2;
  const sceneCenterY = (minY + maxY) / 2;

  return {
    x: canvasW / 2 - sceneCenterX * zoom,
    y: canvasH / 2 - sceneCenterY * zoom,
    zoom,
  };
}

// ─── Hit Testing ────────────────────────────────────────────────────────────

function pointInPolygon(px: number, py: number, corners: Point[]): boolean {
  let inside = false;
  for (let i = 0, j = corners.length - 1; i < corners.length; j = i++) {
    // i < length and j is a prior i (or length-1), both in-bounds
    const xi = corners[i]!.x,
      yi = corners[i]!.y;
    const xj = corners[j]!.x,
      yj = corners[j]!.y;
    const intersect =
      yi > py !== yj > py && px < ((xj - xi) * (py - yi)) / (yj - yi) + xi;
    if (intersect) inside = !inside;
  }
  return inside;
}

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
          ? ` — $${piece.totalValuation.toFixed(2)}`
          : "";
      return {
        type: "furniture",
        label: piece.name,
        detail: `${breadcrumb} — ${piece.items.length} item${piece.items.length !== 1 ? "s" : ""}${valuationStr}`,
        screenX: 0,
        screenY: 0,
        locationId: piece.locationId,
      };
    }
  }
  return null;
}

function hitTestRooms(
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

// ─── Zone Drawing ───────────────────────────────────────────────────────────

function drawZoneOverlay(
  ctx: CanvasRenderingContext2D,
  zone: ZoneData,
  cx: number,
  cy: number,
  roomD: number,
) {
  if (zone.color === "transparent") return;

  const tl = toScreen(zone.startGx, 0, 0.01, cx, cy);
  const tr = toScreen(zone.endGx, 0, 0.01, cx, cy);
  const br = toScreen(zone.endGx, roomD, 0.01, cx, cy);
  const bl = toScreen(zone.startGx, roomD, 0.01, cx, cy);

  ctx.fillStyle = zone.color;
  ctx.beginPath();
  ctx.moveTo(tl.x, tl.y);
  ctx.lineTo(tr.x, tr.y);
  ctx.lineTo(br.x, br.y);
  ctx.lineTo(bl.x, bl.y);
  ctx.closePath();
  ctx.fill();
}

function drawZoneDivider(
  ctx: CanvasRenderingContext2D,
  gx: number,
  cx: number,
  cy: number,
  roomD: number,
) {
  const top = toScreen(gx, 0, 0.02, cx, cy);
  const bottom = toScreen(gx, roomD, 0.02, cx, cy);

  ctx.strokeStyle = "rgba(255, 255, 255, 0.12)";
  ctx.lineWidth = 1.5;
  ctx.setLineDash([6, 4]);
  ctx.beginPath();
  ctx.moveTo(top.x, top.y);
  ctx.lineTo(bottom.x, bottom.y);
  ctx.stroke();
  ctx.setLineDash([]);
}

// ─── Group Labels ────────────────────────────────────────────────────────────

function drawGroupLabels(
  ctx: CanvasRenderingContext2D,
  pieces: FurniturePiece[],
  cx: number,
  cy: number,
) {
  // Collect groups: find the bounding X range and name for each distinct parentGroupId
  const groups = new Map<
    string,
    { name: string; minGx: number; maxGx: number; maxW: number }
  >();

  for (const p of pieces) {
    // Only label back-wall pieces (those near y=0.3)
    if (p.gy > 1) continue;
    const existing = groups.get(p.parentGroupId);
    if (existing) {
      existing.minGx = Math.min(existing.minGx, p.gx);
      existing.maxGx = Math.max(existing.maxGx, p.gx);
      existing.maxW = Math.max(existing.maxW, p.w);
    } else {
      groups.set(p.parentGroupId, {
        name: p.parentGroupName,
        minGx: p.gx,
        maxGx: p.gx,
        maxW: p.w,
      });
    }
  }

  // Only draw group labels when there are multiple distinct groups
  if (groups.size <= 1) return;

  for (const group of groups.values()) {
    const centerGx = (group.minGx + group.maxGx + group.maxW) / 2;
    const labelPos = toScreen(centerGx, -0.3, ROOM_H + 0.3, cx, cy);

    ctx.font = "9px system-ui, sans-serif";
    ctx.fillStyle = "rgba(255, 255, 255, 0.35)";
    ctx.textAlign = "center";
    ctx.textBaseline = "bottom";
    ctx.fillText(group.name, labelPos.x, labelPos.y);
  }
}

// ─── Valuation Heat ─────────────────────────────────────────────────────────

function getValuationTint(
  totalValuation: number,
  maxValuation: number,
): string | null {
  if (totalValuation <= 0 || maxValuation <= 0) return null;
  // sqrt normalization for perceptually even distribution
  const t = Math.sqrt(totalValuation / maxValuation);
  // amber (40, 100%, 50%) → red (0, 100%, 45%) scale
  const h = 40 - t * 40;
  const l = 50 - t * 5;
  const a = 0.15 + t * 0.25;
  return `hsla(${h}, 100%, ${l}%, ${a})`;
}

function drawValuationOverlay(
  ctx: CanvasRenderingContext2D,
  piece: FurniturePiece,
  cx: number,
  cy: number,
  tint: string,
) {
  const { gx, gy, w, d, h, gz } = piece;
  const tbl = toScreen(gx, gy, gz + h, cx, cy);
  const tbr = toScreen(gx + w, gy, gz + h, cx, cy);
  const tfr = toScreen(gx + w, gy + d, gz + h, cx, cy);
  const tfl = toScreen(gx, gy + d, gz + h, cx, cy);

  ctx.fillStyle = tint;
  ctx.beginPath();
  ctx.moveTo(tbl.x, tbl.y);
  ctx.lineTo(tbr.x, tbr.y);
  ctx.lineTo(tfr.x, tfr.y);
  ctx.lineTo(tfl.x, tfl.y);
  ctx.closePath();
  ctx.fill();
}

// ─── Rendering ──────────────────────────────────────────────────────────────

function renderScene(
  ctx: CanvasRenderingContext2D,
  canvasW: number,
  canvasH: number,
  rooms: RoomData[],
  camera: Camera,
  hoveredItemId: string | null,
) {
  ctx.fillStyle = BG_COLOR;
  ctx.fillRect(0, 0, canvasW, canvasH);

  ctx.save();
  ctx.translate(camera.x, camera.y);
  ctx.scale(camera.zoom, camera.zoom);

  // Sort rooms by depth (back to front)
  const sortedRooms = [...rooms].sort(
    (a, b) => a.originX + a.originY - (b.originX + b.originY),
  );

  for (const room of sortedRooms) {
    const roomCx = (room.originX - room.originY) * (TILE_W / 2);
    const roomCy = (room.originX + room.originY) * (TILE_H / 2);

    drawFloor(ctx, roomCx, roomCy, room.roomW, room.roomD);
    drawWalls(ctx, roomCx, roomCy, room.roomW, room.roomD);

    // Zone overlays and dividers (after floor, before furniture)
    if (
      room.zones.length > 1 ||
      (room.zones.length === 1 && room.zones[0]!.name)
    ) {
      for (const zone of room.zones) {
        drawZoneOverlay(ctx, zone, roomCx, roomCy, room.roomD);
      }
      // Draw dividers between zones
      for (let i = 1; i < room.zones.length; i++) {
        const dividerX =
          (room.zones[i - 1]!.endGx + room.zones[i]!.startGx) / 2;
        drawZoneDivider(ctx, dividerX, roomCx, roomCy, room.roomD);
      }
    }

    // Sort furniture by depth within room
    const sortedPieces = [...room.pieces].sort((a, b) => {
      const dA = a.gx + a.gy;
      const dB = b.gx + b.gy;
      return dA !== dB ? dA - dB : a.gz - b.gz;
    });

    // Draw group labels on back wall (subtle, above furniture groups)
    drawGroupLabels(ctx, sortedPieces, roomCx, roomCy);

    // Compute max valuation for heat tinting across all pieces in the scene
    let maxValuation = 0;
    for (const piece of sortedPieces) {
      if (piece.totalValuation > maxValuation)
        maxValuation = piece.totalValuation;
    }

    for (const piece of sortedPieces) {
      // Ghost pieces rendered translucently
      if (piece.isEmpty) ctx.globalAlpha = 0.25;

      drawFloorShadow(ctx, piece, roomCx, roomCy);
      const drawFn = getDrawFunction(piece.locationType);
      drawFn(ctx, piece, roomCx, roomCy, hoveredItemId);

      // Valuation heat overlay on furniture top face
      const tint = getValuationTint(piece.totalValuation, maxValuation);
      if (tint) drawValuationOverlay(ctx, piece, roomCx, roomCy, tint);

      if (piece.isEmpty) ctx.globalAlpha = 1.0;
    }
  }

  ctx.restore();

  // Room titles in screen space (always readable)
  for (const room of sortedRooms) {
    const titleWorld = toScreen(
      room.originX + room.roomW / 2,
      room.originY,
      ROOM_H + 0.8,
      0,
      0,
    );
    const sx = titleWorld.x * camera.zoom + camera.x;
    const sy = titleWorld.y * camera.zoom + camera.y;

    ctx.font = "bold 13px system-ui, sans-serif";
    ctx.fillStyle = "rgba(255,255,255,0.85)";
    ctx.textAlign = "center";
    ctx.textBaseline = "bottom";
    ctx.fillText(room.name, sx, sy);

    ctx.font = "11px system-ui, sans-serif";
    ctx.fillStyle = "rgba(255,255,255,0.4)";
    ctx.fillText(
      `${room.totalItemCount} item${room.totalItemCount !== 1 ? "s" : ""}`,
      sx,
      sy + 14,
    );

    // Zone labels at the front edge of each zone
    if (
      room.zones.length > 1 ||
      (room.zones.length === 1 && room.zones[0]!.name)
    ) {
      for (const zone of room.zones) {
        if (!zone.name) continue;
        const midX = (zone.startGx + zone.endGx) / 2;
        const labelWorld = toScreen(
          room.originX + midX,
          room.originY + room.roomD + 0.5,
          0,
          0,
          0,
        );
        const lx = labelWorld.x * camera.zoom + camera.x;
        const ly = labelWorld.y * camera.zoom + camera.y;

        ctx.font = "10px system-ui, sans-serif";
        ctx.fillStyle = zone.labelColor;
        ctx.textAlign = "center";
        ctx.textBaseline = "top";
        ctx.fillText(zone.name, lx, ly);

        ctx.font = "9px system-ui, sans-serif";
        ctx.fillStyle = zone.labelColor.replace("0.75", "0.45");
        ctx.fillText(
          `${zone.totalItemCount} item${zone.totalItemCount !== 1 ? "s" : ""}`,
          lx,
          ly + 12,
        );
      }
    }
  }
}

function drawTooltip(
  ctx: CanvasRenderingContext2D,
  target: HoverTarget,
  canvasW: number,
) {
  const padding = 10;
  const lineHeight = 18;
  ctx.font = "bold 12px system-ui, sans-serif";
  const labelW = ctx.measureText(target.label).width;
  ctx.font = "11px system-ui, sans-serif";
  const detailW = target.detail ? ctx.measureText(target.detail).width : 0;
  const boxW = Math.max(labelW, detailW) + padding * 2;
  const boxH = (target.detail ? 2 : 1) * lineHeight + padding * 1.5;

  let tx = target.screenX + 14;
  let ty = target.screenY - boxH - 8;
  if (tx + boxW > canvasW - 10) tx = target.screenX - boxW - 14;
  if (ty < 10) ty = target.screenY + 14;

  ctx.shadowColor = "rgba(0,0,0,0.3)";
  ctx.shadowBlur = 8;
  ctx.shadowOffsetY = 2;
  ctx.fillStyle = "rgba(15, 18, 25, 0.92)";
  ctx.beginPath();
  ctx.roundRect(tx, ty, boxW, boxH, 6);
  ctx.fill();
  ctx.shadowColor = "transparent";
  ctx.shadowBlur = 0;
  ctx.shadowOffsetY = 0;

  ctx.strokeStyle = "rgba(255,255,255,0.1)";
  ctx.lineWidth = 1;
  ctx.stroke();

  ctx.fillStyle = "#fff";
  ctx.font = "bold 12px system-ui, sans-serif";
  ctx.textAlign = "left";
  ctx.textBaseline = "top";
  ctx.fillText(target.label, tx + padding, ty + padding);

  if (target.detail) {
    ctx.fillStyle = "rgba(255,255,255,0.6)";
    ctx.font = "11px system-ui, sans-serif";
    ctx.fillText(target.detail, tx + padding, ty + padding + lineHeight);
  }
}

function drawTitle(
  ctx: CanvasRenderingContext2D,
  canvasW: number,
  totalItems: number,
  totalRooms: number,
) {
  ctx.fillStyle = "rgba(255,255,255,0.85)";
  ctx.font = "bold 20px system-ui, sans-serif";
  ctx.textAlign = "right";
  ctx.textBaseline = "top";
  ctx.fillText("Isometric Pantry", canvasW - 24, 20);

  ctx.fillStyle = "rgba(255,255,255,0.45)";
  ctx.font = "12px system-ui, sans-serif";
  ctx.fillText(
    `${totalItems} item${totalItems !== 1 ? "s" : ""} in ${totalRooms} room${totalRooms !== 1 ? "s" : ""}`,
    canvasW - 24,
    46,
  );
}

// ─── Category Legend ─────────────────────────────────────────────────────────

function CategoryLegend() {
  return (
    <div className="absolute bottom-4 left-4 rounded-lg bg-black/70 px-3 py-2 backdrop-blur-sm">
      <div className="grid grid-cols-2 gap-x-4 gap-y-1">
        {productCategoryValues.map((cat) => (
          <div key={cat} className="flex items-center gap-1.5">
            <div
              className="h-2.5 w-2.5 shrink-0 rounded-sm"
              style={{ backgroundColor: getCategoryColor(cat) }}
            />
            <span className="text-2xs text-white/60 leading-none">
              {formatCategoryLabel(cat)}
            </span>
          </div>
        ))}
        <div className="flex items-center gap-1.5">
          <div
            className="h-2.5 w-2.5 shrink-0 rounded-sm"
            style={{ backgroundColor: getCategoryColor(null) }}
          />
          <span className="text-2xs text-white/60 leading-none">
            uncategorized
          </span>
        </div>
      </div>
    </div>
  );
}

// ─── React Component ────────────────────────────────────────────────────────

export function IsometricPantry() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const navigate = useNavigate();
  const [size, setSize] = useState({ w: 800, h: 600 });
  const [hoverTarget, setHoverTarget] = useState<HoverTarget | null>(null);
  const [camera, setCamera] = useState<Camera | null>(null);
  const [isDragging, setIsDragging] = useState(false);
  const dragRef = useRef({ startX: 0, startY: 0, camX: 0, camY: 0 });
  const touchRef = useRef({
    lastTouchX: 0,
    lastTouchY: 0,
    startTouchX: 0,
    startTouchY: 0,
    lastPinchDist: 0,
    isTouching: false,
    touchMoved: false,
  });
  const cameraRef = useRef<Camera | null>(null);
  const roomsRef = useRef<RoomData[]>([]);

  const api = useTRPC();

  const treeQuery = useQuery(api.location.makeTree.queryOptions());

  const inventoryQuery = useQuery(
    api.inventory.list.queryOptions({
      sort: { orderBy: "createdAt", direction: "desc" },
      pagination: { pageIndex: 0, pageSize: 5000 },
      filters: {},
    }),
  );

  const inventory = useMemo(() => {
    const items = inventoryQuery.data?.items;
    if (!items) return [];
    return items as unknown as InventoryData[];
  }, [inventoryQuery.data]);

  const rooms = useMemo(() => {
    const tree = treeQuery.data;
    if (!tree || tree.length === 0) return [];
    return buildRooms(tree, inventory);
  }, [treeQuery.data, inventory]);

  // Auto-fit camera on first data load (uses real container dimensions)
  // biome-ignore lint/correctness/useExhaustiveDependencies: size triggers re-run on resize
  useEffect(() => {
    if (rooms.length > 0 && camera === null) {
      const container = containerRef.current;
      if (!container) return;
      const w = container.clientWidth;
      const h = container.clientHeight;
      if (w > 0 && h > 0) {
        setCamera(calculateZoomToFit(rooms, w, h));
      }
    }
  }, [rooms, size, camera]);

  // Resize observer
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    const observer = new ResizeObserver((entries) => {
      const entry = entries[0];
      if (entry) {
        setSize({ w: entry.contentRect.width, h: entry.contentRect.height });
      }
    });
    observer.observe(container);
    return () => observer.disconnect();
  }, []);

  // Canvas render — always use the canvas's actual CSS display size for the buffer
  // biome-ignore lint/correctness/useExhaustiveDependencies: size triggers re-run on resize
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !camera) return;

    const dpr = window.devicePixelRatio || 1;
    const displayW = canvas.clientWidth;
    const displayH = canvas.clientHeight;
    if (displayW === 0 || displayH === 0) return;

    canvas.width = displayW * dpr;
    canvas.height = displayH * dpr;

    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    ctx.scale(dpr, dpr);

    renderScene(ctx, displayW, displayH, rooms, camera, null);
    drawTitle(ctx, displayW, inventory.length, rooms.length);

    if (hoverTarget) {
      drawTooltip(ctx, hoverTarget, displayW);
    }
  }, [size, rooms, camera, inventory.length, hoverTarget]);

  // Wheel zoom (towards cursor)
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const handleWheel = (e: WheelEvent) => {
      e.preventDefault();
      setCamera((prev) => {
        if (!prev) return prev;
        const rect = canvas.getBoundingClientRect();
        const mouseX = e.clientX - rect.left;
        const mouseY = e.clientY - rect.top;
        const factor = e.deltaY > 0 ? 0.9 : 1.1;
        const newZoom = Math.max(
          MIN_ZOOM,
          Math.min(MAX_ZOOM, prev.zoom * factor),
        );
        const dx = mouseX - prev.x;
        const dy = mouseY - prev.y;
        const scale = newZoom / prev.zoom;
        return {
          x: mouseX - dx * scale,
          y: mouseY - dy * scale,
          zoom: newZoom,
        };
      });
    };

    canvas.addEventListener("wheel", handleWheel, { passive: false });
    return () => canvas.removeEventListener("wheel", handleWheel);
  }, []);

  // Sync refs so touch handlers can read current values without dependencies
  useEffect(() => {
    cameraRef.current = camera;
  }, [camera]);
  useEffect(() => {
    roomsRef.current = rooms;
  }, [rooms]);

  // Touch support (iOS PWA)
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    function getPinchDist(e: TouchEvent): number {
      // only called when e.touches.length === 2
      const [a, b] = [e.touches[0]!, e.touches[1]!];
      return Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY);
    }

    function handleTouchStart(e: TouchEvent) {
      e.preventDefault();
      const t = touchRef.current;
      if (e.touches.length === 1) {
        const touch = e.touches[0]!;
        t.lastTouchX = touch.clientX;
        t.lastTouchY = touch.clientY;
        t.startTouchX = touch.clientX;
        t.startTouchY = touch.clientY;
        t.isTouching = true;
        t.touchMoved = false;
      } else if (e.touches.length === 2) {
        t.lastPinchDist = getPinchDist(e);
        // Track midpoint for panning during pinch (length === 2 guaranteed here)
        t.lastTouchX = (e.touches[0]!.clientX + e.touches[1]!.clientX) / 2;
        t.lastTouchY = (e.touches[0]!.clientY + e.touches[1]!.clientY) / 2;
        t.touchMoved = true; // pinch is always a "move"
      }
    }

    function handleTouchMove(e: TouchEvent) {
      e.preventDefault();
      const t = touchRef.current;
      const cam = cameraRef.current;
      if (!cam) return;

      if (e.touches.length === 1 && t.isTouching) {
        const touch = e.touches[0]!;
        const dx = touch.clientX - t.lastTouchX;
        const dy = touch.clientY - t.lastTouchY;
        t.lastTouchX = touch.clientX;
        t.lastTouchY = touch.clientY;
        if (
          Math.abs(touch.clientX - t.startTouchX) > 5 ||
          Math.abs(touch.clientY - t.startTouchY) > 5
        ) {
          t.touchMoved = true;
        }
        setCamera((prev) =>
          prev ? { ...prev, x: prev.x + dx, y: prev.y + dy } : prev,
        );
      } else if (e.touches.length === 2) {
        const newDist = getPinchDist(e);
        const midX = (e.touches[0]!.clientX + e.touches[1]!.clientX) / 2;
        const midY = (e.touches[0]!.clientY + e.touches[1]!.clientY) / 2;
        const rect = canvas!.getBoundingClientRect();
        const canvasX = midX - rect.left;
        const canvasY = midY - rect.top;

        if (t.lastPinchDist > 0) {
          const ratio = newDist / t.lastPinchDist;
          setCamera((prev) => {
            if (!prev) return prev;
            const newZoom = Math.max(
              MIN_ZOOM,
              Math.min(MAX_ZOOM, prev.zoom * ratio),
            );
            const dx = canvasX - prev.x;
            const dy = canvasY - prev.y;
            const scale = newZoom / prev.zoom;
            return {
              x: canvasX - dx * scale,
              y: canvasY - dy * scale,
              zoom: newZoom,
            };
          });
        }

        t.lastPinchDist = newDist;
        t.lastTouchX = midX;
        t.lastTouchY = midY;
      }
    }

    function handleTouchEnd(e: TouchEvent) {
      e.preventDefault();
      const t = touchRef.current;
      if (!t.touchMoved && t.isTouching && e.changedTouches.length > 0) {
        // Tap — hit-test and navigate (changedTouches.length > 0 guaranteed)
        const touch = e.changedTouches[0]!;
        const rect = canvas!.getBoundingClientRect();
        const mouseX = touch.clientX - rect.left;
        const mouseY = touch.clientY - rect.top;
        const cam = cameraRef.current;
        if (cam) {
          const hit = hitTestRooms(mouseX, mouseY, roomsRef.current, cam);
          if (hit) {
            navigate({
              to: "/locations/$id",
              params: { id: hit.locationId },
            });
          }
        }
      }
      t.isTouching = false;
      t.lastPinchDist = 0;
    }

    canvas.addEventListener("touchstart", handleTouchStart, { passive: false });
    canvas.addEventListener("touchmove", handleTouchMove, { passive: false });
    canvas.addEventListener("touchend", handleTouchEnd, { passive: false });
    return () => {
      canvas.removeEventListener("touchstart", handleTouchStart);
      canvas.removeEventListener("touchmove", handleTouchMove);
      canvas.removeEventListener("touchend", handleTouchEnd);
    };
  }, [navigate]);

  const handleMouseDown = useCallback(
    (e: React.MouseEvent) => {
      setIsDragging(true);
      dragRef.current = {
        startX: e.clientX,
        startY: e.clientY,
        camX: camera?.x ?? 0,
        camY: camera?.y ?? 0,
      };
    },
    [camera],
  );

  const handleMouseMove = useCallback(
    (e: React.MouseEvent) => {
      if (!camera) return;
      const canvas = canvasRef.current;
      if (!canvas) return;

      if (isDragging) {
        const dx = e.clientX - dragRef.current.startX;
        const dy = e.clientY - dragRef.current.startY;
        setCamera((prev) =>
          prev
            ? {
                ...prev,
                x: dragRef.current.camX + dx,
                y: dragRef.current.camY + dy,
              }
            : prev,
        );
        canvas.style.cursor = "grabbing";
        return;
      }

      const rect = canvas.getBoundingClientRect();
      const mouseX = e.clientX - rect.left;
      const mouseY = e.clientY - rect.top;

      const hit = hitTestRooms(mouseX, mouseY, rooms, camera);
      setHoverTarget(hit);
      canvas.style.cursor = hit ? "pointer" : "grab";
    },
    [camera, isDragging, rooms],
  );

  // Click-to-navigate: distinguish click vs drag by displacement threshold
  const handleMouseUp = useCallback(
    (e: React.MouseEvent) => {
      const dx = e.clientX - dragRef.current.startX;
      const dy = e.clientY - dragRef.current.startY;
      const displacement = Math.sqrt(dx * dx + dy * dy);

      if (displacement < 5 && camera) {
        const canvas = canvasRef.current;
        if (canvas) {
          const rect = canvas.getBoundingClientRect();
          const mouseX = e.clientX - rect.left;
          const mouseY = e.clientY - rect.top;
          const hit = hitTestRooms(mouseX, mouseY, rooms, camera);
          if (hit) {
            navigate({
              to: "/locations/$id",
              params: { id: hit.locationId },
            });
          }
        }
      }

      setIsDragging(false);
    },
    [camera, rooms, navigate],
  );

  const handleMouseLeave = useCallback(() => {
    setIsDragging(false);
    setHoverTarget(null);
  }, []);

  const resetView = useCallback(() => {
    if (rooms.length > 0) {
      setCamera(calculateZoomToFit(rooms, size.w, size.h));
    }
  }, [rooms, size]);

  const isLoading = treeQuery.isLoading || inventoryQuery.isLoading;

  if (isLoading) {
    return (
      <div className="flex h-full items-center justify-center bg-[#1a1d24]">
        <div className="flex items-center gap-3 text-white/60">
          <Loader2 className="h-5 w-5 animate-spin" />
          <span>Loading pantry...</span>
        </div>
      </div>
    );
  }

  if (inventory.length === 0) {
    return (
      <div className="flex h-full flex-col items-center justify-center bg-[#1a1d24] text-white/60">
        <p className="text-lg">Your pantry is empty</p>
        <p className="mt-2 text-sm">
          Add some inventory items to see them here
        </p>
        <Link to="/inventory/new" className="mt-4">
          <Button variant="outline">Add Inventory</Button>
        </Link>
      </div>
    );
  }

  return (
    <div ref={containerRef} className="relative h-full w-full">
      <canvas
        ref={canvasRef}
        className="block h-full w-full touch-none"
        onMouseDown={handleMouseDown}
        onMouseMove={handleMouseMove}
        onMouseUp={handleMouseUp}
        onMouseLeave={handleMouseLeave}
      />
      <Link to="/inventory" className="absolute top-4 left-4">
        <Button
          variant="ghost"
          size="sm"
          className="text-white/60 hover:text-white"
        >
          <ArrowLeft className="mr-1 h-4 w-4" />
          Back
        </Button>
      </Link>
      <Button
        variant="ghost"
        size="sm"
        className="absolute top-4 right-48 text-white/60 hover:text-white"
        onClick={resetView}
      >
        <Maximize2 className="mr-1 h-4 w-4" />
        Reset View
      </Button>
      <CategoryLegend />
    </div>
  );
}
