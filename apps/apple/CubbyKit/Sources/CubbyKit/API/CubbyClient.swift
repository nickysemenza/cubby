import CubbyAPI
import Foundation
import HTTPTypes
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
    /// Internal so `Generated/ClientOperations.swift` can extend the client.
    let api: Client
    private let mediaTransport: URLSessionTransport
    private let mediaAuth: CubbyAuthMiddleware

    public init(
        baseURL: URL, credentials: CredentialProvider, identity: ClientIdentity = .unknown,
        session: URLSession = .cubbyShared,
        requestObserver: (any RequestObserver)? = nil
    ) {
        self.baseURL = baseURL
        self.credentials = credentials
        let transport = URLSessionTransport(configuration: .init(session: session))
        let auth = CubbyAuthMiddleware(
            credentials: credentials, identity: identity, observer: requestObserver)
        self.mediaTransport = transport
        self.mediaAuth = auth
        // The spec's `servers` entry is "/", so the base URL must always be supplied here.
        // `JSONNullMiddleware` is inert unless `sending(_:_:)` scopes a composed body around a
        // call, so every other request through `api` keeps the typed body exactly.
        self.api = Client(
            serverURL: baseURL,
            configuration: .cubby,
            transport: transport,
            middlewares: [auth, JSONNullMiddleware()]
        )
    }

    /// Private report media keeps the existing session credentials on the evidence endpoint.
    /// Public cover images continue to use the public image pipeline.
    public func reportMediaRequest(_ reference: String) async throws -> URLRequest {
        guard let route = OperationRoute.all["run.readEvidenceMedia"],
            let url = URL(string: reference, relativeTo: baseURL)?.absoluteURL,
            url.scheme == baseURL.scheme, url.host == baseURL.host, url.port == baseURL.port,
            url.user == nil, url.password == nil, url.fragment == nil,
            url.path == route.path
        else {
            throw CubbyAPIError(status: 0, operationID: "report.media", detail: nil)
        }
        var request = URLRequest(url: url, cachePolicy: .reloadIgnoringLocalCacheData)
        request.httpMethod = route.method.rawValue
        var fields = HTTPFields()
        CubbyAuthMiddleware.apply(await credentials.requestState(), identity: .unknown, to: &fields)
        for field in fields {
            request.setValue(field.value, forHTTPHeaderField: field.name.rawName)
        }
        return request
    }

    /// Retained originals use the same response authentication and raw error handling as RPCs.
    public func reportMedia(_ reference: String) async throws -> Data {
        let prepared = try await reportMediaRequest(reference)
        guard let url = prepared.url, let rawMethod = prepared.httpMethod,
            let method = HTTPRequest.Method(rawValue: rawMethod)
        else {
            throw CubbyAPIError(status: 0, operationID: "report.media", detail: nil)
        }
        let components = URLComponents(url: url, resolvingAgainstBaseURL: false)!
        var request = HTTPRequest(
            method: method, scheme: nil, authority: nil,
            path: components.percentEncodedPath + (components.percentEncodedQuery.map { "?" + $0 } ?? ""))
        request.headerFields[.cacheControl] = "no-store"
        let transport = mediaTransport
        let (_, body) = try await mediaAuth.intercept(
            request, body: nil, baseURL: baseURL, operationID: "report.media"
        ) { request, body, baseURL in
            try await transport.send(request, body: body, baseURL: baseURL, operationID: "report.media")
        }
        guard let body else { return Data() }
        return try await Data(collecting: body, upTo: 50 * 1024 * 1024)
    }

    // MARK: - Products

    public func product(_ id: ProductCode) async throws -> ProductDetail {
        try await perform {
            try await api.resources_product_get(path: .init(id: id.rawValue)).ok.body.json
        }
    }

    /// Find-or-create by a raw scanned code, resolved server-side: an ISBN becomes a book, a
    /// barcode a product, a product label the product itself; an unreadable code is the server's
    /// validation error.
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

    public func wardrobe(
        ownerID: LedgerPartyShortcode, search: String? = nil, pageIndex: Int = 0,
        pageSize: Int = 50
    ) async throws -> SmartCollectionDetailOut {
        try await perform {
            try await api.collection_referenceDetail(
                body: .json(
                    SmartCollectionReferenceInput(
                        search: search?.isEmpty == false ? search : nil,
                        pagination: .init(pageIndex: max(0, pageIndex), pageSize: min(100, max(1, pageSize))),
                        reference: .wardrobe(.init(kind: .wardrobe, ownerId: ownerID))
                    )
                )
            ).ok.body.json
        }
    }

    public func fieldExplanation(
        subject: EntityRef, field: String, surface: String = "detail"
    ) async throws -> FieldExplanationOutput {
        let entityKind: Operations.FieldExplanation_explain.Input.Query.EntityKindPayload =
            switch subject.entity {
            case .product: .product
            case .productCategory: .productCategory
            case .spendingCategory: .spendingCategory
            case .recipe: .recipe
            case .ingredient: .ingredient
            case .cookbook: .cookbook
            case .location: .location
            case .inventory: .inventory
            case .meal: .meal
            case .ledgerParty: .ledgerParty
            case .ledgerTransfer: .ledgerTransfer
            case .project: .project
            case .task: .task
            case .vendor: .vendor
            case .purchase: .purchase
            case .financialAccount: .financialAccount
            case .financialTransaction: .financialTransaction
            case .wish: .wish
            case .expense: .expense
            case .usdaFood: .usdaFood
            case .image: .image
            case .planting: .planting
            case .gardenEntry: .gardenEntry
            case .vendorAccount: .vendorAccount
            case .run: .run
            case .device: .device
            case .plant: .plant
            }
        return try await perform {
            try await api.fieldExplanation_explain(
                query: .init(
                    entityKind: entityKind, entityId: subject.id, field: field,
                    surface: .init(rawValue: surface))
            ).ok.body.json
        }
    }

    /// One page of rows through the entity's generated native read kind. `filters` are keyed by
    /// `FilterDescriptor.wire`; an unknown name throws `EntityFilterError` before any request.
    public func list(
        _ descriptor: EntityDescriptor,
        page: Int = 1,
        pageSize: Int = 50,
        sort: String? = nil,
        filters: EntityFilterState = EntityFilterState()
    ) async throws -> ListPage<EntityRow> {
        try await perform {
            switch descriptor.key.nativeReadKind {
            case .cookbook:
                return try await cookbookPage(
                    descriptor, page: page, pageSize: pageSize, sort: sort, filters: filters)
            case .image:
                return try await imagePage(
                    descriptor, page: page, pageSize: pageSize, sort: sort, filters: filters)
            case .usdaFood:
                return try await usdaFoodPage(
                    descriptor, page: page, pageSize: pageSize, sort: sort, filters: filters)
            case .resource:
                let result = try await descriptor.listPage(
                    client: api, page: page, pageSize: pageSize, sort: sort, filters: filters)
                return ListPage(
                    items: result.items.compactMap(descriptor.row(from:)), meta: result.meta)
            case .unavailable:
                throw EntityOperationError.unsupported(descriptor.key, .list)
            }
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
        try await perform {
            try await sending(.object(body)) { try await descriptor.create(.object(body), client: api) }
        }
    }

    /// `resources.<entity>.update` from an editor's patch: changed values and the cleared keys
    /// as `null` (the generated client can only omit an optional, and an omitted field means
    /// "leave as is"). An empty patch sends nothing.
    public func update(_ descriptor: EntityDescriptor, id: String, patch: EntityPatch) async throws {
        guard !patch.isEmpty else { return }
        var body = patch.values
        for key in patch.cleared { body[key] = .null }
        try await perform {
            try await sending(.object(body)) {
                try await descriptor.update(.object(patch.values), id: id, client: api)
            }
        }
    }

    /// Runs one generated call whose typed body was decoded from `body`, restoring on the wire
    /// every `null` the typed body cannot encode (`JSONNullMiddleware`). Any operation the app
    /// feeds a composed JSON body goes through here.
    func sending<T>(_ body: JSONValue, _ call: () async throws -> T) async throws -> T {
        try await JSONNullMiddleware.$source.withValue(body) { try await call() }
    }

    /// `sending(_:_:)` for a call that takes the decoded typed body itself.
    func sending<Input: Decodable, T>(
        _ body: JSONValue, _ call: (Input) async throws -> T
    ) async throws -> T {
        let input: Input = try body.decoded()
        return try await sending(body) { try await call(input) }
    }

    /// `resources.<entity>.delete`. Destructive: only `HeroActionRunner` calls it, and only after
    /// the person confirmed behind the connection-impact preview.
    public func delete(_ descriptor: EntityDescriptor, id: String) async throws {
        try await perform { try await descriptor.delete(id: id, client: api) }
    }

    /// One image with its owning records through the kernel `get` every entity shares. The
    /// detail read is a superset of the photo views' `ImageWithEntity`, which it projects to.
    public func imageDetail(id: String) async throws -> ImageWithEntity {
        try await perform {
            try JSONValue(encoding: try await api.resources_image_get(path: .init(id: id)).ok.body.json)
                .decoded()
        }
    }

    /// One row by id, or `nil` when the server does not have it.
    public func row(_ descriptor: EntityDescriptor, id: String) async throws -> EntityRow? {
        do {
            let raw: JSONValue
            switch descriptor.key.nativeReadKind {
            case .usdaFood:
                guard let fdcID = Int(id) else {
                    throw EntityFilterError.invalidValue(
                        parameter: "id", value: id, expected: "a numeric FDC ID")
                }
                raw = try usdaFoodJSON(
                    try await api.usdaFood_detail(query: .init(id: fdcID)).ok.body.json)
            // Cookbook and image list through their own reads but share the
            // kernel `get` every other entity uses.
            case .resource, .cookbook, .image:
                raw = try await descriptor.getRow(client: api, id: id)
            case .unavailable:
                throw EntityOperationError.unsupported(descriptor.key, .get)
            }
            return descriptor.row(from: raw)
        } catch {
            let error = CubbyAPIError.unwrapping(error)
            if let error = error as? CubbyAPIError, error.status == 404 { return nil }
            throw error
        }
    }

    // MARK: - Entity relationships

    /// Physical graph edges and the advisory disposition for delete or merge.
    public func physicalConnections(id: String, previewDelete: Bool = false) async throws
        -> EntityConnectionsOut
    {
        try await perform {
            try await api.entity_connections(
                query: .init(id: id, operation: previewDelete ? .delete : nil)
            ).ok.body.json
        }
    }

    public func connectedRecords(
        source: EntityRef, viewKey: String, offset: Int = 0, limit: Int = 20,
        targetIDs: [String]? = nil
    ) async throws -> ConnectedRecordsOutput {
        try await perform {
            try await api.entity_connectedRecords(
                body: .json(
                    .init(
                        source: source.graphRootInput, viewKey: viewKey,
                        targetIds: targetIDs, offset: offset, limit: limit
                    ))
            ).ok.body.json
        }
    }

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
                    entityKind: .init(rawValue: source.entityKind.rawValue)!, entityId: source.entityId)
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

    /// One bounded, transactional library sighting page (`image.recordSightings`); the server
    /// upserts by image/owner/asset key, so a resent page changes nothing.
    public func recordImageSightings(_ items: [ImageSightingRecordItem]) async throws {
        guard !items.isEmpty else { return }
        _ = try await perform {
            try await api.image_recordSightings(.init(body: .json(.init(items: items)))).ok.body.json
        }
    }

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
                input.entityKind = EntityImage(rawValue: entity.rawValue.uppercased())
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

    public func decideOrderMail(
        eventID: String, purchaseID: PurchaseShortcode, link: Bool,
        evidenceChecksum: String
    ) async throws {
        _ = try await perform {
            try await api.vendor_decideOrderMail(
                body: .json(
                    .init(
                        eventId: eventID, purchaseId: purchaseID, decision: link ? .linked : .dismissed,
                        evidenceChecksum: evidenceChecksum
                    ))
            ).ok.body.json
        }
    }

    public func approvePhotoGroups(
        runID: RunShortcode, groups: [PhotoGroupProposal]
    ) async throws -> ReviewPhotoGroupsOutput {
        try await perform {
            let revisions = try groups.map { group in
                (
                    groupKey: group.groupKey,
                    updatedAt: try LenientISO8601DateTranscoder().decode(group.updatedAt)
                )
            }
            return try await api.photoImport_approveGroups(
                body: .json(
                    .init(
                        runId: runID,
                        groupKeys: groups.map(\.groupKey),
                        expectedRevisions: revisions.map {
                            .init(groupKey: $0.groupKey, updatedAt: $0.updatedAt)
                        }
                    ))
            )
            .ok.body.json
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

    // MARK: - Activity

    public struct ActivityFilters: Sendable, Hashable {
        public enum Executor: Sendable, Hashable {
            case all
            case cloud
            case unknown
            case device(String)

            fileprivate var query: (name: String, deviceID: String?) {
                switch self {
                case .all: ("all", nil)
                case .cloud: ("cloud", nil)
                case .unknown: ("unknown", nil)
                case .device(let id): ("device", id)
                }
            }
        }

        public var kind: ActivityKind?
        public var state: String?
        public var subjectID: String?
        public var submissionID: String?
        public var executor: Executor
        public var from: Date?
        public var to: Date?

        public init(
            kind: ActivityKind? = nil, state: String? = nil, subjectID: String? = nil,
            submissionID: String? = nil, executor: Executor = .all, from: Date? = nil,
            to: Date? = nil
        ) {
            self.kind = kind
            self.state = state
            self.subjectID = subjectID
            self.submissionID = submissionID
            self.executor = executor
            self.from = from
            self.to = to
        }
    }

    public func activityRuns(
        filters: ActivityFilters = .init(), cursor: String? = nil, limit: Int = 20
    ) async throws -> ActivityListOutput {
        return try await perform {
            try await api.activity_list(
                query: .init(
                    kind: filters.kind.map(activityListKind), state: filters.state,
                    subjectId: filters.subjectID, submissionId: filters.submissionID,
                    executor: .init(rawValue: filters.executor.query.name),
                    deviceId: filters.executor.query.deviceID, from: filters.from, to: filters.to,
                    sort: .newest, cursor: cursor, limit: limit)
            ).ok.body.json
        }
    }

    public func activityGroups(
        filters: ActivityFilters = .init(), cursor: String? = nil, limit: Int = 20
    ) async throws -> ActivityGroupsOutput {
        return try await perform {
            try await api.activity_groups(
                query: .init(
                    kind: filters.kind.flatMap { .init(rawValue: $0.rawValue) }, state: filters.state,
                    subjectId: filters.subjectID, submissionId: filters.submissionID,
                    executor: .init(rawValue: filters.executor.query.name),
                    deviceId: filters.executor.query.deviceID, from: filters.from, to: filters.to,
                    sort: .newest, cursor: cursor, limit: limit)
            ).ok.body.json
        }
    }

    public func activityGroupChildren(
        rootID: String, filters: ActivityFilters = .init(), cursor: String? = nil, limit: Int = 20
    ) async throws -> ActivityListOutput {
        return try await perform {
            try await api.activity_groupChildren(
                query: .init(
                    kind: filters.kind.flatMap { .init(rawValue: $0.rawValue) }, state: filters.state,
                    subjectId: filters.subjectID, submissionId: filters.submissionID,
                    executor: .init(rawValue: filters.executor.query.name),
                    deviceId: filters.executor.query.deviceID, from: filters.from, to: filters.to,
                    sort: .newest, cursor: cursor, limit: limit, rootId: rootID)
            ).ok.body.json
        }
    }

    private func activityListKind(
        _ kind: ActivityKind
    ) -> Operations.Activity_list.Input.Query.KindPayload {
        switch kind {
        case .accountSync: .accountSync
        case .mailImport: .mailImport
        case .purchaseValidation: .purchaseValidation
        case .productEnrichment: .productEnrichment
        case .suggestionSweep: .suggestionSweep
        case .photoInventory: .photoInventory
        case .describeImage: .describeImage
        case .subjectLift: .subjectLift
        case .aiSuggest: .aiSuggest
        case .background: .background
        case .fileImport: .fileImport
        case .mailSearch: .mailSearch
        case .mailDiscovery: .mailDiscovery
        }
    }

    /// Household-wide audit entries, newest first. The opaque cursor is passed back unchanged.
    public func auditHistory(cursor: String? = nil, limit: Int = 50) async throws -> AuditLogListOut {
        try await perform {
            try await api.auditLog_list(query: .init(limit: Double(limit), cursor: cursor))
                .ok.body.json
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

    /// Idempotent device-side status for one photo-run image target
    /// (`PhotoImportRunUploader`'s queued/running/paused/failed telemetry as it works through a
    /// run). Repeating the same `(run, image, state)` is a server no-op, so callers may fire this
    /// without tracking whether a previous report for the same state landed.
    public func reportRunDeviceWork(
        run: RunShortcode, image: ImageCode, state: RunTargetDeviceWorkState, error: String? = nil
    ) async throws -> Bool {
        try await perform {
            try await api.run_reportDeviceWork(
                body: .json(.init(run: run, image: image, state: state, error: error))
            ).ok.body.json.recorded
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

    /// An atomic view of one bin. The opaque token guards both row membership and ownership facts
    /// that a row timestamp cannot cover.
    public func inventorySnapshot(at location: LocationCode) async throws -> RecountSnapshot {
        try await perform {
            let output = try await api.inventory_locationSnapshot(
                query: .init(locationId: location.rawValue, placement: .stock)
            ).ok.body.json
            return RecountSnapshot(rows: output.items.map(RecountRow.init), token: output.snapshotToken)
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

    // MARK: - Specialist list presentations

    public func mealCalendar(from start: String, to end: String) async throws -> CalendarRangeOut {
        try await perform {
            try await api.calendar_range(
                query: .init(
                    startDate: start, endDateExclusive: end, kinds: [.meal])
            ).ok.body.json
        }
    }

    public func taskBoard(filters: EntityFilterState) async throws -> TaskBoardOut {
        let input = try Self.decodeFilters(TaskFilters.self, filters: filters)
        return try await perform {
            try await api.task_board(body: .json(input)).ok.body.json
        }
    }

    public func reorderTask(_ id: String, rank: Double) async throws {
        try await reorderTasks([(id, rank)])
    }

    public func reorderTasks(_ ranks: [(String, Double)]) async throws {
        let input = TaskBulkReorderInput(
            ranks: ranks.map { .init(id: .init($0.0), sortOrder: $0.1) })
        _ = try await perform {
            try await api.task_bulkReorder(body: .json(input)).ok.body.json
        }
    }

    public func projectAnalytics(filters: EntityFilterState) async throws
        -> (ProjectDashboardSummaryOut, ProjectPortfolioAnalyticsOut)
    {
        let search = filters["search"]?.strings.first
        let from = filters["dateFrom"]?.strings.first
        let to = filters["dateTo"]?.strings.first
        let locations = filters["location"]?.strings
        let completionYear = filters["completionYear"]?.strings.first
        let dashboardStatuses = filters["status"]?.strings.compactMap {
            Operations.Project_dashboardSummary.Input.Query.StatusScopePayloadPayload(rawValue: $0)
        }
        let dashboardKinds = filters["kind"]?.strings.compactMap {
            Operations.Project_dashboardSummary.Input.Query.KindsPayloadPayload(rawValue: $0)
        }
        let portfolioStatuses = filters["status"]?.strings.compactMap {
            Operations.Project_portfolioAnalytics.Input.Query.StatusScopePayloadPayload(rawValue: $0)
        }
        let portfolioKinds = filters["kind"]?.strings.compactMap {
            Operations.Project_portfolioAnalytics.Input.Query.KindsPayloadPayload(rawValue: $0)
        }
        return try await perform {
            let summary = try await api.project_dashboardSummary(
                query: .init(
                    statusScope: dashboardStatuses, kinds: dashboardKinds,
                    locations: locations, search: search, dateFrom: from, dateTo: to,
                    completionYear: completionYear)
            )
            .ok.body.json
            let analytics = try await api.project_portfolioAnalytics(
                query: .init(
                    statusScope: portfolioStatuses, kinds: portfolioKinds,
                    locations: locations, search: search, dateFrom: from, dateTo: to,
                    completionYear: completionYear)
            )
            .ok.body.json
            return (summary, analytics)
        }
    }

    public func expenseAnalytics(filters: EntityFilterState) async throws -> ExpenseAnalyticsOut {
        let input = try Self.decodeFilters(ExpenseFilters.self, filters: filters)
        return try await perform {
            try await api.expense_analytics(body: .json(input)).ok.body.json
        }
    }

    private static func decodeFilters<T: Decodable>(_ type: T.Type, filters: EntityFilterState) throws -> T {
        let fields = filters.values.mapValues { value -> JSONValue in
            switch value {
            case .single(let text): .string(text)
            case .many(let texts): .array(texts.map(JSONValue.string))
            }
        }
        return try JSONDecoder().decode(T.self, from: JSONEncoder().encode(JSONValue.object(fields)))
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
        query.entityKinds = (kinds ?? EntityCatalog.intentExposed.map(\.key)).compactMap {
            .init(rawValue: $0.rawValue)
        }
        return try await perform {
            try await api.search_find(query: query).ok.body.json
        }
    }

    public func requestCatchUp() async throws {
        // The server's `z.undefined()` mutation input still rejects a missing body (400
        // "expected object"); the spec marks the body optional, so send an empty object.
        _ = try await perform { try await api.maintenance_requestCatchUp(body: .json(.init())).ok.body.json }
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

    /// The server-composed blocks (stats, chart, table, schedule, note) behind a detail slot.
    public func entityReport(slot: ReportSlot, id: String, cursor: String? = nil) async throws
        -> EntityReportOut
    {
        // The query's slot enum shares the manifest slot id with `ReportSlot` as its raw value.
        guard let queryed = Operations.EntityReport_get.Input.Query.SlotPayload(rawValue: slot.rawValue)
        else { throw URLError(.badURL) }
        return try await perform {
            try await api.entityReport_get(query: .init(slot: queryed, id: id, cursor: cursor)).ok.body.json
        }
    }

    /// Several slots of one record in one read; the server loads the record once for all of them.
    public func entityReports(slots: [ReportSlot], id: String) async throws
        -> [(ReportSlot, EntityReportOut)]
    {
        let wanted = slots.compactMap {
            Operations.EntityReport_getMany.Input.Query.SlotsPayloadPayload(rawValue: $0.rawValue)
        }
        let out = try await perform {
            try await api.entityReport_getMany(query: .init(slots: wanted, id: id)).ok.body.json
        }
        return out.reports.map { ($0.slot, $0.report) }
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

    // MARK: - Non-resource entity reads

    /// Cookbooks predate the generic resource list and intentionally return the complete set.
    /// Keep paging and search local so the generic list model retains one paging contract.
    private func cookbookPage(
        _ descriptor: EntityDescriptor,
        page: Int,
        pageSize: Int,
        sort: String?,
        filters: EntityFilterState
    ) async throws -> ListPage<EntityRow> {
        var query: String?
        for name in filters.names {
            guard let value = filters[name] else { continue }
            switch name {
            case "searchQuery": query = try value.string(name)
            default: throw EntityFilterError.unknownParameter(.cookbook, name)
            }
        }

        let all = try await api.cookbook_list().ok.body.json
        let filtered = all.filter { cookbook in
            guard let query = query?.trimmingCharacters(in: .whitespacesAndNewlines), !query.isEmpty else {
                return true
            }
            let haystack = [cookbook.id, cookbook.name] + cookbook.author + cookbook.subjects
            return haystack.contains { $0.localizedCaseInsensitiveContains(query) }
        }
        let sorted = try sortedCookbooks(filtered, by: sort)
        let safePage = max(1, page)
        let safePageSize = max(1, pageSize)
        let start = min(sorted.count, (safePage - 1) * safePageSize)
        let end = min(sorted.count, start + safePageSize)
        return ListPage(
            items: try sorted[start..<end].compactMap {
                descriptor.row(from: try cookbookJSON($0))
            },
            meta: .init(
                pageIndex: safePage - 1,
                pageSize: safePageSize,
                totalCount: sorted.count
            )
        )
    }

    private func imagePage(
        _ descriptor: EntityDescriptor,
        page: Int,
        pageSize: Int,
        sort: String?,
        filters: EntityFilterState
    ) async throws -> ListPage<EntityRow> {
        var typedFilters = ImageListFilters()
        for name in filters.names {
            guard let value = filters[name] else { continue }
            switch name {
            case "createdAtFrom": typedFilters.createdFrom = PlainDate(rawValue: try value.string(name))
            case "createdAtTo": typedFilters.createdTo = PlainDate(rawValue: try value.string(name))
            case "updatedAtFrom": typedFilters.updatedFrom = PlainDate(rawValue: try value.string(name))
            case "updatedAtTo": typedFilters.updatedTo = PlainDate(rawValue: try value.string(name))
            case "nameFilter": typedFilters.nameFilter = try value.string(name)
            case "status": typedFilters.status = .init(value2: try value.enumCases(name))
            case "referencePresenceFilter":
                typedFilters.referencePresenceFilter = try value.enumCase(name)
            case "uploadedAgeHoursMin": typedFilters.uploadedAgeHoursMin = try value.double(name)
            default: throw EntityFilterError.unknownParameter(.image, name)
            }
        }

        var input = ImageBrowserListInput(filters: typedFilters)
        input.pagination = .init(pageIndex: max(0, page - 1), pageSize: max(1, pageSize))
        input.sort = try imageSort(sort)
        let result = try await api.image_list(body: .json(input)).ok.body.json
        return ListPage(
            items: try result.items.compactMap { descriptor.row(from: try imageJSON($0)) },
            meta: result.meta
        )
    }

    private func usdaFoodPage(
        _ descriptor: EntityDescriptor,
        page: Int,
        pageSize: Int,
        sort: String?,
        filters: EntityFilterState
    ) async throws -> ListPage<EntityRow> {
        var typedFilters = UsdaListInput.FiltersPayload(foodsOnly: true)
        for name in filters.names {
            guard let value = filters[name] else { continue }
            switch name {
            case "nameFilter": typedFilters.nameFilter = try value.string(name)
            case "dataTypeFilter": typedFilters.dataTypeFilter = try value.enumCase(name)
            case "dataTypes": typedFilters.dataTypes = try value.enumCases(name)
            case "foodsOnly": typedFilters.foodsOnly = try value.bool(name)
            case "linkedProductsOnly": typedFilters.linkedProductsOnly = try value.bool(name)
            default: throw EntityFilterError.unknownParameter(.usdaFood, name)
            }
        }

        var input = UsdaListInput(filters: typedFilters)
        input.pagination = .init(pageIndex: max(0, page - 1), pageSize: max(1, pageSize))
        input.sort = try usdaFoodSort(sort)
        let result = try await api.usdaFood_list(body: .json(input)).ok.body.json
        return ListPage(
            items: try result.items.compactMap { descriptor.row(from: try usdaFoodJSON($0)) },
            meta: result.meta
        )
    }

    /// Sort payloads are generated as named operation contracts around anonymous item schemas.
    /// Decode through the named contract so handwritten code never depends on positional
    /// `InputSchemaNN` aliases.
    private func imageSort(_ sort: String?) throws -> ImageBrowserListInput.SortPayload? {
        try decodedSort(sort, as: ImageBrowserListInput.SortPayload.self)
    }

    private func usdaFoodSort(_ sort: String?) throws -> UsdaListInput.SortPayload? {
        try decodedSort(sort, as: UsdaListInput.SortPayload.self)
    }

    private func sortedCookbooks(_ values: [CookbookSummary], by sort: String?) throws
        -> [CookbookSummary]
    {
        guard let sort, !sort.isEmpty else { return values }
        let allowed = Set([
            "id", "shortcode", "name", "author", "subjects", "recipeCount",
            "coverUrl", "sourceRecipeCount", "needsReextract", "product",
        ])
        let terms = try sort.split(separator: ",").map { token -> (field: String, descending: Bool) in
            let descending = token.hasPrefix("-")
            let field = String(descending ? token.dropFirst() : token[...])
            guard allowed.contains(field) else {
                throw EntityFilterError.invalidValue(
                    parameter: "sort", value: field,
                    expected: "a declared cookbook list field")
            }
            return (field, descending)
        }
        return values.enumerated().sorted { lhs, rhs in
            for term in terms {
                let comparison = cookbookComparison(lhs.element, rhs.element, field: term.field)
                guard comparison != .orderedSame else { continue }
                return term.descending
                    ? comparison == .orderedDescending
                    : comparison == .orderedAscending
            }
            return lhs.offset < rhs.offset
        }.map(\.element)
    }

    private func cookbookComparison(
        _ lhs: CookbookSummary, _ rhs: CookbookSummary, field: String
    ) -> ComparisonResult {
        switch field {
        case "id", "shortcode": lhs.id.localizedCaseInsensitiveCompare(rhs.id)
        case "name": lhs.name.localizedCaseInsensitiveCompare(rhs.name)
        case "author":
            lhs.author.joined(separator: " ").localizedCaseInsensitiveCompare(
                rhs.author.joined(separator: " "))
        case "subjects":
            lhs.subjects.joined(separator: " ").localizedCaseInsensitiveCompare(
                rhs.subjects.joined(separator: " "))
        case "recipeCount": comparison(lhs.recipeCount, rhs.recipeCount)
        case "coverUrl": (lhs.coverUrl ?? "").localizedCaseInsensitiveCompare(rhs.coverUrl ?? "")
        case "sourceRecipeCount": comparison(lhs.sourceRecipeCount, rhs.sourceRecipeCount)
        case "needsReextract": comparison(lhs.needsReextract ? 1 : 0, rhs.needsReextract ? 1 : 0)
        case "product":
            (lhs.product?.name ?? "").localizedCaseInsensitiveCompare(rhs.product?.name ?? "")
        default: .orderedSame
        }
    }

    private func comparison<Value: Comparable>(_ lhs: Value, _ rhs: Value) -> ComparisonResult {
        if lhs < rhs { return .orderedAscending }
        if lhs > rhs { return .orderedDescending }
        return .orderedSame
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

    private func cookbookJSON(_ cookbook: CookbookSummary) throws -> JSONValue {
        try normalizedJSON(cookbook) { object in
            object["shortcode"] = .string(cookbook.id)
        }
    }

    private func imageJSON(_ image: ImageWithEntity) throws -> JSONValue {
        try normalizedJSON(image) { object in
            object["displayImages"] =
                image.status == .uploaded
                ? .array([
                    .object(["id": .string(image.id.rawValue), "url": .string(image.url)])
                ])
                : .array([])
        }
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

    /// OpenAPIRuntime wraps whatever a middleware throws in a `ClientError`, which would hide the
    /// `CubbyAPIError` every caller switches on. Every request goes through here so it does not.
    func perform<T>(_ request: () async throws -> T) async throws -> T {
        do {
            return try await request()
        } catch {
            throw CubbyAPIError.unwrapping(error)
        }
    }

}

extension CubbyClient: EntityRelationshipsClient {}

/// A USDA list row (no full nutrient table) or a single-food read.
protocol USDAFoodRow: Encodable {
    var fdcId: FdcId { get }
    var foodInfo: FoodInfo { get }
}

extension FoodSummaryWithLinkedProducts: USDAFoodRow {}
extension UsdaFoodListRow: USDAFoodRow {}
