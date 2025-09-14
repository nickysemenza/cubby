# Inventory Experience Improvements Plan

## Overview
This document outlines improvements to streamline the inventory management workflow, particularly for garage/storage organization where items are cataloged by location (bins/boxes) with product details including UPC, pricing, and quantities.

## Core User Workflow
The typical inventory process follows these steps:
1. Navigate to a physical location (garage area, shelf, bin)
2. Create/confirm the location exists in the system with correct parent
3. For each item in the location:
   - Start with item's **model number** or **name** (primary identifier)
   - Search for existing product or create new
   - Look up UPC code (via Google or product label)
   - Set pricing via ProductUnitMappings (e.g., 1 each = $8.00)
   - Set quantity and any special flags (e.g., expecting only one)
4. Update lastBulkInventory timestamp (automatic)

## Implementation Plan

### Phase 1: Smart Product Creation with Enhanced Lookup

#### 1.1 Multi-Method Product Search
- **Primary search by model number or name** (not just UPC)
- Add search modes: "By Name", "By Model", "By UPC", "By Manufacturer"
- Auto-suggest existing products as user types
- Show confidence scores for matches

#### 1.2 UPC Integration
- Add UPC scanner using device camera (Web API)
- Integrate free UPC lookup API (upcdatabase.org initially)
- Fallback to USDA database for food items
- Manual UPC entry with validation

#### 1.3 Price Discovery via Cloudflare Worker

**Implementation approach:**
```typescript
// In product service or as a tRPC procedure
async priceLookup(productInfo: ProductInfo) {
  // TODO: Call Cloudflare Worker for price lookup
  // const response = await fetch(CLOUDFLARE_WORKER_URL, {
  //   method: 'POST',
  //   headers: { 'Content-Type': 'application/json' },
  //   body: JSON.stringify({
  //     name: productInfo.name,
  //     model: productInfo.model,
  //     manufacturer: productInfo.manufacturer,
  //     upc: productInfo.upc
  //   })
  // });
  //
  // const result = await response.json();
  // return {
  //   price: result.price,
  //   confidence: result.confidence,
  //   sources: result.sources
  // };

  // Placeholder until Cloudflare Worker is implemented
  return {
    price: null,
    confidence: 'pending',
    sources: 0
  };
}
```

**User Experience:**
- One-click "Find Price" button in product form
- Shows loading spinner with "Searching for prices..."
- Creates ProductUnitMapping when price is found (e.g., 1 each = $8.00)
- Manual override via existing unit mappings interface

#### 1.4 Product Creation Form Enhancements
- Start with model/name field (not UPC)
- Auto-populate fields from lookup results
- Preview panel showing fetched data
- "Quick Create & Add Another" option

### Phase 2: Location-Based Inventory Mode

#### 2.1 Mobile-Optimized Location View
- Create `/inventory/location-mode/[locationId]` route
- Large touch targets for mobile devices
- Swipe gestures for common actions
- Offline capability with sync queue

#### 2.2 Hierarchical Navigation
- Breadcrumb trail: Garage > Shelf A > Bin 3
- Visual location tree with expand/collapse
- Quick location switcher dropdown
- "Recent locations" for fast access

#### 2.3 Location Management
- Inline "Create child location" button
- Drag-and-drop location reorganization
- Bulk create locations (e.g., "Bin 1-10")
- Location templates (e.g., "Storage Bin", "Tool Box")

### Phase 3: Enhanced Inventory Tracking

#### 3.1 Expected Quantity System
- Add `expectedQuantity` field to Product schema
- Default: null (unlimited)
- Set to 1 for unique items (tools, electronics)
- Warning when count exceeds expected


#### 3.2 Duplicate Prevention
- Warn when adding product with expectedQuantity=1 to multiple locations
- Show "Already inventoried at: [location]" alert
- Suggest updating existing entry instead of creating duplicate

### Phase 4: Bulk Operations

#### 4.1 Quick Add Mode
- Rapid entry form with minimal clicks
- Keyboard shortcuts for power users
- Auto-advance to next field
- Batch validation before save

#### 4.2 Template System
- Save common box contents as templates
- "Hardware Box", "Electronics Kit", etc.
- Clone inventory from another location
- Seasonal inventory presets

#### 4.3 Import/Export
- CSV upload for bulk product creation
- Export inventory by location
- Barcode sheet generation for printing
- Integration with spreadsheet apps

### Phase 5: Data Enrichment

#### 5.1 Automatic Enrichment
- Category auto-assignment based on product type
- Image fetching from product databases
- USDA nutrition data linkage for food items

#### 5.2 Manual Enrichment Tools
- Bulk edit mode for multiple products
- Quick actions menu per product
- Web search integration for specs/manuals
- Community database contributions

### Phase 6: Status and Reporting

#### 6.1 Visual Status Indicators
- Color coding by last inventory date
- "Stale" inventory warnings (>6 months)
- Completion progress bars
- Missing data highlights

#### 6.2 Analytics Dashboard
- Inventory value by location
- Most/least accessed items
- Storage optimization suggestions
- Location utilization metrics

## Technical Implementation Details

### Database Schema Changes (Prisma)
```prisma
// Update Product model in schema.prisma
model Product {
  id               String   @id @default(uuid())
  name             String
  manufacturer     String
  model            String?
  upc              String?
  ndb_number       Int?
  expectedQuantity Int?     // New: null means unlimited, 1 for unique items

  // ... existing relations ...
  // Note: Pricing is handled via existing ProductUnitMappings table
  // e.g., {"unit": "each", "value": 1} = {"unit": "dollar", "value": 8}
}
```

Then run: `pnpm prisma migrate dev --name add-inventory-improvements`

### tRPC Procedures Needed

```typescript
// In productRouter
export const productRouter = createTRPCRouter({
  // Existing procedures...

  searchByMultipleSources: publicProcedure
    .input(z.object({
      query: z.string(),
      searchType: z.enum(['name', 'model', 'upc', 'manufacturer', 'all'])
    }))
    .query(async ({ input, ctx }) => {
      // Search existing products using service layer
    }),

  priceLookup: publicProcedure
    .input(z.object({
      name: z.string().optional(),
      model: z.string().optional(),
      upc: z.string().optional(),
      manufacturer: z.string().optional()
    }))
    .mutation(async ({ input, ctx }) => {
      // TODO: Call Cloudflare Worker for price lookup
      // When price is found, create ProductUnitMapping automatically
      return { price: null, confidence: 'pending', sources: 0 };
    }),

  findDuplicates: publicProcedure
    .input(z.object({
      productId: z.string().optional(),
      excludeLocationId: z.string().optional()
    }))
    .query(async ({ input, ctx }) => {
      // Find products with expectedQuantity=1 in multiple locations
    }),
});

// In inventoryRouter
export const inventoryRouter = createTRPCRouter({
  // Existing procedures...

  findDuplicates: publicProcedure
    .input(z.object({
      excludeLocationId: z.string().optional()
    }))
    .query(async ({ input, ctx }) => {
      // Find products with expectedQuantity=1 in multiple locations
    }),

  // Enhanced create procedure with duplicate detection
  create: publicProcedure
    .input(inventoryCreatePayloadData)
    .mutation(async ({ input, ctx }) => {
      // Check for expectedQuantity=1 duplicates before creating
    }),
});
```

### Frontend Components Required
- `ProductForm` - Enhanced with model/name-first fields and expectedQuantity ✅
- `LocationInventoryMode` - Mobile-optimized inventory view
- `BarcodeScanner` - Camera-based barcode scanning
- `PriceLookupButton` - Price discovery integration (creates unit mappings)
- `LocationBreadcrumb` - Hierarchical navigation
- `ProductSearchMultiMode` - Multi-method search component ✅
- `DuplicateWarning` - Alert component for expectedQuantity violations ✅

### Integration Points
- UPC Database API (upcdatabase.org)
- Cloudflare Worker for price discovery (TODO: implement separately)
- Browser Camera API (for barcode scanning)
- USDA Database (existing integration)

## Success Metrics
- Time to add new product: <30 seconds (from 2+ minutes)
- Duplicate inventory entries: <5% (from unknown)
- Products with UPC codes: >80% (from ~20%)
- Products with pricing unit mappings: >70% (from ~10%)
- Mobile inventory sessions: >60% of total

## Implementation Priority

### Must Have (Phase 1) ✅ COMPLETED
1. ✅ Model/name-first product search (implemented as searchByMultipleSources)
2. ✅ Quick product creation with lookup (enhanced ProductForm)
3. ✅ Expected quantity field and duplicate warnings (schema + validation)
4. ✅ Price lookup placeholder (ready for Cloudflare Worker integration)

### Should Have (Phase 2)
1. Location-based inventory mode
2. Barcode scanning via camera
3. AI-powered price lookup (Cloudflare Worker)
4. Mobile-optimized location views

### Nice to Have (Phase 3)
1. Templates and presets
2. Import/export functionality
3. Automated enrichment
4. Analytics dashboard

## Timeline Estimate
- Phase 1: 2-3 days
- Phase 2: 3-4 days
- Phase 3: 2-3 days
- Testing & Refinement: 2 days

Total: ~2 weeks for full implementation

## Notes
- Prioritize mobile UX since inventory is done on-location
- Keep offline capability in mind for garage/basement with poor signal
- Consider progressive enhancement - basic features work everywhere
- Build on existing WASM unit conversion for complex calculations
- Maintain backwards compatibility with existing inventory data
- **Important**: Pricing is managed via ProductUnitMappings, not a separate currentPrice field

