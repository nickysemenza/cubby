import type { ReactNode } from "react";
import { PreviewDeleted, PreviewLoading } from "./manifest-card";

export function PreviewQuery<T>({
  query,
  label,
  children,
}: {
  query: { data: T | undefined; isLoading: boolean };
  label: string;
  children: (data: NonNullable<T>) => ReactNode;
}) {
  if (query.isLoading) return <PreviewLoading />;
  if (!query.data) return <PreviewDeleted label={label} />;
  return children(query.data as NonNullable<T>);
}
