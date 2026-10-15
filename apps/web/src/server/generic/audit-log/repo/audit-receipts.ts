import { AsyncLocalStorage } from "node:async_hooks";

// Capture the actual insert receipts, never a later query for the latest write.
const receipts = new AsyncLocalStorage<string[]>();
export const captureAuditId = (id: string) => receipts.getStore()?.push(id);
export async function withAuditReceipts<T>(work: () => Promise<T>) {
  const auditIds: string[] = [];
  const result = await receipts.run(auditIds, work);
  return { result, auditIds };
}
