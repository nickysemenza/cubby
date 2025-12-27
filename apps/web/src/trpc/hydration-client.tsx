"use client";

import { type DehydratedState, HydrationBoundary } from "@tanstack/react-query";
import type React from "react";

// Client component to hydrate the query client with server-fetched data
export function HydrateClient({
  children,
  state,
}: {
  children: React.ReactNode;
  state?: DehydratedState;
}) {
  return <HydrationBoundary state={state}>{children}</HydrationBoundary>;
}
