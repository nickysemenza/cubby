import { CfWorkerJsonSchemaValidator } from "@modelcontextprotocol/client/validators/cf-worker";

/**
 * Cubby's MCP tool schemas are advertised as JSON Schema draft 7. The SDK's
 * default AJV validator compiles schemas with `new Function`, which Cloudflare
 * Workers prohibit, so every in-Worker MCP client must use this provider.
 */
export function createMcpClientValidator() {
  return new CfWorkerJsonSchemaValidator({ draft: "7" });
}
