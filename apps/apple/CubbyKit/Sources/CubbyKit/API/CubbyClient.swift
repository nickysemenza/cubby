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

    public init(
        baseURL: URL, credentials: CredentialProvider, session: URLSession = .cubbyShared,
        requestObserver: (any RequestObserver)? = nil
    ) {
        self.baseURL = baseURL
        self.credentials = credentials
        let transport = URLSessionTransport(configuration: .init(session: session))
        let auth = CubbyAuthMiddleware(credentials: credentials, observer: requestObserver)
        // The spec's `servers` entry is "/", so the base URL must always be supplied here.
        // `PatchNullMiddleware` is inert unless `update(_:id:patch:)` scopes cleared keys around
        // a call, so every other request through `api` keeps its omitted-field semantics.
        self.api = Client(
            serverURL: baseURL,
            configuration: .cubby,
            transport: transport,
            middlewares: [auth, PatchNullMiddleware()]
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

    // MARK: - Generic entity access

    /// One page of rows for any entity the HTTP document lists. `filters` are keyed by the list
    /// route's query parameter names (`FilterDescriptor.wire`); an unknown name throws
    /// `EntityFilterError` before any request.
    public func list(
        _ descriptor: EntityDescriptor,
        page: Int = 1,
        pageSize: Int = 50,
        sort: String? = nil,
        filters: EntityFilterState = EntityFilterState()
    ) async throws -> ListPage<EntityRow> {
        try await perform {
            let result = try await descriptor.listPage(
                client: api, page: page, pageSize: pageSize, sort: sort, filters: filters)
            return ListPage(items: result.items.compactMap(descriptor.row(from:)), meta: result.meta)
        }
    }

    /// `resources.<entity>.timeline` for the same filter state a list takes, plus `ids`, `from`,
    /// `to` and `order` under their wire names.
    public func timeline(
        _ descriptor: EntityDescriptor, filters: EntityFilterState = EntityFilterState()
    ) async throws -> EntityTimelineOut {
        try await perform { try await descriptor.timeline(client: api, filters: filters) }
    }

    /// `resources.<entity>.create` from an editor's draft; returns the new record's id. The body
    /// is decoded into the typed create payload first, so an unknown key or malformed value fails
    /// before any request.
    public func create(_ descriptor: EntityDescriptor, body: [String: JSONValue]) async throws -> String {
        try await perform { try await descriptor.create(.object(body), client: api) }
    }

    /// `resources.<entity>.update` from an editor's patch: changed values travel in the typed
    /// body, cleared keys as `null` through `PatchNullMiddleware` (the generated client can only
    /// omit an optional, and an omitted field means "leave as is"). An empty patch sends nothing.
    public func update(_ descriptor: EntityDescriptor, id: String, patch: EntityPatch) async throws {
        guard !patch.isEmpty else { return }
        try await perform {
            try await PatchNullMiddleware.$clearedFields.withValue(patch.cleared) {
                try await descriptor.update(.object(patch.values), id: id, client: api)
            }
        }
    }

    /// `resources.<entity>.delete`; throws `EntityOperationError.unsupported` for an entity whose
    /// delete operation the generated client does not carry.
    public func delete(_ descriptor: EntityDescriptor, id: String) async throws {
        try await perform { try await descriptor.delete(id: id, client: api) }
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
            if let entity = request.entity {
                input.entityType = EntityImage(rawValue: entity.rawValue.uppercased())
            }
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

    /// Presigns a PDF evidence upload. The returned image id remains pending until
    /// `markUploaded(_:)` succeeds after the exact bytes have been PUT.
    public func uploadDocument(filename: String, size: Int, folder: String? = nil) async throws
        -> ImageUpload
    {
        try await perform {
            let input = Components.Schemas.InitiateDocumentUpload(
                filename: filename, size: size, contentType: .applicationPdf, folder: folder)
            let output = try await api.image_uploadDocument(body: .json(input))
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

    public func stagePhotoImport(_ input: PhotoImportStageInput) async throws
        -> PhotoImportStageOutput
    {
        try await perform {
            try await api.photoImport_stage(body: .json(input)).ok.body.json
        }
    }

    public func commitPhotoImport(_ input: PhotoImportCommitInput) async throws
        -> PhotoImportCommitOutput
    {
        try await perform {
            try await api.photoImport_commit(body: .json(input)).ok.body.json
        }
    }

    /// Waits for any in-flight commit touching these rows, then returns one
    /// transactionally consistent status and direct-association snapshot.
    public func reconcilePhotoImport(_ imageIDs: [ImageCode]) async throws
        -> PhotoImportReconcileOutput
    {
        try await perform {
            try await api.photoImport_reconcile(
                body: .json(PhotoImportReconcileInput(imageIds: imageIDs))
            ).ok.body.json
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

    /// The device-run local analysis persisted at import time (`photo-local-analysis`), or `nil`
    /// when none has been recorded yet (`image.analysis` turns a `null` result into a 404, per
    /// `router.ts`'s nullable-output convention — the same shape `row(_:id:)` above unwraps).
    public func imageAnalysis(_ id: ImageCode) async throws -> ImageAnalysisOutput? {
        do {
            return try await api.image_analysis(query: .init(id: id.rawValue)).ok.body.json
        } catch {
            let error = CubbyAPIError.unwrapping(error)
            if let error = error as? CubbyAPIError, error.status == 404 { return nil }
            throw error
        }
    }

    /// Backfills a device-run analysis onto an already-uploaded image. The server re-checks
    /// `status`/`sha256` transactionally and refuses with `IMAGE_PRECONDITION_FAILED` when the
    /// analysis does not describe the row's current bytes; this wrapper only marshals the value —
    /// this `analysis` payload is a distinct generated type from `ImageAnalysisOutput` above (the
    /// OpenAPI generator does not dedupe structurally-identical schemas across routes), so its
    /// fields are read by property and its `.init(...)` types inferred from context, never spelled.
    public func recordImageAnalysis(_ id: ImageCode, _ analysis: ImageAnalysisOutput) async throws
        -> Bool
    {
        try await perform {
            try await api.image_recordAnalysis(
                body: .json(
                    .init(
                        id: id.rawValue,
                        analysis: .init(
                            analysisVersion: analysis.analysisVersion,
                            analyzedAt: analysis.analyzedAt,
                            sha256: analysis.sha256,
                            capturedAt: analysis.capturedAt,
                            contentType: analysis.contentType,
                            width: analysis.width,
                            height: analysis.height,
                            classifications: analysis.classifications.map {
                                .init(identifier: $0.identifier, confidence: $0.confidence)
                            },
                            recognizedText: analysis.recognizedText.map {
                                .init(text: $0.text, confidence: $0.confidence)
                            },
                            featurePrint: .init(
                                revision: analysis.featurePrint.revision,
                                data: analysis.featurePrint.data),
                            provenance: .init(
                                source: .init(rawValue: analysis.provenance.source.rawValue)!,
                                localIdentifier: analysis.provenance.localIdentifier,
                                filename: analysis.provenance.filename)
                        )
                    )
                )
            ).ok.body.json.saved
        }
    }

    /// The entity's image ids in display order — the order `setImageOrder` rewrites. The detail
    /// payload's `attachments` carry full bodies (URLs included); only the id is projected out
    /// here because that is all this call is for.
    public func imageIDs(_ descriptor: EntityDescriptor, id: String) async throws -> [ImageCode] {
        try await perform {
            descriptor.row(from: try await descriptor.getRow(client: api, id: id))?.imageIDs ?? []
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
        // `search.find`'s query declares its own searchable-entity enum, so catalog keys are
        // matched into it by raw value; a key it has not heard of is dropped rather than sent. Hits
        // name their entity by raw string (`SearchHit.key` is nil for an undeclared kind).
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
