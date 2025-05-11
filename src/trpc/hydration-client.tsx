"use client";

import React from "react";
import { HydrationBoundary } from "@tanstack/react-query";

// Client component to hydrate the query client with server-fetched data
export function HydrateClient({
  children,
  state,
}: {
  children: React.ReactNode;
  state?: unknown;
}) {
  return <HydrationBoundary state={state || {}}>{children}</HydrationBoundary>;
}
