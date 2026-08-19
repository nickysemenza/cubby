import { useQuery } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import type React from "react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { entities, entityDetailParams } from "~/entities/entities";
import { useTRPC } from "~/integrations/trpc/react";
import { useAllInventoryItems } from "../_components/inventory/use-all-inventory-items";
import {
  type Camera,
  calculateZoomToFit,
  MAX_ZOOM,
  MIN_ZOOM,
} from "./isometric-geometry";
import {
  buildRooms,
  drawTitle,
  drawTooltip,
  type HoverTarget,
  hitTestRooms,
  type InventoryData,
  type RoomData,
  renderScene,
  resolveCssColor,
} from "./isometric-scene";

export function useIsometricPantry() {
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

  const inventoryQuery = useAllInventoryItems();

  const inventory = useMemo(() => {
    return inventoryQuery.items as unknown as InventoryData[];
  }, [inventoryQuery.items]);

  const rooms = useMemo(() => {
    const tree = treeQuery.data;
    if (!tree || tree.length === 0) return [];
    return buildRooms(tree, inventory, resolveCssColor);
  }, [treeQuery.data, inventory]);

  const openLocation = useCallback(
    (locationShortcode: string) => {
      navigate({
        to: entities.location.routes.detail,
        params: entityDetailParams(locationShortcode),
      });
    },
    [navigate],
  );

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
            openLocation(hit.locationShortcode);
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
  }, [openLocation]);

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
            openLocation(hit.locationShortcode);
          }
        }
      }

      setIsDragging(false);
    },
    [camera, rooms, openLocation],
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

  return {
    canvasRef,
    containerRef,
    handleMouseDown,
    handleMouseLeave,
    handleMouseMove,
    handleMouseUp,
    inventory,
    isLoading,
    openLocation,
    resetView,
    rooms,
  };
}
