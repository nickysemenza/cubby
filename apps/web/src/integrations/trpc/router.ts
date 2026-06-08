// Re-export the app router type from the shared contract package (the type-only
// firewall). Web and mobile both source the AppRouter type through @cubby/api-contract.
export type { AppRouter as TRPCRouter } from "@cubby/api-contract";
