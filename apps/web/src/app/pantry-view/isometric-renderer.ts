import type { LocationType } from "@cubby/shared";

import {
  adjustLight,
  type Camera,
  ROOM_H,
  TILE_H,
  TILE_W,
  toScreen,
} from "./isometric-geometry";
import {
  type FurniturePiece,
  getItemHeight,
  type HoverTarget,
  type RoomData,
  type ZoneData,
} from "./isometric-layout";

// ─── Constants ───────────────────────────────────────────────────────────────

// Porcelain Transit palette. Canvas cannot read CSS vars, so these mirror the
// cool canvas/inset/hairline/graphite primitives as HSL literals for the
// shading math (parseHSL/adjustLight). Zones use cobalt at low opacity instead
// of a rainbow.
const FLOOR_COLOR_1 = "hsl(216, 28%, 92%)";
const FLOOR_COLOR_2 = "hsl(216, 24%, 88%)";
const WALL_BACK_COLOR = "hsl(216, 45%, 98%)";
const WALL_LEFT_COLOR = "hsl(214, 33%, 95%)";
const BASEBOARD_COLOR = "hsl(219, 18%, 40%)";
const BG_COLOR = "#f7f9fc";

// ─── Projection ──────────────────────────────────────────────────────────────

// The category/location colors come from @cubby/shared as CSS custom-property
// tokens (`var(--chart-*)`) — correct for DOM/SVG consumers, where the browser
// resolves them. But the canvas 2D context can NOT resolve `var()`: an invalid
// fillStyle is silently ignored, so an item would paint with the previous
// color. Resolve any `var(--x)` to its concrete value before it reaches the
// canvas. Client-only (getComputedStyle); on the server the value is unused
// (the canvas never paints there) so the raw token passes through harmlessly.
export function resolveCssColor(color: string): string {
  if (!globalThis.window || !color.startsWith("var(")) return color;
  const name = color.slice(4, -1).split(",")[0]?.trim();
  if (!name) return color;
  const resolved = getComputedStyle(document.documentElement)
    .getPropertyValue(name)
    .trim();
  return resolved || color;
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
    ctx.fillStyle = "rgba(23, 26, 33, 0.7)";
    ctx.font = '600 11px "Inter Variable", Inter, system-ui, sans-serif';
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

// Null means the location IS a Product. Drawn as a container rather than
// falling through to `default` (a shelving unit) — same reasoning as
// `getFurnitureSpec`, and the two must agree or a piece is sized as a box and
// painted as a shelf.
function getDrawFunction(type: LocationType | null) {
  switch (type) {
    case null:
      return drawBoxContainer;
    case "shelf":
      return drawShelfUnit;
    case "cabinet":
    case "drawer":
      return drawCabinetUnit;
    case "table":
    case "cart":
      return drawTableSurface;
    case "box":
    case "bag":
      return drawBoxContainer;
    default:
      return drawShelfUnit;
  }
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

  ctx.strokeStyle = "rgba(37, 99, 235, 0.28)";
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

    ctx.font = '9px "Inter Variable", Inter, system-ui, sans-serif';
    ctx.fillStyle = "rgba(102, 112, 133, 0.72)";
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

export function renderScene(
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
      const drawFn = getDrawFunction(piece.locationType ?? null);
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

    ctx.font = '600 13px "Inter Variable", Inter, system-ui, sans-serif';
    ctx.fillStyle = "rgba(23, 26, 33, 0.92)";
    ctx.textAlign = "center";
    ctx.textBaseline = "bottom";
    ctx.fillText(room.name, sx, sy);

    ctx.font = '11px "Inter Variable", Inter, system-ui, sans-serif';
    ctx.fillStyle = "rgba(102, 112, 133, 0.82)";
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

        ctx.font = '10px "Inter Variable", Inter, system-ui, sans-serif';
        ctx.fillStyle = zone.labelColor;
        ctx.textAlign = "center";
        ctx.textBaseline = "top";
        ctx.fillText(zone.name, lx, ly);

        ctx.font = '9px "Inter Variable", Inter, system-ui, sans-serif';
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

export function drawTooltip(
  ctx: CanvasRenderingContext2D,
  target: HoverTarget,
  canvasW: number,
) {
  const padding = 10;
  const lineHeight = 18;
  ctx.font = '600 12px "Inter Variable", Inter, system-ui, sans-serif';
  const labelW = ctx.measureText(target.label).width;
  ctx.font = '11px "Inter Variable", Inter, system-ui, sans-serif';
  const detailW = target.detail ? ctx.measureText(target.detail).width : 0;
  const boxW = Math.max(labelW, detailW) + padding * 2;
  const boxH = (target.detail ? 2 : 1) * lineHeight + padding * 1.5;

  let tx = target.screenX + 14;
  let ty = target.screenY - boxH - 8;
  if (tx + boxW > canvasW - 10) tx = target.screenX - boxW - 14;
  if (ty < 10) ty = target.screenY + 14;

  // Flat Porcelain tooltip: white surface, cool hairline, modest control
  // radius, and no ambient shadow.
  ctx.fillStyle = "rgba(255, 255, 255, 0.98)";
  ctx.beginPath();
  ctx.roundRect(tx, ty, boxW, boxH, 6);
  ctx.fill();

  ctx.strokeStyle = "rgba(23, 26, 33, 0.18)";
  ctx.lineWidth = 1;
  ctx.stroke();

  ctx.fillStyle = "#171a21";
  ctx.font = '600 12px "Inter Variable", Inter, system-ui, sans-serif';
  ctx.textAlign = "left";
  ctx.textBaseline = "top";
  ctx.fillText(target.label, tx + padding, ty + padding);

  if (target.detail) {
    ctx.fillStyle = "rgba(102, 112, 133, 0.95)";
    ctx.font = '11px "Inter Variable", Inter, system-ui, sans-serif';
    ctx.fillText(target.detail, tx + padding, ty + padding + lineHeight);
  }
}

export function drawTitle(
  ctx: CanvasRenderingContext2D,
  canvasW: number,
  totalItems: number,
  totalRooms: number,
) {
  ctx.fillStyle = "rgba(23, 26, 33, 0.92)";
  ctx.font = '600 20px "Inter Variable", Inter, system-ui, sans-serif';
  ctx.textAlign = "right";
  ctx.textBaseline = "top";
  ctx.fillText("Isometric Pantry", canvasW - 24, 20);

  ctx.fillStyle = "rgba(102, 112, 133, 0.95)";
  ctx.font = '12px "Inter Variable", Inter, system-ui, sans-serif';
  ctx.fillText(
    `${totalItems} item${totalItems !== 1 ? "s" : ""} in ${totalRooms} room${totalRooms !== 1 ? "s" : ""}`,
    canvasW - 24,
    46,
  );
}
