import { Hono } from 'hono';
import { z } from 'zod';
import {
  fdcIdParam,
  listFoodsQuery,
  listFoodsResponse,
} from '@recipehub/usda-contract';
import { foodLookupParam, foodSummary } from '@recipehub/usda-schemas';
import {
  findFoodByUpc,
  findFoodByNdb,
  listFoods,
  getCompleteFoodInfo,
} from '../db/queries.js';
import { withTrace, TraceNames } from '../tracing.js';

const app = new Hono();

// 1. Get Complete Food by FDC ID
app.get('/api/foods/:fdc_id', (c) => {
  return withTrace(TraceNames.food('getFoodById'), async (span) => {
    const params = fdcIdParam.safeParse({ fdc_id: c.req.param('fdc_id') });
    if (!params.success) {
      return c.json({ error: 'Invalid FDC ID' }, 400);
    }

    span.setAttributes({
      'food.fdc_id': params.data.fdc_id,
    });

    const completeFood = await getCompleteFoodInfo(params.data.fdc_id);
    if (!completeFood) {
      span.setAttributes({ 'food.found': false });
      return c.json(
        {
          error: 'Food not found',
          message: `No food found with FDC ID ${params.data.fdc_id}`,
        },
        404
      );
    }

    span.setAttributes({
      'food.found': true,
      'food.description': completeFood.foodInfo.description || 'unknown',
    });
    return c.json(foodSummary.parse(completeFood), 200);
  });
});

// 2. Consolidated: Find Food by Lookup (UPC or NDB) via POST body
app.post('/api/foods/search', async (c) => {
  return withTrace(TraceNames.search('findFoodByLookup'), async (span) => {
    const body = await c.req.json().catch(() => undefined);
    const parsed = foodLookupParam.safeParse(body);
    if (!parsed.success) {
      return c.json({ error: 'Invalid lookup' }, 400);
    }
    const lookup = parsed.data;

    span.setAttributes({
      'search.kind': lookup.kind,
      'search.value':
        lookup.kind === 'upc' ? lookup.gtin_upc : String(lookup.ndb_number),
    });

    const food =
      lookup.kind === 'upc'
        ? await findFoodByUpc(lookup.gtin_upc)
        : await findFoodByNdb(lookup.ndb_number);

    span.setAttributes({ 'search.found': !!food });
    return c.json(food ? foodSummary.parse(food) : null, 200);
  });
});

// 3. Batch Find Foods by Lookup
app.post('/api/foods/search/batch', async (c) => {
  return withTrace(TraceNames.search('batchFindFoods'), async (span) => {
    const body = await c.req.json().catch(() => undefined);
    const parsed = z
      .object({
        lookups: z.array(foodLookupParam),
      })
      .safeParse(body);
    if (!parsed.success) {
      return c.json({ error: 'Invalid batch lookup' }, 400);
    }

    span.setAttributes({
      'search.batch.count': parsed.data.lookups.length,
    });

    const results = await Promise.all(
      parsed.data.lookups.map(async (lookup) => {
        const food =
          lookup.kind === 'upc'
            ? await findFoodByUpc(lookup.gtin_upc)
            : await findFoodByNdb(lookup.ndb_number);
        return food ? foodSummary.parse(food) : null;
      })
    );

    const foundCount = results.filter((r) => r !== null).length;
    span.setAttributes({
      'search.batch.found': foundCount,
    });

    return c.json({ results }, 200);
  });
});

// 4. List Foods with Pagination and Filtering
app.get('/api/foods', (c) => {
  return withTrace(TraceNames.food('listFoods'), async (span) => {
    const queryParams = Object.fromEntries(
      new URL(c.req.url).searchParams.entries()
    );
    const parsed = listFoodsQuery.safeParse({
      nameFilter: queryParams.nameFilter,
      dataTypeFilter: queryParams.dataTypeFilter,
      orderBy: queryParams.orderBy,
      direction: queryParams.direction,
      pageIndex: queryParams.pageIndex,
      pageSize: queryParams.pageSize,
    });
    if (!parsed.success) {
      return c.json({ error: 'Invalid query parameters' }, 400);
    }

    span.setAttributes({
      'list.page_index': parsed.data.pageIndex ?? 0,
      'list.page_size': parsed.data.pageSize ?? 20,
      'list.has_filter': !!parsed.data.nameFilter,
    });
    if (parsed.data.nameFilter) {
      span.setAttributes({ 'list.filter': parsed.data.nameFilter });
    }

    const result = await listFoods(parsed.data);

    span.setAttributes({
      'list.result_count': result.data.length,
      'list.total_count': result.count,
    });

    return c.json(listFoodsResponse.parse(result), 200);
  });
});

export default app;
