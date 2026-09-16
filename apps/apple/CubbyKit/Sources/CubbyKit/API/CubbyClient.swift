import CubbyAPI
import Foundation
import OpenAPIRuntime
import OpenAPIURLSession

/// The single typed path into `/api/v1`. Every operation the app, the widgets, and the CLI use is
/// a named method here; nothing loosely-typed survives (`CubbyDebugClient` exists only for the
/// CLI's `call` escape hatch).
///
/// Generic Browse lists and details go through `EntityDescriptor`'s generated switches, which
/// decode the typed page and then project it into `JSONValue` — the wire is typed even where the
/// screen is not.
public actor CubbyClient {
    public let baseURL: URL
    public let credentials: CredentialProvider
    private let api: Client
    private let gardenEditAPI: Client

    public init(baseURL: URL, credentials: CredentialProvider, session: URLSession = .cubbyShared) {
        self.baseURL = baseURL
        self.credentials = credentials
        let transport = URLSessionTransport(configuration: .init(session: session))
        let auth = CubbyAuthMiddleware(credentials: credentials)
        // The spec's `servers` entry is "/", so the base URL must always be supplied here.
        self.api = Client(
            serverURL: baseURL,
            configuration: .cubby,
            transport: transport,
            middlewares: [auth]
        )
        // Only full Garden editors encode nil as null. Generic attachment/order patches keep
        // using `api`, where omitted optional fields must never clear the entry's content.
        self.gardenEditAPI = Client(
            serverURL: baseURL,
            configuration: .cubby,
            transport: transport,
            middlewares: [auth, GardenEditEncodingMiddleware()]
        )
    }

    // MARK: - Products

    public func product(_ id: ProductCode) async throws -> ProductDetail {
        try await perform {
            try await api.resources_product_get(path: .init(id: id.rawValue)).ok.body.json
        }
    }

    public func findOrCreateProduct(upc: String, defaultName: String? = nil) async throws
        -> ProductFindOrCreateByUPCOut
    {
        try await perform {
            try await api.product_findOrCreateByUPC(body: .json(.init(upc: upc, defaultName: defaultName)))
                .ok.body.json
        }
    }

    /// Find-or-create by a raw scanned code, resolved server-side the way the web `/scan` page
    /// does: an ISBN becomes a book, a barcode a product, a product label the product itself; an
    /// unreadable code is the server's validation error.
    public func findOrCreateProduct(raw: String) async throws -> ProductFindOrCreateByUPCOut {
        try await perform {
            try await api.product_findOrCreateByCode(body: .json(.scan(.init(kind: .scan, value: raw))))
                .ok.body.json
        }
    }

    /// The photo backlog: products with no image, newest first. `location` narrows to one bin.
    public func productsMissingImages(
        page: Int = 1,
        pageSize: Int = 50,
        at location: LocationCode? = nil
    ) async throws -> ListPage<EntityRow> {
        var query = Operations.Resources_product_list.Input.Query(
            page: page, pageSize: pageSize, sort: "-createdAt")
        // A bare `.none` would read as `Optional.none`; `.some` pins it to the filter's own case.
        query.imagePresenceFilter = .some(.none)
        if let location { query.locationIdFilter = [.init(value1: location.rawValue)] }
        return try await productPage(query)
    }

    /// Products that are physically stocked somewhere — the only ones worth a Spotlight entry.
    public func stockedProducts(page: Int = 1, pageSize: Int = 200) async throws -> ListPage<EntityRow> {
        var query = Operations.Resources_product_list.Input.Query(page: page, pageSize: pageSize)
        query.relatedInventoryPresenceFilter = .has
        return try await productPage(query)
    }

    /// The ids of products that have at least one image, newest first. List rows carry image ids
    /// but no URLs, so the on-device cover index pages ids here and fetches each detail after.
    public func productIDsWithImages(page: Int = 1, pageSize: Int = 100) async throws -> ListPage<ProductCode>
    {
        var query = Operations.Resources_product_list.Input.Query(
            page: page, pageSize: pageSize, sort: "-createdAt")
        query.imagePresenceFilter = .has
        return try await perform {
            let result = try await api.resources_product_list(query: query).ok.body.json
            return ListPage(items: result.items.map(\.id), meta: result.meta)
        }
    }

    /// Existing products carrying `gtin` in any spelling (UPC-A, EAN-13, GTIN-14 — the server
    /// widens the term). A lookup, never a create: the Search tab shows what is already here.
    public func products(matchingBarcode gtin: String) async throws -> [EntityRow] {
        var query = Operations.Resources_product_list.Input.Query(page: 1, pageSize: 5, sort: "name")
        query.upcFilter = gtin
        return try await productPage(query).items
    }

    // MARK: - Garden

    public func gardenOverview() async throws -> GardenOverviewOut {
        try await perform { try await api.garden_overview().ok.body.json }
    }

    /// `search` (≥2 chars) widens the garden-scoped options set with prefix matches, for an
    /// "Add…" picker outside the household's existing garden associations.
    ///
    /// The generated `GardenOptionsInput` is currently self-referential — `scripts/generator/
    /// http-api/openapi.ts` registers the Zod wire projection and its `{ input: ... }`
    /// wrapper under the same `"GardenOptionsInput"` component id, so the wrapper's `input` field
    /// recurses into itself with no reachable `search` leaf (confirmed against the source Zod
    /// schema at `packages/schemas/src/garden.ts`, which does carry `search`). Until that
    /// generator bug is fixed upstream, `search` cannot be encoded on the wire; this always
    /// requests the unscoped body so callers do not have to change again once it can be.
    public func gardenOptions(search: String? = nil) async throws -> GardenOptions {
        try await perform {
            GardenOptions(try await api.garden_options(query: .init(search: search)).ok.body.json)
        }
    }

    public func gardenGuides() async throws -> GardenGuidesDocument {
        try await perform { try await api.garden_guides().ok.body.json }
    }

    public func createGardenPlanting(_ input: GardenCreatePlantingInput) async throws {
        try await perform { _ = try await api.garden_createPlanting(body: .json(input)).ok }
    }

    public func recordGardenEntry(_ input: GardenRecordEntryInput) async throws {
        _ = try await recordGardenEntryReturningID(input)
    }

    public func recordGardenEntryReturningID(_ input: GardenRecordEntryInput) async throws -> String {
        try await perform { try await api.garden_recordEntry(body: .json(input)).ok.body.json.id }
    }

    public func startGardenPlanting(
        id: String,
        locationID: String,
        startedAt: Date,
        method: GardenStartMethod
    ) async throws {
        try await perform {
            _ = try await api.garden_startPlanting(
                body: .json(
                    .init(
                        plantingId: id, locationId: LocationCode(locationID), startedOn: PlainDate(startedAt),
                        startMethod: .init(rawValue: method.rawValue)!))
            ).ok
        }
    }

    public func moveGardenPlanting(_ input: GardenMovePlantingInput) async throws {
        try await perform { _ = try await api.garden_movePlanting(body: .json(input)).ok }
    }

    public func splitGardenPlanting(_ input: GardenSplitPlantingInput) async throws {
        try await perform { _ = try await api.garden_splitPlanting(body: .json(input)).ok }
    }

    public func finishGardenPlanting(id: String, finishedAt: Date, note: String? = nil) async throws {
        try await perform {
            _ = try await api.garden_finishPlanting(
                body: .json(.init(plantingId: id, finishedOn: PlainDate(finishedAt), note: note))
            ).ok
        }
    }

    /// A garden bed or tray remains an ordinary `.area` location, with garden-only context held
    /// in its additive classification fields.
    public func createGardenLocation(name: String, kind: GardenLocationKind, conditions: String?) async throws
    {
        try await perform {
            _ = try await api.resources_location_create(
                body: .json(
                    .init(
                        name: name,
                        _type: .area,
                        gardenKind: kind,
                        gardenConditions: conditions
                    )
                )
            ).created
        }
    }

    public func updateGardenLocation(
        id: String, name: String?, kind: GardenLocationKind?, conditions: String?
    ) async throws {
        try await perform {
            _ = try await api.resources_location_update(
                path: .init(id: id),
                body: .json(
                    .init(
                        name: name,
                        gardenKind: kind,
                        gardenConditions: conditions
                    )
                )
            ).ok
        }
    }

    /// This association only says what the product grows; it never creates edible inventory.
    public func setGardenProduct(id: String, growsIngredientID: String?) async throws {
        try await perform {
            _ = try await api.resources_product_update(
                path: .init(id: id),
                body: .json(.init(growsIngredientId: growsIngredientID))
            ).ok
        }
    }

    public func setGardenIngredient(id: String, guideKey: String?) async throws {
        try await perform {
            _ = try await api.resources_ingredient_update(
                path: .init(id: id),
                body: .json(.init(gardenGuideKey: guideKey))
            ).ok
        }
    }

    /// Through `gardenEditAPI`, which encodes an absent editor field as `null`
    /// (`GardenEditEncodingMiddleware`): the draft is the complete editor value, not a patch.
    public func updateGardenPlanting(id: String, _ data: PlantingUpdateData) async throws {
        try await perform {
            _ = try await gardenEditAPI.resources_planting_update(path: .init(id: id), body: .json(data)).ok
        }
    }

    public func gardenEntry(id: String) async throws -> GardenEntryOut {
        try await perform {
            GardenEntryOut(try await api.resources_gardenEntry_get(path: .init(id: id)).ok.body.json)
        }
    }

    public func gardenPlanting(id: String) async throws -> GardenPlantingOut {
        try await perform {
            async let options = api.garden_options(query: .init()).ok.body.json
            let output = try await api.resources_planting_get(path: .init(id: id)).ok.body.json
            return GardenPlantingOut(output, options: try await options)
        }
    }

    public func gardenEntries(
        locationID: String? = nil, plantingID: String? = nil, page: Int = 1
    ) async throws -> (items: [GardenEntryOut], hasMore: Bool) {
        try await perform {
            let result = try await api.garden_entries(
                query: .init(locationId: locationID, plantingId: plantingID, page: page)
            ).ok.body.json
            return (result.items, result.hasMore)
        }
    }

    public func gardenJournal(
        plantingID: String, includeBedContext: Bool = false, page: Int = 1
    ) async throws -> (items: [GardenJournalEntryOut], hasMore: Bool) {
        try await perform {
            let result = try await api.garden_journal(
                query: .init(plantingId: plantingID, includeBedContext: includeBedContext, page: page)
            ).ok.body.json
            return (result.items, result.hasMore)
        }
    }

    public func gardenLocationHistory(plantingID: String) async throws -> [GardenLocationPeriodOut] {
        try await perform {
            try await api.garden_locationHistory(query: .init(plantingId: plantingID)).ok.body.json.periods
        }
    }

    public func correctGardenLocationDates(
        plantingID: String, periods: [GardenLocationPeriodOut]
    ) async throws -> [GardenLocationPeriodOut] {
        try await perform {
            try await api.garden_correctLocationDates(
                body: .json(
                    .init(
                        plantingId: plantingID,
                        periods: periods.map {
                            .init(
                                sequence: $0.sequence, inLocationSince: $0.inLocationSince,
                                endedOn: $0.endedOn)
                        }))
            ).ok.body.json.periods
        }
    }

    /// Through `gardenEditAPI`, which encodes an absent `plantingId`/`note`/`harvestAmount` as
    /// `null` (`GardenEditEncodingMiddleware`); an absent structural field (`locationId`, `kind`,
    /// `observedOn`) is left alone, so a locked field is simply omitted from the draft.
    public func updateGardenEntry(id: String, _ data: GardenEntryUpdateData) async throws {
        try await perform {
            _ = try await gardenEditAPI.resources_gardenEntry_update(path: .init(id: id), body: .json(data))
                .ok
        }
    }

    // MARK: - Generic entity access

    /// One page of rows for any entity the HTTP document lists.
    public func list(
        _ descriptor: EntityDescriptor,
        page: Int = 1,
        pageSize: Int = 50,
        sort: String? = nil
    ) async throws -> ListPage<EntityRow> {
        try await perform {
            let result = try await descriptor.listPage(
                client: api, page: page, pageSize: pageSize, sort: sort)
            return ListPage(items: result.items.compactMap(descriptor.row(from:)), meta: result.meta)
        }
    }

    /// One row by id, or `nil` when the server does not have it.
    public func row(_ descriptor: EntityDescriptor, id: String) async throws -> EntityRow? {
        do {
            return descriptor.row(from: try await descriptor.getRow(client: api, id: id))
        } catch {
            let error = CubbyAPIError.unwrapping(error)
            if let error = error as? CubbyAPIError, error.status == 404 { return nil }
            throw error
        }
    }

    // MARK: - Entity relationships

    public func exploreRelationships(root: EntityRef, depth: Int) async throws -> EntityGraph {
        let depth = min(3, max(1, depth))
        return try await perform {
            let output = try await api.entity_explore(
                body: .json(
                    .init(
                        root: root.graphRootInput,
                        depth: .init(value1: .init(rawValue: depth))
                    )
                )
            ).ok.body.json
            return EntityGraph(root: root, output: output)
        }
    }

    public func relationshipPage(
        root: EntityRef,
        relationshipKey: String,
        offset: Int,
        limit: Int
    ) async throws -> EntityGraphOutput {
        try await perform {
            try await api.entity_graph(
                body: .json(
                    .init(
                        roots: [root.graphRootInput],
                        relationshipKeys: [relationshipKey],
                        offset: offset,
                        limit: min(25, max(1, limit))
                    )
                )
            ).ok.body.json
        }
    }

    public func recommendations(for source: EntityRef) async throws -> EntityRecommendationsOut {
        try await perform {
            // `recommendations.forEntity` declares its own copy of the entity enum; match by raw value.
            try await api.recommendations_forEntity(
                query: .init(
                    entityType: .init(rawValue: source.entityType.rawValue)!, entityId: source.entityId)
            ).ok.body.json
        }
    }

    public func assignExpense(_ expenseID: String, toProject projectID: String) async throws {
        try await perform {
            _ = try await api.resources_expense_update(
                path: .init(id: expenseID),
                body: .json(.init(projectId: projectID))
            ).ok
        }
    }

    public func moveInventory(_ inventoryID: String, to locationID: String) async throws -> EntityRef {
        try await perform {
            let result = try await api.inventory_moveEntries(
                body: .json(
                    .init(items: [
                        .init(
                            inventoryEntryId: InventoryEntryCode(inventoryID),
                            targetLocationId: LocationCode(locationID))
                    ]))
            ).ok.body.json
            guard let survivor = result.items.first else { throw URLError(.cannotParseResponse) }
            return EntityRef(entity: .inventory, id: survivor.id.rawValue)
        }
    }

    // MARK: - Images

    /// Attaches already-uploaded images to any entity whose update body takes `pendingImageIds`.
    public func attachImages(_ ids: [ImageCode], to descriptor: EntityDescriptor, id: String) async throws {
        try await perform {
            try await descriptor.attachImages(ids, to: id, client: api)
        }
    }

    public func setImageOrder(_ ids: [ImageCode], on descriptor: EntityDescriptor, id: String) async throws {
        try await perform {
            try await descriptor.setImageOrder(ids, on: id, client: api)
        }
    }

    public func uploadImage(
        filename: String,
        size: Int,
        format: ImageEncoding.Format,
        entity: EntityKey
    ) async throws -> ImageUpload {
        try await perform {
            let output = try await api.image_uploadImage(
                body: .json(.init(filename: filename, size: size, format: format, entity: entity))
            )
            return try ImageUpload(try output.ok.body.json)
        }
    }

    public func uploadImage(_ request: ImageUploadRequest) async throws -> ImageUpload {
        try await perform {
            guard request.algorithmRevision == PerceptualHash64.algorithmRevision else {
                throw HashIndex.Failure.unsupportedRevision(request.algorithmRevision)
            }
            var input = InitiateUploadWithoutEntity(
                filename: request.filename, size: request.size, contentType: .imageJpeg)
            guard let contentType = type(of: input.contentType).init(rawValue: request.contentType) else {
                throw PhotoFile.Failure.unsupportedContentType(request.contentType)
            }
            input.contentType = contentType
            input.entityType = EntityImage(rawValue: request.entity.rawValue.uppercased())
            input.algorithmRevision = .init(rawValue: request.algorithmRevision)
            input.perceptualHash = request.perceptualHash.hex
            input.sourceFingerprint = .init(
                hash: request.sourceFingerprint.hash.hex,
                aspectRatio: request.sourceFingerprint.aspectRatio)
            input.width = request.width
            input.height = request.height
            let output = try await api.image_uploadImage(body: .json(input))
            return try ImageUpload(try output.ok.body.json)
        }
    }

    /// The server's hash index, or `HashIndex.Failure.unsupportedRevision` when it was computed
    /// with a different algorithm than this build carries.
    public func imageHashIndex() async throws -> ImageHashIndex {
        try await perform {
            let result = try await api.image_hashIndex().ok.body.json
            guard result.algorithmRevision.rawValue == PerceptualHash64.algorithmRevision else {
                throw HashIndex.Failure.unsupportedRevision(result.algorithmRevision.rawValue)
            }
            return result
        }
    }

    public func setPerceptualHashes(_ items: [ImageHashUpdate]) async throws -> SetPerceptualHashesOutput {
        try await perform {
            try await api.image_setPerceptualHashes(
                body: .json(
                    .init(
                        algorithmRevision: .init(rawValue: PerceptualHash64.algorithmRevision)!,
                        items: items.map { .init(id: $0.id, perceptualHash: $0.perceptualHash.hex) })
                )
            ).ok.body.json
        }
    }

    public func imageDetail(_ id: ImageCode) async throws -> ImageWithEntity {
        try await perform {
            try await api.image_detail(query: .init(id: id.rawValue)).ok.body.json
        }
    }

    /// The product's image ids in display order — the order `setImageOrder` rewrites. The detail
    /// payload's direct `attachments` carry full `ImageOut` bodies (URLs included); only the id is
    /// projected out here because that is all this call is for.
    public func productImageIDs(_ product: ProductCode) async throws -> [ImageCode] {
        try await perform {
            try await api.resources_product_get(path: .init(id: product.rawValue)).ok.body.json.attachments
                .map(\.id)
        }
    }

    public func markUploaded(_ id: ImageCode) async throws {
        try await perform {
            _ = try await api.image_markUploaded(body: .json(.init(id: id))).ok
        }
    }

    // MARK: - Scanning and inventory

    /// One raw scanner or keyboard value at a location, classified by the server: a barcode,
    /// an ISBN, a product label (legacy `P-` included), or a validation error naming why not.
    public func scan(raw: String, at location: LocationCode) async throws -> ScanAtLocationOut {
        try await perform {
            try await api.inventory_scanAtLocation(
                body: .json(
                    .init(locationId: location, code: .init(value1: .scan(.init(kind: .scan, value: raw)))))
            ).ok.body.json
        }
    }

    public func resolveStrays(to target: LocationCode, moves: [StrayMove]) async throws
        -> ResolveScanStraysOut
    {
        try await perform {
            try await api.inventory_resolveScanStrays(
                body: .json(
                    .init(
                        targetLocationId: target,
                        moves: moves.map {
                            .init(entryId: $0.entryId, quantity: $0.quantity.map { PositiveAmountInput($0) })
                        }))
            ).ok.body.json
        }
    }

    /// Creates an inventory row counted in units ("each"). Returns the new entry's shortcode.
    public func createInventory(
        product: ProductCode,
        at location: LocationCode,
        count: Double
    ) async throws -> InventoryEntryCode {
        try await perform {
            let output = try await api.resources_inventory_create(
                body: .json(
                    .init(productId: product, locationId: location, amount: .init(count)))
            )
            return try output.created.body.json.item.id
        }
    }

    /// The stock rows at these locations. `placement` is `stock`: installed rows are fixed
    /// fixtures the server keeps out of counting and audits.
    public func inventory(atLocations locations: [LocationCode]) async throws -> [RecountRow] {
        try await perform {
            let output = try await api.inventory_getByLocationIds(
                query: .init(locationIds: locations.map(\.rawValue), placement: .stock)
            )
            return try output.ok.body.json.map(RecountRow.init)
        }
    }

    /// Products stocked in more than one location, for the Duplicate badge.
    public func findDuplicates() async throws -> Set<ProductCode> {
        try await perform {
            Set(try await api.inventory_findDuplicates(query: .init()).ok.body.json.map(\.id))
        }
    }

    /// Commits one bin's recount. Throws a `CubbyAPIError` with `isStaleInventory` when the bin
    /// changed since it was read.
    public func reconcile(_ body: ReconcileSessionPayload) async throws -> [RecountRow] {
        try await perform {
            try await api.inventory_reconcileSession(body: .json(body)).ok.body.json.items.map(
                RecountRow.init)
        }
    }

    // MARK: - Locations

    public func locationTree() async throws -> LocationTree {
        try await perform {
            LocationTree(roots: try await api.location_makeTree().ok.body.json)
        }
    }

    /// Every location, by name, for the sweep's bin picker.
    public func locationOptions(page: Int = 1, pageSize: Int = 200) async throws -> ListPage<LocationListItem>
    {
        try await perform {
            let result = try await api.resources_location_list(
                query: .init(page: page, pageSize: pageSize, sort: "name")
            ).ok.body.json
            return ListPage(items: result.items, meta: result.meta)
        }
    }

    /// The global "Unknown" location, created on first use.
    public func ensureGlobalUnknownLocation() async throws -> LocationCode {
        try await perform {
            try await api.location_ensureGlobalUnknown(body: .json(.init())).ok.body.json.id
        }
    }

    /// Re-parents bins under `parent`. Returns how many changed.
    public func bulkUpdateParent(_ bins: [LocationCode], to parent: LocationCode?) async throws -> Int {
        try await perform {
            let output = try await api.location_bulkUpdateParent(
                body: .json(.init(ids: bins, parentId: parent))
            )
            return try output.ok.body.json.updated
        }
    }

    // MARK: - Search, dashboards, and the assistant

    /// `kinds` narrows to those entity types; `nil` searches every intent-exposed entity.
    public func search(_ text: String, kinds: [EntityKey]? = nil, limit: Int = 10) async throws -> [SearchHit]
    {
        let trimmed = String(
            text.trimmingCharacters(in: .whitespacesAndNewlines).prefix(SearchHit.maxQueryLength))
        guard !trimmed.isEmpty else { return [] }
        var query = Operations.Search_find.Input.Query(
            query: trimmed, limit: min(max(limit, 1), SearchHit.maxLimit)
        )
        // `search.find` declares its own copy of the searchable-entity enum, so catalog keys are
        // matched into it by raw value; a key it has not heard of is dropped rather than sent.
        query.entityTypes = (kinds ?? EntityCatalog.intentExposed.map(\.key)).compactMap {
            .init(rawValue: $0.rawValue)
        }
        return try await perform {
            try await api.search_find(query: query).ok.body.json
        }
    }

    public func dashboardCounts() async throws -> DashboardCountsOut {
        try await perform { try await api.dashboard_counts().ok.body.json }
    }

    /// `task.todayBriefing`'s `next` array: actionable tasks, already filtered and capped.
    public func todayBriefing() async throws -> [TaskTodayBriefingItemOut] {
        try await perform { try await api.task_todayBriefing().ok.body.json.next }
    }

    public func problemCounts() async throws -> ProblemsCount {
        try await perform { try await api.problems_getCounts().ok.body.json }
    }

    /// The meals planned for one household calendar day.
    public func meals(on date: Date) async throws -> [MealListItem] {
        let day = HouseholdDay.string(for: date)
        return try await perform {
            var query = Operations.Resources_meal_list.Input.Query(page: 1, pageSize: 20, sort: "date")
            query.from = day
            query.to = day
            return try await api.resources_meal_list(query: query).ok.body.json.items
        }
    }

    public func mealNutrition(mealID: String) async throws -> MealNutritionOut {
        let input = MealNutritionInput(value1: .init(mealId: mealID))
        return try await perform {
            try await api.meal_getNutrition(.init(body: .json(input))).ok.body.json
        }
    }

    public func mealNutrition(on day: String) async throws -> MealNutritionOut {
        let input = MealNutritionInput(value2: .init(date: day))
        return try await perform {
            try await api.meal_getNutrition(.init(body: .json(input))).ok.body.json
        }
    }

    public func lookupUPC(_ upc: String) async throws -> UpcLookupOutput {
        try await perform { try await api.upc_lookup(query: .init(upc: upc)).ok.body.json }
    }

    // MARK: - Internals

    private func productPage(
        _ query: Operations.Resources_product_list.Input.Query
    ) async throws -> ListPage<EntityRow> {
        let descriptor = EntityCatalog[.product]
        return try await perform {
            let result = try await api.resources_product_list(query: query).ok.body.json
            return ListPage(
                items: try result.items.compactMap { descriptor.row(from: try JSONValue(encoding: $0)) },
                meta: result.meta
            )
        }
    }

    /// OpenAPIRuntime wraps whatever a middleware throws in a `ClientError`, which would hide the
    /// `CubbyAPIError` every caller switches on. Every request goes through here so it does not.
    private func perform<T>(_ request: () async throws -> T) async throws -> T {
        do {
            return try await request()
        } catch {
            throw CubbyAPIError.unwrapping(error)
        }
    }

}

extension CubbyClient: EntityRelationshipsClient {}

extension CubbyClient: GardenService {}
