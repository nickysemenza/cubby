import CubbyAPI
import Foundation
import HTTPTypes

/// The single typed path into `/api/operations`. Every operation the app, the widgets, and the CLI use is
/// a named method here; nothing loosely-typed survives (`CubbyDebugClient` exists only for the
/// CLI's `call` escape hatch).
///
/// Generic Browse lists and details go through `EntityDescriptor`'s generated switches, which
/// decode the typed page and then project it into `JSONValue` — the wire is typed even where the
/// screen is not.
public actor CubbyClient {
    public let baseURL: URL
    public let credentials: CredentialProvider
    let nativeTransport: NativeHTTPTransport

    public init(
        baseURL: URL, credentials: CredentialProvider, identity: ClientIdentity = .unknown,
        session: URLSession = .cubbyShared,
        requestObserver: (any RequestObserver)? = nil
    ) {
        self.baseURL = baseURL
        self.credentials = credentials
        self.nativeTransport = NativeHTTPTransport(
            baseURL: baseURL, credentials: credentials, identity: identity, session: session,
            observer: requestObserver)
    }

    // MARK: - Products

    public func product(_ id: ProductCode) async throws -> ProductDetail {
        guard let row = try await EntityCatalog[.product].getRow(client: self, id: id.rawValue) else {
            throw DecodingError.dataCorrupted(
                .init(codingPath: [], debugDescription: "Product detail returned null"))
        }
        return try row.decoded()
    }

    /// Find-or-create by a raw scanned code, resolved server-side: an ISBN becomes a book, a
    /// barcode a product, a product label the product itself; an unreadable code is the server's
    /// validation error.
    public func findOrCreateProduct(raw: String) async throws -> ProductFindOrCreateByUPCOut {
        return try await native_product_findOrCreateByCode(body: .scan(.init(kind: .scan, value: raw)))
    }

    /// The photo backlog: products with no image, newest first. `location` narrows to one bin.
    public func productsMissingImages(
        page: Int = 1,
        pageSize: Int = 50,
        at location: LocationCode? = nil
    ) async throws -> ListPage<EntityRow> {
        var filters = EntityFilterState(["imagePresenceFilter": ["none"]])
        if let location { filters.set([location.rawValue], for: "locationIdFilter") }
        return try await list(
            EntityCatalog[.product], page: page, pageSize: pageSize, sort: "-createdAt", filters: filters)
    }

    /// Products that are physically stocked somewhere — the only ones worth a Spotlight entry.
    public func stockedProducts(page: Int = 1, pageSize: Int = 200) async throws -> ListPage<EntityRow> {
        try await list(
            EntityCatalog[.product], page: page, pageSize: pageSize,
            filters: EntityFilterState(["relatedInventoryPresenceFilter": ["has"]]))
    }

    /// The ids of products that have at least one image, newest first. List rows carry image ids
    /// but no URLs, so the on-device cover index pages ids here and fetches each detail after.
    public func productIDsWithImages(page: Int = 1, pageSize: Int = 100) async throws -> ListPage<ProductCode>
    {
        let rows = try await list(
            EntityCatalog[.product], page: page, pageSize: pageSize, sort: "-createdAt",
            filters: EntityFilterState(["imagePresenceFilter": ["has"]]))
        return ListPage(items: rows.items.map { ProductCode($0.id) }, meta: rows.meta)
    }

    /// Existing products carrying `gtin` in any spelling (UPC-A, EAN-13, GTIN-14 — the server
    /// widens the term). A lookup, never a create: the Search tab shows what is already here.
    public func products(matchingBarcode gtin: String) async throws -> [EntityRow] {
        try await list(
            EntityCatalog[.product], page: 1, pageSize: 5, sort: "name",
            filters: EntityFilterState(["upcFilter": [gtin]])
        ).items
    }

    // MARK: - Generic entity access

    public func fieldExplanation(
        subject: EntityRef, field: String, surface: String = "detail"
    ) async throws -> FieldExplanationOutput {
        let entityKind = subject.entity
        return try await native_fieldExplanation_explain(
            body: .init(
                entityKind: entityKind, entityId: subject.id, field: field,
                surface: .init(rawValue: surface))
        )
    }

    /// One page of rows through the entity's generated native read kind. `filters` are keyed by
    /// `FilterDescriptor.wire`; an unknown name throws `EntityFilterError` before any request.
    public func list(
        _ descriptor: EntityDescriptor,
        page: Int = 1,
        pageSize: Int = 50,
        sort: String? = nil,
        filters: EntityFilterState = EntityFilterState(),
        groupBy: [ListGroupDimension] = []
    ) async throws -> ListPage<EntityRow> {
        switch descriptor.key.nativeReadKind {
        case .usdaFood:
            return try await usdaFoodPage(
                descriptor, page: page, pageSize: pageSize, sort: sort, filters: filters)
        case .kernel:
            let result = try await descriptor.listPage(
                client: self, page: page, pageSize: pageSize, sort: sort, filters: filters,
                groupBy: groupBy)
            return ListPage(
                items: result.items.compactMap(descriptor.row(from:)), meta: result.meta)
        case .unavailable:
            throw EntityOperationError.unsupported(descriptor.key, .list)
        }
    }

    /// `entity.timeline` for the same filter state a list takes, plus `ids`, `from`,
    /// `to` and `order` under their wire names.
    public func timeline(
        _ descriptor: EntityDescriptor, filters: EntityFilterState = EntityFilterState()
    ) async throws -> EntityTimelineOut {
        return try await descriptor.timeline(client: self, filters: filters)
    }

    /// `entity.mutate` create from an editor's draft; returns the new record's id. The server
    /// parses the body with the entity's create schema, so an unknown key is its 400.
    public func create(_ descriptor: EntityDescriptor, body: [String: JSONValue]) async throws -> String {
        return try await descriptor.create(.object(body), client: self)
    }

    /// `entity.mutate` update from an editor's patch: changed values and the cleared keys as
    /// `null` (an omitted field means "leave as is"). An empty patch sends nothing.
    public func update(_ descriptor: EntityDescriptor, id: String, patch: EntityPatch) async throws {
        guard !patch.isEmpty else { return }
        var body = patch.values
        for key in patch.cleared { body[key] = .null }
        return try await descriptor.update(.object(body), id: id, client: self)
    }

    /// Applies one atomic catalog bulk update. Explicit nulls clear fields; omitted fields stay unchanged.
    public func bulkUpdate(
        _ descriptor: EntityDescriptor, ids: [String], data: [String: JSONValue]
    ) async throws -> Int {
        return try await descriptor.bulkUpdate(.object(data), ids: ids, client: self)
    }

    /// `entity.mutate` delete. Destructive: only `HeroActionRunner` calls it, and only after
    /// the person confirmed behind the connection-impact preview.
    public func delete(_ descriptor: EntityDescriptor, id: String) async throws {
        return try await descriptor.delete(id: id, client: self)
    }

    /// One image with its owning records through the kernel `get` every entity shares. The
    /// detail read is a superset of the photo views' `ImageWithEntity`, which it projects to.
    public func imageDetail(id: String) async throws -> ImageWithEntity {
        guard let row = try await EntityCatalog[.image].getRow(client: self, id: id) else {
            throw DecodingError.dataCorrupted(
                .init(codingPath: [], debugDescription: "Image detail returned null"))
        }
        return try row.decoded()
    }

    /// One row by id, or `nil` when the server does not have it.
    public func row(_ descriptor: EntityDescriptor, id: String) async throws -> EntityRow? {
        switch descriptor.key.nativeReadKind {
        case .usdaFood:
            guard let fdcID = Int(id) else {
                throw EntityFilterError.invalidValue(
                    parameter: "id", value: id, expected: "a numeric FDC ID")
            }
            guard let food = try await native_usdaFood_detail(body: .init(id: fdcID)) else {
                return nil
            }
            let raw = try usdaFoodJSON(food)
            return descriptor.row(from: raw)
        case .kernel:
            guard let raw = try await descriptor.getRow(client: self, id: id) else { return nil }
            return descriptor.row(from: raw)
        case .unavailable:
            throw EntityOperationError.unsupported(descriptor.key, .get)
        }
    }

    // MARK: - Entity relationships

    public func runSnapshot(runID: RunShortcode) async throws -> RunSnapshot {
        let snapshot = try await runWorkSnapshot(.init(runId: runID))
        return try RunSnapshot(JSONValue(encoding: snapshot))
    }

    public func discoveryRunSnapshot(runID: RunShortcode) async throws -> RunSnapshot {
        try await runSnapshot(runID: runID)
    }

    public func storedConnections(_ input: EntityGraphRootInput) async throws -> ConnectionDiscoveryOut {
        let kind = input.entityKind
        return try await readConnections(.init(entityKind: kind, entityId: input.entityId))
    }

    /// Physical graph edges and the advisory disposition for delete or merge.
    public func physicalConnections(id: String, previewDelete: Bool = false) async throws
        -> EntityConnectionsOut
    {
        return try await native_entity_connections(
            body: .init(id: id, operation: previewDelete ? .delete : nil)
        )
    }

    public func connectedRecords(
        source: EntityRef, viewKey: String, offset: Int = 0, limit: Int = 20,
        targetIDs: [String]? = nil
    ) async throws -> ConnectedRecordsOutput {
        return try await native_entity_connectedRecords(
            body:
                .init(
                    source: source.graphRootInput, viewKey: viewKey,
                    targetIds: targetIDs, offset: offset, limit: limit
                )
        )
    }

    /// Declared relation rows with server-owned provenance and explicit pagination.
    public func relationRows(
        source: EntityRef, relation: String, targetIDs: [String]? = nil,
        offset: Int = 0, limit: Int = 50
    ) async throws -> JSONValue {
        guard
            let entity = EntityRelationInputEntity.allCases.first(where: {
                $0.rawValue == source.entity.rawValue
            }),
            let relationKey = EntityRelationInputRelation.allCases.first(where: { $0.rawValue == relation })
        else {
            throw DecodingError.dataCorrupted(
                .init(
                    codingPath: [],
                    debugDescription:
                        "entity.relation does not support \(source.entity.rawValue).\(relation)"))
        }
        return try JSONValue(
            encoding: try await native_entity_relation(
                body: .init(
                    entity: entity, relation: relationKey, id: source.id,
                    offset: offset, limit: limit, targetIds: targetIDs)
            ))
    }

    /// Every curated connected view of `source` in manifest order: each view's complete count and
    /// its first `limit` rows.
    public func connectedRecordsPreview(source: EntityRef, limit: Int = 3) async throws
        -> ConnectedRecordsPreviewOutput
    {
        return try await native_entity_connectedRecordsPreview(
            body: .init(source: source.graphRootInput, limit: limit)
        )
    }

    public func exploreRelationships(root: EntityRef, depth: Int) async throws -> EntityGraph {
        let depth = min(3, max(1, depth))
        let output = try await native_entity_explore(
            body:
                .init(
                    root: root.graphRootInput,
                    depth: .init(rawValue: Double(depth))
                )

        )
        return EntityGraph(root: root, output: output)
    }

    public func relationshipPage(
        root: EntityRef,
        relationshipKey: String,
        offset: Int,
        limit: Int
    ) async throws -> EntityGraphOutput {
        return try await native_entity_graph(
            body:
                .init(
                    roots: [root.graphRootInput],
                    relationshipKeys: [relationshipKey],
                    offset: offset,
                    limit: min(25, max(1, limit))
                )

        )
    }

    public func recommendations(for source: EntityRef) async throws -> EntityRecommendationsOut {
        return  // `recommendations.forEntity` declares its own copy of the entity enum; match by raw value.
            try await native_recommendations_forEntity(
                body: .init(
                    entityKind: .init(rawValue: source.entityKind.rawValue)!, entityId: source.entityId)
            )
    }

    public func assignExpense(_ expenseID: String, toProject projectID: String) async throws {
        return try await EntityCatalog[.expense].update(
            ["projectId": .string(projectID)], id: expenseID, client: self)
    }

    public func moveInventory(_ inventoryID: String, to locationID: String) async throws -> EntityRef {
        let result = try await native_inventory_moveEntries(
            body:
                .init(items: [
                    .init(
                        inventoryEntryId: InventoryEntryCode(inventoryID),
                        targetLocationId: LocationCode(locationID))
                ])
        )
        guard let survivor = result.items.first else { throw URLError(.cannotParseResponse) }
        return EntityRef(entity: .inventory, id: survivor.id.rawValue)
    }

    // MARK: - Images

    /// One bounded, transactional library sighting page (`image.recordSightings`); the server
    /// upserts by image/owner/asset key, so a resent page changes nothing.
    public func recordImageSightings(_ items: [ImageSightingRecordItem]) async throws {
        guard !items.isEmpty else { return }
        _ = try await native_image_recordSightings(body: .init(items: items))
    }

    /// Attaches already-uploaded images to any entity whose update body takes `pendingImageIds`.
    public func attachImages(_ ids: [ImageCode], to descriptor: EntityDescriptor, id: String) async throws {
        return try await descriptor.attachImages(ids, to: id, client: self)
    }

    public func setImageOrder(_ ids: [ImageCode], on descriptor: EntityDescriptor, id: String) async throws {
        return try await descriptor.setImageOrder(ids, on: id, client: self)
    }

    public func uploadImage(
        filename: String,
        size: Int,
        format: ImageEncoding.Format,
        entity: EntityKey
    ) async throws -> ImageUpload {
        let output = try await native_image_uploadImage(
            body: .init(filename: filename, size: size, format: format, entity: entity)
        )
        return try ImageUpload(output)
    }

    public func uploadImage(_ request: ImageUploadRequest) async throws -> ImageUpload {
        guard request.algorithmRevision == PerceptualHash64.algorithmRevision else {
            throw HashIndex.Failure.unsupportedRevision(request.algorithmRevision)
        }
        var input = InitiateUploadWithoutEntity(
            filename: request.filename, size: request.size, contentType: .imageJpeg)
        guard
            let contentType = type(of: input.contentType).allCases.first(where: {
                $0.rawValue == request.contentType
            })
        else {
            throw PhotoFile.Failure.unsupportedContentType(request.contentType)
        }
        input.contentType = contentType
        if let entity = request.entity {
            input.entityKind = EntityImage(rawValue: entity.rawValue.uppercased())
        }
        input.algorithmRevision = .init(rawValue: Double(request.algorithmRevision))
        input.perceptualHash = request.perceptualHash.hex
        input.sourceFingerprint = .init(
            hash: request.sourceFingerprint.hash.hex,
            aspectRatio: request.sourceFingerprint.aspectRatio)
        input.width = request.width
        input.height = request.height
        let output = try await native_image_uploadImage(body: input)
        return try ImageUpload(output)
    }

    /// Presigns a PDF evidence upload. The returned image id remains pending until
    /// `markUploaded(_:)` succeeds after the exact bytes have been PUT.
    public func uploadDocument(filename: String, size: Int, folder: String? = nil) async throws
        -> ImageUpload
    {
        let input = InitiateDocumentUpload(
            filename: filename, size: size, contentType: .applicationPdf, folder: folder)
        let output = try await native_image_uploadDocument(body: input)
        return try ImageUpload(output)
    }

    /// The server's hash index, or `HashIndex.Failure.unsupportedRevision` when it was computed
    /// with a different algorithm than this build carries.
    public func imageHashIndex() async throws -> ImageHashIndex {
        let result = try await native_image_hashIndex()
        guard let revision = Int(exactly: result.algorithmRevision.rawValue) else {
            throw UnsupportedNativeResponse(
                context: "image hash algorithm revision", raw: .number(result.algorithmRevision.rawValue))
        }
        guard revision == PerceptualHash64.algorithmRevision else {
            throw HashIndex.Failure.unsupportedRevision(revision)
        }
        return result
    }

    public func setPerceptualHashes(_ items: [ImageHashUpdate]) async throws -> SetPerceptualHashesOutput {
        return try await native_image_setPerceptualHashes(
            body:
                .init(
                    algorithmRevision: .init(rawValue: Double(PerceptualHash64.algorithmRevision)),
                    items: items.map { .init(id: $0.id, perceptualHash: $0.perceptualHash.hex) })

        )
    }

    /// Household-wide audit entries, newest first. The opaque cursor is passed back unchanged.
    public func auditHistory(cursor: String? = nil, limit: Int = 50) async throws -> AuditLogListOut {
        return try await native_auditLog_list(body: .init(limit: Double(limit), cursor: cursor))
    }

    /// The device-run local analysis persisted at import time (`photo-local-analysis`), or `nil`
    /// when none has been recorded yet. Null is a successful operation result.
    public func imageAnalysis(_ id: ImageCode) async throws -> ImageAnalysisOutputValue? {
        return try await native_image_analysis(body: .init(id: id.rawValue))
    }

    /// Backfills a device-run analysis onto an already-uploaded image. The server re-checks
    /// `status`/`sha256` transactionally and refuses with `IMAGE_PRECONDITION_FAILED` when the
    /// analysis does not describe the row's current bytes; this wrapper only marshals the value —
    /// the request declaration owns its analysis input type; fields are projected explicitly from
    /// the output so server-side enrichment cannot leak into the write.
    public func recordImageAnalysis(_ id: ImageCode, _ analysis: ImageAnalysisOutputValue) async throws
        -> Bool
    {
        return try await native_image_recordAnalysis(
            body:
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
                            source: .init(rawValue: analysis.provenance.source.rawValue),
                            localIdentifier: analysis.provenance.localIdentifier,
                            filename: analysis.provenance.filename)
                    )
                )

        ).saved
    }

    /// The entity's image ids in display order — the order `setImageOrder` rewrites. The detail
    /// payload's `attachments` carry full bodies (URLs included); only the id is projected out
    /// here because that is all this call is for.
    public func imageIDs(_ descriptor: EntityDescriptor, id: String) async throws -> [ImageCode] {
        guard let raw = try await descriptor.getRow(client: self, id: id) else { return [] }
        return descriptor.row(from: raw)?.imageIDs ?? []
    }

    public func markUploaded(_ id: ImageCode) async throws {
        _ = try await native_image_markUploaded(body: .init(id: id))
    }

    /// Idempotent device-side status for one photo-run image target
    /// (`PhotoImportRunUploader`'s queued/running/paused/failed telemetry as it works through a
    /// run). Repeating the same `(run, image, state)` is a server no-op, so callers may fire this
    /// without tracking whether a previous report for the same state landed.
    public func reportRunDeviceWork(
        run: RunShortcode, image: ImageCode, state: RunTargetDeviceWorkState, error: String? = nil
    ) async throws -> Bool {
        return try await native_run_reportDeviceWork(
            body: .init(run: run, image: image, state: state, error: error)
        ).recorded
    }

    // MARK: - Scanning and inventory

    /// One raw scanner or keyboard value at a location, classified by the server: a barcode,
    /// an ISBN, a product label (legacy `P-` included), or a validation error naming why not.
    public func scan(raw: String, at location: LocationCode) async throws -> ScanAtLocationOut {
        return try await native_inventory_scanAtLocation(
            body:
                .init(locationId: location, code: .value1(.scan(.init(kind: .scan, value: raw))))
        )
    }

    public func resolveStrays(to target: LocationCode, moves: [StrayMove]) async throws
        -> ResolveScanStraysOut
    {
        return try await native_inventory_resolveScanStrays(
            body:
                .init(
                    targetLocationId: target,
                    moves: moves.map {
                        .init(entryId: $0.entryId, quantity: $0.quantity.map { PositiveAmountInput($0) })
                    })
        )
    }

    /// Creates an inventory row counted in units ("each"). Returns the new entry's shortcode.
    public func createInventory(
        product: ProductCode,
        at location: LocationCode,
        count: Double
    ) async throws -> InventoryEntryCode {
        let body: JSONValue = [
            "productId": .string(product.rawValue), "locationId": .string(location.rawValue),
            "amount": try JSONValue(encoding: PositiveAmountInput(count)),
        ]
        return InventoryEntryCode(try await EntityCatalog[.inventory].create(body, client: self))
    }

    /// An atomic view of one bin. The opaque token guards both row membership and ownership facts
    /// that a row timestamp cannot cover.
    public func inventorySnapshot(at location: LocationCode) async throws -> RecountSnapshot {
        let output = try await native_inventory_locationSnapshot(
            body: .init(locationId: location, placement: .stock)
        )
        return RecountSnapshot(rows: output.items.map(RecountRow.init), token: output.snapshotToken)
    }

    /// Products stocked in more than one location, for the Duplicate badge.
    public func findDuplicates() async throws -> Set<ProductCode> {
        return Set(try await native_inventory_findDuplicates(body: .init()).map(\.id))
    }

    /// Commits one bin's recount. Throws a `CubbyAPIError` with `isStaleInventory` when the bin
    /// changed since it was read.
    public func reconcile(_ body: ReconcileSessionPayload) async throws -> [RecountRow] {
        return try await native_inventory_reconcileSession(body: body).items.map(
            RecountRow.init)
    }

    // MARK: - Locations

    public func locationTree() async throws -> LocationTree {
        return LocationTree(roots: try await native_location_makeTree())
    }

    // MARK: - Specialist list presentations

    public func mealCalendar(from start: String, to end: String) async throws -> CalendarRangeOut {
        return try await native_calendar_range(
            body:
                .init(
                    startDate: .init(rawValue: start),
                    endDateExclusive: .init(rawValue: end), kinds: [.meal])
        )
    }

    public func reorderTask(_ id: String, rank: Double) async throws {
        try await reorderTasks([(id, rank)])
    }

    public func reorderTasks(_ ranks: [(String, Double)]) async throws {
        let input = TaskBulkReorderInput(
            ranks: ranks.map { .init(id: .init($0.0), sortOrder: $0.1) })
        _ = try await native_task_bulkReorder(body: input)
    }

    public func todayBriefing() async throws -> EntityReportOut {
        try await entityReport(
            slot: .taskBriefing,
            scope: .object(["kind": .string("list"), "entity": .string("task"), "filters": .object([:])]))
    }

    /// Every location, by name, for the sweep's bin picker.
    public func locationOptions(page: Int = 1, pageSize: Int = 200) async throws -> ListPage<LocationChoice> {
        let rows = try await list(EntityCatalog[.location], page: page, pageSize: pageSize, sort: "name")
        return ListPage(
            items: rows.items.map {
                LocationChoice(
                    id: LocationCode($0.id), name: $0.raw["name"]?.stringValue ?? $0.title,
                    parentName: $0.raw["parent"]?["name"]?.stringValue)
            },
            meta: rows.meta)
    }

    /// The global "Unknown" location, created on first use.
    public func ensureGlobalUnknownLocation() async throws -> LocationCode {
        return try await native_location_ensureGlobalUnknown().id
    }

    // MARK: - Search, dashboards, and the assistant

    /// `kinds` narrows to those entity types; `nil` searches every intent-exposed entity.
    public func search(_ text: String, kinds: [EntityKey]? = nil, limit: Int = 10) async throws -> [SearchHit]
    {
        let trimmed = String(
            text.trimmingCharacters(in: .whitespacesAndNewlines).prefix(SearchHit.maxQueryLength))
        guard !trimmed.isEmpty else { return [] }
        var query = SearchQueryInput(
            query: trimmed, limit: min(max(limit, 1), SearchHit.maxLimit)
        )
        // `search.find`'s body declares its own searchable-entity enum, so catalog keys are
        // matched into it by raw value; a key it has not heard of is dropped rather than sent. Hits
        // name their entity by raw string (`SearchHit.key` is nil for an undeclared kind).
        query.entityKinds = (kinds ?? EntityCatalog.intentExposed.map(\.key)).map(\.rawValue)
        return try await native_search_find(body: query)
    }

    public func requestCatchUp() async throws {
        // This operation declares no input, so its shared envelope omits the input key.
        _ = try await native_maintenance_requestCatchUp()
    }

    /// The meals planned for one household calendar day.
    public func meals(on date: Date) async throws -> [EntityRow] {
        let day = HouseholdDay.string(for: date)
        return try await list(
            EntityCatalog[.meal], page: 1, pageSize: 20, sort: "date",
            filters: EntityFilterState(["from": [day], "to": [day]])
        ).items
    }

    public func mealNutrition(mealID: String) async throws -> MealNutritionOut {
        let input = MealNutritionInput.value1(.init(mealId: mealID))
        return try await native_meal_getNutrition(body: input)
    }

    public func mealNutrition(on day: String) async throws -> MealNutritionOut {
        let input = MealNutritionInput.value2(.init(date: day))
        return try await native_meal_getNutrition(body: input)
    }

    /// The server-composed blocks (stats, chart, table, schedule, note) behind a detail slot.
    public func entityReport(slot: ReportSlot, id: String, cursor: String? = nil) async throws
        -> EntityReportOut
    {
        try await entityReport(
            slot: slot, scope: .object(["kind": .string("record"), "id": .string(id)]), cursor: cursor)
    }

    /// The scope is validated by the chosen report, including its accepted filters.
    public func entityReport(slot: ReportSlot, scope: JSONValue, cursor: String? = nil) async throws
        -> EntityReportOut
    {
        var fields: [String: JSONValue] = ["slot": .string(slot.rawValue), "scope": scope]
        if let cursor { fields["cursor"] = .string(cursor) }
        return try await request("entityReport.get", body: JSONValue.object(fields))
    }

    /// Several slots of one record in one read; the server loads the record once for all of them.
    public func entityReports(slots: [ReportSlot], id: String) async throws
        -> [(ReportSlot, EntityReportOut)]
    {
        let wanted = slots
        let out = try await native_entityReport_getMany(body: .init(slots: wanted, id: id))
        return out.reports.map { ($0.slot, $0.report) }
    }

    public func lookupUPC(_ upc: String) async throws -> UpcLookupOutputValue? {
        return try await native_upc_lookup(body: .init(upc: upc))
    }

    // MARK: - Internals

    // MARK: - USDA catalog reads

    /// USDA foods are the external catalog, not a kernel entity, so they read through the
    /// typed USDA RPCs; every other entity lists through the entity kernel.
    private func usdaFoodPage(
        _ descriptor: EntityDescriptor,
        page: Int,
        pageSize: Int,
        sort: String?,
        filters: EntityFilterState
    ) async throws -> ListPage<EntityRow> {
        var typedFilters = UsdaListInputFilters(foodsOnly: true)
        for name in filters.names {
            guard let value = filters[name] else { continue }
            switch name {
            case "nameFilter": typedFilters.nameFilter = try value.string(name)
            case "dataTypeFilter": typedFilters.dataTypeFilter = .value2(try value.enumCases(name))
            case "dataTypes": typedFilters.dataTypes = try value.enumCases(name)
            case "foodsOnly": typedFilters.foodsOnly = try value.bool(name)
            case "linkedProductsOnly": typedFilters.linkedProductsOnly = try value.bool(name)
            default: throw EntityFilterError.unknownParameter(.usdaFood, name)
            }
        }

        var input = UsdaListInput(filters: typedFilters)
        input.pagination = .init(pageIndex: max(0, page - 1), pageSize: max(1, pageSize))
        input.sort = try usdaFoodSort(sort)
        let result = try await native_usdaFood_list(body: input)
        return ListPage(
            items: try result.items.compactMap { descriptor.row(from: try usdaFoodJSON($0)) },
            meta: result.meta
        )
    }

    /// The sort payload is a named operation contract around an anonymous item schema; decode
    /// through it so handwritten code never depends on positional `InputSchemaNN` aliases.
    private func usdaFoodSort(_ sort: String?) throws -> [UsdaListInputSortItem]? {
        try decodedSort(sort, as: [UsdaListInputSortItem].self)
    }

    private func decodedSort<Sort: Decodable>(_ sort: String?, as _: Sort.Type) throws -> Sort? {
        guard let sort, !sort.isEmpty else { return nil }
        let values = sort.split(separator: ",").map { token -> JSONValue in
            let descending = token.hasPrefix("-")
            let field = descending ? token.dropFirst() : token[...]
            return .object([
                "orderBy": .string(String(field)),
                "direction": .string(descending ? "desc" : "asc"),
            ])
        }
        return try JSONDecoder.cubby().decode(
            Sort.self, from: JSONEncoder.cubby().encode(JSONValue.array(values)))
    }

    private func usdaFoodJSON(_ food: some USDAFoodRow) throws -> JSONValue {
        try normalizedJSON(food) { object in
            object["id"] = .string(String(food.fdcId))
            object["description"] = .string(food.foodInfo.description)
        }
    }

    private func normalizedJSON<Value: Encodable>(
        _ value: Value,
        mutate: (inout [String: JSONValue]) -> Void
    ) throws -> JSONValue {
        guard case .object(var object) = try JSONValue(encoding: value) else {
            throw URLError(.cannotParseResponse)
        }
        mutate(&object)
        return .object(object)
    }

}

extension CubbyClient: EntityRelationshipsClient {}

/// A USDA list row (no full nutrient table) or a single-food read.
protocol USDAFoodRow: Encodable {
    var fdcId: FdcId { get }
    var foodInfo: FoodInfo { get }
}

extension FoodSummaryWithLinkedProducts: USDAFoodRow { var fdcId: FdcId { fdc_id } }
extension UsdaFoodListRow: USDAFoodRow { var fdcId: FdcId { fdc_id } }

/// One location as the bin pickers list it.
public struct LocationChoice: Identifiable, Sendable, Hashable {
    public let id: LocationCode
    public let name: String
    public let parentName: String?
}
