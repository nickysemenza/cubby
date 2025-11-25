import { generateOpenApi } from '@ts-rest/open-api';
import type { SchemaTransformerSync } from '@ts-rest/open-api';
import { z } from 'zod';
import { usdaContract } from '@recipehub/usda-contract';

// Zod 4 synchronous transformer implementation
export const ZOD_4_TRANSFORMER: SchemaTransformerSync = ({ schema }) => {
  if (schema instanceof z.ZodType) {
    try {
      const jsonSchema = z.toJSONSchema(schema, { unrepresentable: 'any' });
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      return jsonSchema as any;
    } catch (error) {
      console.warn('Failed to transform Zod schema:', error);
      return null;
    }
  }
  return null;
};

export const openApiDocument = generateOpenApi(
  usdaContract,
  {
    openapi: '3.0.0',
    info: {
      title: 'USDA Food Data Central API',
      version: '1.0.0',
      description: `
A comprehensive REST API for accessing USDA Food Data Central database information.
This API provides access to detailed nutrition data, food portions, and branded food information.

## Features
- Search foods by UPC code or legacy NDB number
- Get complete food details including nutrition facts
- List foods with pagination and filtering
- Access to branded food and legacy SR food data

## Data Sources
All data is sourced from the USDA Food Data Central database, providing authoritative
nutrition information for thousands of foods.
      `.trim(),
    },
    servers: [
      {
        url: process.env.API_BASE_URL || 'http://localhost:8080',
        description: 'USDA API Server',
      },
    ],
  },
  {
    setOperationId: true,
    schemaTransformer: ZOD_4_TRANSFORMER,
    operationMapper: (operation, appRoute) => ({
      ...operation,
    }),
  }
);
