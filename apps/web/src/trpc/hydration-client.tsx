"use client";

import React from "react";
import { HydrationBoundary, type DehydratedState } from "@tanstack/react-query";

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
