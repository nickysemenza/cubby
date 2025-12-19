# Inventory Experience Improvements Plan

## Overview
Improvements to streamline the inventory management workflow, particularly for garage/storage organization.

**Completed (Phase 1):**
- Model/name-first product search
- Quick product creation with lookup
- Expected quantity field and duplicate warnings
- Price lookup placeholder (ready for Cloudflare Worker)

## Phase 2: Location-Based Inventory Mode (NOT DONE)

### 2.1 Mobile-Optimized Location View
- Create `/inventory/location-mode/[locationId]` route
- Large touch targets for mobile devices
- Swipe gestures for common actions
- Offline capability with sync queue

### 2.2 Hierarchical Navigation
- Breadcrumb trail: Garage > Shelf A > Bin 3
- Visual location tree with expand/collapse
- Quick location switcher dropdown
- "Recent locations" for fast access

### 2.3 Location Management
- Inline "Create child location" button
- Drag-and-drop location reorganization
- Bulk create locations (e.g., "Bin 1-10")
- Location templates (e.g., "Storage Bin", "Tool Box")

## Phase 3: Bulk Operations (NOT DONE)

### 3.1 Quick Add Mode
- Rapid entry form with minimal clicks
- Keyboard shortcuts for power users
- Auto-advance to next field
- Batch validation before save

### 3.2 Template System
- Save common box contents as templates
- "Hardware Box", "Electronics Kit", etc.
- Clone inventory from another location
- Seasonal inventory presets

### 3.3 Import/Export
- CSV upload for bulk product creation
- Export inventory by location
- Barcode sheet generation for printing
- Integration with spreadsheet apps

## Phase 4: Data Enrichment (NOT DONE)

### 4.1 Automatic Enrichment
- Category auto-assignment based on product type
- Image fetching from product databases
- USDA nutrition data linkage for food items

### 4.2 Manual Enrichment Tools
- Bulk edit mode for multiple products
- Quick actions menu per product
- Web search integration for specs/manuals

## Phase 5: Status and Reporting (NOT DONE)

### 5.1 Visual Status Indicators
- Color coding by last inventory date
- "Stale" inventory warnings (>6 months)
- Completion progress bars
- Missing data highlights

### 5.2 Analytics Dashboard
- Inventory value by location
- Most/least accessed items
- Storage optimization suggestions
- Location utilization metrics

## Priority

### Should Have (Next)
1. Location-based inventory mode
2. Barcode scanning via camera
3. Mobile-optimized location views

### Nice to Have (Later)
1. Templates and presets
2. Import/export functionality
3. Automated enrichment
4. Analytics dashboard

## Notes
- Prioritize mobile UX since inventory is done on-location
- Keep offline capability in mind for garage/basement with poor signal
- Build on existing WASM unit conversion for complex calculations
