import { z } from "zod";
import {
  productLookupResponseSchema,
  productNotFoundResponseSchema,
  searchResponseSchema,
  statsResponseSchema,
  errorResponseSchema,
} from "./schemas/product";

// Convert Zod schemas to JSON Schema for OpenAPI
function zodToJsonSchema(schema: z.ZodType): object {
  return z.toJSONSchema(schema, { unrepresentable: "any" });
}

export const openApiDocument = {
  openapi: "3.0.0",
  info: {
    title: "UPC Lookup API",
    version: "1.0.0",
    description: `
A UPC/barcode lookup API with caching. Provides product information including name, brand, manufacturer, pricing, and images.

## Features
- Look up products by UPC/EAN barcode
- Search cached products by name or brand
- View cache statistics
- Automatic caching from UPCitemdb

## Pricing
All prices are returned in USD (e.g., \`priceDollars: 19.99\`).

## Authentication
All endpoints require an API key passed in the \`X-API-Key\` header.
    `.trim(),
  },
  servers: [
    {
      url: "https://upc-lookup.nicky.workers.dev",
      description: "Production",
    },
    {
      url: "http://localhost:5173",
      description: "Local Development",
    },
  ],
  paths: {
    "/lookup/{upc}": {
      get: {
        operationId: "lookupUpc",
        summary: "Look up product by UPC",
        description:
          "Returns cached product data or fetches from external APIs if not cached.",
        tags: ["Lookup"],
        security: [{ apiKey: [] }],
        parameters: [
          {
            name: "upc",
            in: "path",
            required: true,
            description: "UPC/EAN barcode (8, 12, 13, or 14 digits)",
            schema: { type: "string", pattern: "^\\d{8}$|^\\d{12,14}$" },
          },
        ],
        responses: {
          "200": {
            description: "Product found",
            content: {
              "application/json": {
                schema: zodToJsonSchema(productLookupResponseSchema),
              },
            },
          },
          "400": {
            description: "Invalid UPC format",
            content: {
              "application/json": {
                schema: zodToJsonSchema(errorResponseSchema),
              },
            },
          },
          "401": {
            description: "Missing or invalid API key",
            content: {
              "application/json": {
                schema: zodToJsonSchema(errorResponseSchema),
              },
            },
          },
          "404": {
            description: "Product not found",
            content: {
              "application/json": {
                schema: zodToJsonSchema(productNotFoundResponseSchema),
              },
            },
          },
        },
      },
    },
    "/search": {
      get: {
        operationId: "searchProducts",
        summary: "Search cached products",
        description: "Search products by name, brand, or manufacturer.",
        tags: ["Search"],
        security: [{ apiKey: [] }],
        parameters: [
          {
            name: "q",
            in: "query",
            required: true,
            description: "Search query",
            schema: { type: "string", minLength: 1 },
          },
          {
            name: "limit",
            in: "query",
            required: false,
            description: "Maximum results (1-100, default 20)",
            schema: { type: "integer", minimum: 1, maximum: 100, default: 20 },
          },
        ],
        responses: {
          "200": {
            description: "Search results",
            content: {
              "application/json": {
                schema: zodToJsonSchema(searchResponseSchema),
              },
            },
          },
          "400": {
            description: "Missing query parameter",
            content: {
              "application/json": {
                schema: zodToJsonSchema(errorResponseSchema),
              },
            },
          },
          "401": {
            description: "Missing or invalid API key",
            content: {
              "application/json": {
                schema: zodToJsonSchema(errorResponseSchema),
              },
            },
          },
        },
      },
    },
    "/stats": {
      get: {
        operationId: "getStats",
        summary: "Get cache statistics",
        description: "Returns statistics about the product cache.",
        tags: ["Stats"],
        security: [{ apiKey: [] }],
        responses: {
          "200": {
            description: "Cache statistics",
            content: {
              "application/json": {
                schema: zodToJsonSchema(statsResponseSchema),
              },
            },
          },
          "401": {
            description: "Missing or invalid API key",
            content: {
              "application/json": {
                schema: zodToJsonSchema(errorResponseSchema),
              },
            },
          },
        },
      },
    },
    "/health": {
      get: {
        operationId: "healthCheck",
        summary: "Health check",
        description: "Returns OK if the service is running.",
        tags: ["Health"],
        responses: {
          "200": {
            description: "Service is healthy",
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: {
                    status: { type: "string", example: "ok" },
                  },
                },
              },
            },
          },
        },
      },
    },
  },
  components: {
    securitySchemes: {
      apiKey: {
        type: "apiKey",
        in: "header",
        name: "X-API-Key",
        description: "API key for authentication",
      },
    },
  },
};
