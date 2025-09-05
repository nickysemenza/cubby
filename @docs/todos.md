
## ✅ differentiate between summing to 0 and/or partially missing 
* ~~In the recipe summary. If we have some or all ingredients w/ 'Missing Data' then we might sum the cost/weight/cal/protein to a partial number (or 0 if all are missing the data point). We should cleanly differentiate between these scenarios beyond just shoving into the 'Missing Data' section (missing: string[];)~~
* **COMPLETED**: Recipe summaries now show:
  - Complete data: "$12.50"
  - No data: "No data available" 
  - Partial data: "$8.30 (3/5 ingredients)"
  - Missing data grouped by type: "Missing Data: Price (chicken, oil), Weight (salt)"
## ✅ add table debug column
* ~~Let's add a column (default hidden) on all tables that launches a `Dialog` that shows the raw json data of the given row.~~
* **COMPLETED**: Global debug toggle system implemented:
  - Debug toggle button in navigation (bug icon) 
  - Debug columns automatically appear on all tables when enabled
  - Dialog shows formatted JSON data with copy functionality
  - Persistent setting saved to localStorage
  - Responsive design for mobile and desktop
  - Centralized implementation in Table component
## make tables look better on mobile
* right now they are really wide and you have to laterally scroll.
## when querying USDA and we are logged out it just appears to not load
* server says `tRPC failed on usda.list: UNAUTHORIZED` but i think we just return null i think? and the table just shows `No results.`. Seems like we aren't passing through the error state all the way?