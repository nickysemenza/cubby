/** A source can support several identified orders or retained receipt sections. */
export function sourceOrderKey(input: {
  vendorId: string;
  orderId: string | null;
  orderLocator?: string;
}): string {
  return input.orderId !== null
    ? `${input.vendorId}/order/${input.orderId}`
    : `${input.vendorId}/receipt/${input.orderLocator ?? "whole"}`;
}
