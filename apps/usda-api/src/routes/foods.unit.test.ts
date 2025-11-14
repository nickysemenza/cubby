import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Hono } from 'hono';

// Mock the database queries before importing the foods module
vi.mock('../db/queries.js', () => ({
  findFoodByUpc: vi.fn(),
  findFoodByNdb: vi.fn(),
  listFoods: vi.fn(),
  getCompleteFoodInfo: vi.fn(),
}));

describe('Foods API routes', () => {
  let app: Hono;
  let mockQueries: typeof import('../db/queries.js');
  let findFoodByUpc: ReturnType<
    typeof vi.mocked<typeof import('../db/queries.js').findFoodByUpc>
  >;
  let findFoodByNdb: ReturnType<
    typeof vi.mocked<typeof import('../db/queries.js').findFoodByNdb>
  >;
  let getCompleteFoodInfo: ReturnType<
    typeof vi.mocked<typeof import('../db/queries.js').getCompleteFoodInfo>
  >;

  beforeEach(async () => {
    vi.clearAllMocks();

    // Import and mock the queries module
    mockQueries = await import('../db/queries.js');
    findFoodByUpc = vi.mocked(mockQueries.findFoodByUpc);
    findFoodByNdb = vi.mocked(mockQueries.findFoodByNdb);
    getCompleteFoodInfo = vi.mocked(mockQueries.getCompleteFoodInfo);

    // Import foods module after mocks are set up
    const foodsModule = await import('./foods.js');
    app = foodsModule.default;
  });

  describe('GET /api/foods/:fdc_id', () => {
    it('should return 400 for invalid fdc_id', async () => {
      const res = await app.request('/api/foods/invalid');
      expect(res.status).toBe(400);

      const json = await res.json();
      expect(json).toEqual({ error: 'Invalid FDC ID' });
    });

    it('should return 404 when food not found', async () => {
      getCompleteFoodInfo.mockResolvedValueOnce(null);

      const res = await app.request('/api/foods/12345');
      expect(res.status).toBe(404);

      const json = await res.json();
      expect(json).toEqual({
        error: 'Food not found',
        message: 'No food found with FDC ID 12345',
      });
    });

    it('should return food data when found', async () => {
      const mockFood = {
        fdc_id: 12345,
        brandedFoodInfo: null,
        foodInfo: {
          data_type: 'foundation_food' as const,
          description: 'Apple, raw',
        },
        legacyFoodInfo: null,
        nutritionInfo: {
          nutrientSummary: [],
          nutrientsPer100: {
            protein: 0.26,
            kcal: 52,
          },
        },
        portionInfoRaw: [],
      };

      getCompleteFoodInfo.mockResolvedValueOnce(mockFood);

      const res = await app.request('/api/foods/12345');
      expect(res.status).toBe(200);

      const json = await res.json();
      expect(json).toMatchObject({
        fdc_id: 12345,
        foodInfo: {
          description: 'Apple, raw',
          data_type: 'foundation_food',
        },
      });
    });
  });

  describe('POST /api/foods/search', () => {
    it('should return 400 for invalid request body', async () => {
      const res = await app.request('/api/foods/search', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ invalid: 'data' }),
      });

      expect(res.status).toBe(400);

      const json = await res.json();
      expect(json).toEqual({ error: 'Invalid lookup' });
    });

    it('should search by UPC and return food when found', async () => {
      const mockFood = {
        fdc_id: 12345,
        brandedFoodInfo: {
          brand_owner: 'Coca Cola Company',
          brand_name: 'Coca Cola',
          branded_food_category: 'Soft Drinks',
          gtin_upc: '123456789012',
          ingredients: 'Water, Sugar, etc',
          serving: {
            serving_size: 355,
            serving_size_unit: 'ml',
            household_serving_fulltext: '1 can',
          },
        },
        foodInfo: {
          data_type: 'branded_food' as const,
          description: 'Coca Cola Original',
        },
        legacyFoodInfo: null,
        nutritionInfo: {
          nutrientSummary: [],
          nutrientsPer100: {
            protein: 0,
            kcal: 139,
          },
        },
        portionInfoRaw: [],
      };

      findFoodByUpc.mockResolvedValueOnce(mockFood);

      const res = await app.request('/api/foods/search', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          kind: 'upc',
          gtin_upc: '123456789012',
        }),
      });

      expect(res.status).toBe(200);
      expect(findFoodByUpc).toHaveBeenCalledWith('123456789012');

      const json = await res.json();
      expect(json).toMatchObject({
        fdc_id: 12345,
        foodInfo: {
          description: 'Coca Cola Original',
        },
      });
    });

    it('should search by NDB and return food when found', async () => {
      const mockFood = {
        fdc_id: 12345,
        brandedFoodInfo: null,
        foodInfo: {
          data_type: 'sr_legacy_food' as const,
          description: 'Apple, raw, legacy',
        },
        legacyFoodInfo: {
          fdc_id: 12345,
          ndb_number: 12345,
        },
        nutritionInfo: {
          nutrientSummary: [],
          nutrientsPer100: {
            protein: 0.26,
            kcal: 52,
          },
        },
        portionInfoRaw: [],
      };

      findFoodByNdb.mockResolvedValueOnce(mockFood);

      const res = await app.request('/api/foods/search', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          kind: 'ndb',
          ndb_number: 12345,
        }),
      });

      expect(res.status).toBe(200);
      expect(findFoodByNdb).toHaveBeenCalledWith(12345);

      const json = await res.json();
      expect(json).toMatchObject({
        fdc_id: 12345,
        foodInfo: {
          description: 'Apple, raw, legacy',
        },
      });
    });

    it('should return null when food not found', async () => {
      findFoodByUpc.mockResolvedValueOnce(null);

      const res = await app.request('/api/foods/search', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          kind: 'upc',
          gtin_upc: '000000000000',
        }),
      });

      expect(res.status).toBe(200);

      const json = await res.json();
      expect(json).toBeNull();
    });

    it('should handle malformed JSON gracefully', async () => {
      const res = await app.request('/api/foods/search', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: 'invalid json',
      });

      expect(res.status).toBe(400);

      const json = await res.json();
      expect(json).toEqual({ error: 'Invalid lookup' });
    });
  });
});
