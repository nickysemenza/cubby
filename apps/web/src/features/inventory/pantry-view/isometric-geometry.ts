export const TILE_W = 56;
export const TILE_H = 28;
const Z_STEP = 26;
export const ROOM_H = 5;
export const MIN_ZOOM = 0.08;
export const MAX_ZOOM = 2.5;

export interface Point {
  x: number;
  y: number;
}

export interface Camera {
  x: number;
  y: number;
  zoom: number;
}

export interface RoomGeometry {
  roomW: number;
  roomD: number;
  originX: number;
  originY: number;
}

export function toScreen(
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

function parseHSL(hsl: string): [number, number, number] {
  const match = hsl.match(/hsl\((\d+),\s*(\d+)%,\s*(\d+)%\)/);
  if (!match) return [0, 0, 50];
  return [
    Number.parseInt(match[1]!, 10),
    Number.parseInt(match[2]!, 10),
    Number.parseInt(match[3]!, 10),
  ];
}

export function adjustLight(hsl: string, delta: number): string {
  const [hue, saturation, lightness] = parseHSL(hsl);
  return `hsl(${hue}, ${saturation}%, ${Math.max(0, Math.min(100, lightness + delta))}%)`;
}

export function calculateZoomToFit(
  rooms: RoomGeometry[],
  canvasW: number,
  canvasH: number,
): Camera {
  if (rooms.length === 0) return { x: canvasW / 2, y: canvasH / 2, zoom: 1 };

  let minX = Infinity;
  let maxX = -Infinity;
  let minY = Infinity;
  let maxY = -Infinity;
  for (const room of rooms) {
    for (const height of [0, ROOM_H]) {
      const corners: Array<[number, number]> = [
        [room.originX, room.originY],
        [room.originX + room.roomW, room.originY],
        [room.originX, room.originY + room.roomD],
        [room.originX + room.roomW, room.originY + room.roomD],
      ];
      for (const [x, y] of corners) {
        const point = toScreen(x, y, height, 0, 0);
        minX = Math.min(minX, point.x);
        maxX = Math.max(maxX, point.x);
        minY = Math.min(minY, point.y);
        maxY = Math.max(maxY, point.y);
      }
    }
  }

  const padding = 120;
  const zoom = Math.max(
    MIN_ZOOM,
    Math.min(
      MAX_ZOOM,
      Math.min(
        (canvasW - padding) / (maxX - minX),
        (canvasH - padding) / (maxY - minY),
      ),
    ),
  );
  return {
    x: canvasW / 2 - ((minX + maxX) / 2) * zoom,
    y: canvasH / 2 - ((minY + maxY) / 2) * zoom,
    zoom,
  };
}

export function pointInPolygon(
  px: number,
  py: number,
  corners: Point[],
): boolean {
  let inside = false;
  for (
    let index = 0, prior = corners.length - 1;
    index < corners.length;
    prior = index++
  ) {
    const current = corners[index]!;
    const previous = corners[prior]!;
    const intersects =
      current.y > py !== previous.y > py &&
      px <
        ((previous.x - current.x) * (py - current.y)) /
          (previous.y - current.y) +
          current.x;
    if (intersects) inside = !inside;
  }
  return inside;
}
