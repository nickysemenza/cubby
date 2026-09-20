export function purchaseImportRunDebugHref(runId: string): string {
  return `/settings#purchase-import-run-${encodeURIComponent(runId)}`;
}
