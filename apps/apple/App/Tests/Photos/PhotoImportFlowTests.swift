import CoreGraphics
import CubbyKit
import Foundation
import Synchronization
import Testing

@testable import Cubby

@MainActor
@Suite("Photo import flow", .serialized)
struct PhotoImportFlowTests {
    @Test func manifestKeepsUnassignedPhotosOutOfCommitUntilMoved() throws {
        let first = try selection(filename: "first.jpg")
        let second = try selection(filename: "second.jpg")
        let manifest = makeManifest(items: [first, second])

        #expect(manifest.needsDestination == [first.id, second.id])
        #expect(!manifest.canCommit)
        // 5c defaults selection to the focused photo alone; select both explicitly to exercise
        // the original whole-batch assignment this test covers.
        manifest.selectedIDs = Set(manifest.items.map(\.id))
        let option = try #require(manifest.destinationOptions.first)
        manifest.moveSelected(
            to: option,
            row: EntityRow(
                id: "PRD-2345", title: "Example", subtitle: nil, imageURL: nil,
                raw: ["id": "PRD-2345", "name": "Example"]))

        #expect(manifest.needsDestination.isEmpty)
        #expect(manifest.groups.count == 1)
        #expect(manifest.groups[0].photoIDs == [first.id, second.id])
        #expect(manifest.groups[0].title == "Example  PRD-2345")
        #expect(manifest.canCommit)
    }

    @Test func defaultSelectionIsTheFocusedPhotoAndAdvancesAfterAssignment() throws {
        let first = try selection(filename: "first.jpg")
        let second = try selection(filename: "second.jpg")
        let manifest = makeManifest(items: [first, second])

        #expect(manifest.focusedItemID == first.id)
        #expect(manifest.selectedIDs == [first.id])

        let option = try #require(manifest.destinationOptions.first)
        manifest.moveSelected(
            to: option,
            row: EntityRow(
                id: "PRD-2345", title: "Example", subtitle: nil, imageURL: nil,
                raw: ["id": "PRD-2345", "name": "Example"]))

        #expect(manifest.focusedItemID == second.id)
        #expect(manifest.selectedIDs == [second.id])
    }

    @Test func finishingAssignmentsKeepsFocusButClearsAssignmentScope() throws {
        let first = try selection(filename: "first.jpg")
        let second = try selection(filename: "second.jpg")
        let manifest = makeManifest(items: [first, second])
        manifest.selectedIDs = [first.id, second.id]
        let option = try #require(manifest.destinationOptions.first)

        manifest.moveSelected(
            to: option,
            row: EntityRow(
                id: "PRD-2345", title: "Example", subtitle: nil, imageURL: nil,
                raw: ["id": "PRD-2345", "name": "Example"]))

        #expect(manifest.focusedItemID == first.id)
        #expect(manifest.selectedIDs.isEmpty)
        #expect(manifest.reviewSelectionStatus == "All 2 photos ready to add")
        manifest.toggle(second.id)
        #expect(manifest.focusedItemID == second.id)
        #expect(manifest.reviewSelectionStatus == "Assigning 1 of 2 photos")
    }

    /// A1 regression: `scopedCaptureDate` (and therefore every editor/stage prefill) falls back to
    /// the whole batch when the selection is empty, exactly like `scopedHeroItems` — the original
    /// bug read `selectedItems.compactMap(\.capturedAt).min()` directly with no such fallback, so
    /// deselecting (or an auto-assign, or the analyzer) silently lost the photo's date.
    @Test func editorPrefillStillCarriesThePhotoDayWhenSelectionIsEmptied() throws {
        let captured = Date(timeIntervalSince1970: 1_757_500_000)
        let item = try selection(filename: "dated.jpg", capturedAt: captured)
        let manifest = makeManifest(items: [item])
        manifest.selectedIDs = []

        let option = try #require(
            manifest.destinationOptions.first {
                $0.route.kind == .createRelated && $0.route.source == .planting
            })
        let source = EntityRow(
            id: "PLT-0001", title: "Roma", subtitle: nil, imageURL: nil, raw: ["id": "PLT-0001"])

        #expect(manifest.scopedCaptureDate == captured)
        let body = PhotoRelatedCreateEditor.createPrefill(
            option: option, source: source, captureDate: manifest.scopedCaptureDate)
        #expect(body["observedOn"] == .string(PlainDate(captured).rawValue))
    }

    /// Routing analysis may offer a matching record but cannot attach a photo; the explicit
    /// suggested-record tap is the authorization boundary.
    @Test func analyzerSuggestionsNeverAttachPhotos() throws {
        let item = try selection(filename: "match.jpg")
        let manifest = makeManifest(items: [item])
        manifest.selectedIDs = [item.id]
        let option = try #require(
            manifest.destinationOptions.first { $0.route.kind == .`self` && $0.route.choice != .prompt })
        let row = EntityRow(
            id: "PRD-9999", title: "Example", subtitle: nil, imageURL: nil,
            raw: ["id": "PRD-9999", "name": "Example"])
        let routing = PhotoRoutingCandidate(id: "candidate-1", routeID: option.id, description: row.title)
        let candidate = PhotoImportManifest.Candidate(option: option, row: row, routing: routing)
        let decision = PhotoRoutingDecision(
            photoID: item.id, routeID: option.id, candidateID: routing.id, explanation: "Matched by test")

        manifest.applyRoutingDecisions([decision], candidates: [routing.id: candidate])

        #expect(manifest.selectedIDs == [item.id])
        #expect(manifest.groups.isEmpty)
        #expect(manifest.needsDestination == [item.id])
        #expect(manifest.selectedSuggestedSource?.row.id == "PRD-9999")
    }

    /// A1 (Q7b): an undated photo's capture-date-bound field never gets a value from `createPrefill`
    /// and `hasOnlyOptionalFields` must not treat it as optional just because its schema default is
    /// `initial: "today"` — the editor must open and require a real date from the person.
    @Test func undatedPhotoLeavesObservedOnAbsentAndRequired() throws {
        let item = try selection(filename: "undated.jpg")
        let manifest = makeManifest(items: [item])
        let option = try #require(
            manifest.destinationOptions.first {
                $0.route.kind == .createRelated && $0.route.source == .planting
            })
        let source = EntityRow(
            id: "PLT-0002", title: "Cherokee", subtitle: nil, imageURL: nil, raw: ["id": "PLT-0002"])

        let body = PhotoRelatedCreateEditor.createPrefill(option: option, source: source, captureDate: nil)

        #expect(body["observedOn"] == nil)
        #expect(
            !PhotoRelatedCreateEditor.hasOnlyOptionalFields(
                option: option, source: source, captureDate: nil))
    }

    /// A2 (Q15c): the caption is a pure function of (time, zone, city) and drops the " in …"
    /// clause entirely when there's no city.
    @Test func captureProvenanceCaptionFormatsWithAndWithoutACity() throws {
        let capturedAt = Date(timeIntervalSince1970: 1_757_500_000)
        let zone = try #require(TimeZone(identifier: "America/Los_Angeles"))
        let formatter = DateFormatter()
        formatter.dateStyle = .none
        formatter.timeStyle = .short
        formatter.timeZone = zone
        let time = formatter.string(from: capturedAt)

        #expect(
            PhotoCaptureProvenance.caption(capturedAt: capturedAt, timeZone: zone, city: "San Francisco")
                == "Set from the photo · taken \(time) in San Francisco")
        #expect(
            PhotoCaptureProvenance.caption(capturedAt: capturedAt, timeZone: zone, city: nil)
                == "Set from the photo · taken \(time)")
        #expect(
            PhotoCaptureProvenance.caption(capturedAt: capturedAt, timeZone: zone, city: "")
                == "Set from the photo · taken \(time)")
    }

    @Test func stageCreateKeysDraftsByRouteSourceRecordAndDay() throws {
        let first = try selection(filename: "first.jpg")
        let second = try selection(filename: "second.jpg")
        let manifest = makeManifest(items: [first, second])
        let option = try #require(
            manifest.destinationOptions.first {
                $0.route.kind == .createRelated && $0.route.source == .planting
            })
        let plantingA = EntityRow(
            id: "PLT-0001", title: "A", subtitle: nil, imageURL: nil, raw: ["id": "PLT-0001"])
        let plantingB = EntityRow(
            id: "PLT-0002", title: "B", subtitle: nil, imageURL: nil, raw: ["id": "PLT-0002"])

        manifest.selectedIDs = [first.id]
        manifest.stageCreate(option: option, source: plantingA, body: [:])
        manifest.selectedIDs = [second.id]
        manifest.stageCreate(option: option, source: plantingB, body: [:])

        #expect(manifest.groups.count == 2)
        #expect(manifest.commitButtonTitle.contains("2"))
    }

    @Test func stageCreateMergesTheSameSourceRecordOnTheSameDayIntoOneDraft() throws {
        let first = try selection(filename: "first.jpg")
        let second = try selection(filename: "second.jpg")
        let manifest = makeManifest(items: [first, second])
        let option = try #require(
            manifest.destinationOptions.first {
                $0.route.kind == .createRelated && $0.route.source == .planting
            })
        let planting = EntityRow(
            id: "PLT-0001", title: "A", subtitle: nil, imageURL: nil, raw: ["id": "PLT-0001"])

        manifest.selectedIDs = [first.id]
        manifest.stageCreate(option: option, source: planting, body: [:])
        manifest.selectedIDs = [second.id]
        manifest.stageCreate(option: option, source: planting, body: [:])

        #expect(manifest.groups.count == 1)
        #expect(Set(manifest.groups[0].photoIDs) == Set([first.id, second.id]))
    }

    @Test func chooseSourceRecordAutoResolvesASingleSameDayMatch() async throws {
        let item = try selection(filename: "match.jpg")
        let manifest = makeManifest(items: [item])
        let type = try #require(manifest.sourceTypeOptions.first { $0.source == .planting })
        let row = EntityRow(
            id: "PLT-1234", title: "Santa Rosa", subtitle: nil, imageURL: nil,
            raw: ["id": "PLT-1234", "locationId": "LOC-0007"])
        let client = try routeClient(gardenEntries: [(id: "GDE-0001", locationId: "LOC-0007")])

        let resolution = await manifest.chooseSourceRecord(type, row: row, client: client)

        guard case .resolved = resolution else {
            Issue.record("A single same-day match must resolve without a route picker")
            return
        }
        let existing = try #require(
            manifest.destinationOptions.first {
                $0.route.kind == .existingRelated && $0.route.source == .planting
            })
        #expect(manifest.groups.first?.id == "\(existing.id):GDE-0001")
        #expect(manifest.needsDestination.isEmpty)
        // Developer overlays layer 2: a single same-day auto-resolve records `.existingSameDay`.
        #expect(manifest.groups.first?.decision == .existingSameDay(count: 1))
    }

    @Test func chooseSourceRecordStagesACreateDraftWithThePrefilledBodyWhenNothingMatches() async throws {
        // Dated on purpose: an undated photo leaves the required `observedOn` empty and opens the
        // editor instead (see `undatedPhotoLeavesObservedOnAbsentAndRequired`).
        let item = try selection(filename: "new.jpg", capturedAt: Date(timeIntervalSince1970: 1_789_000_000))
        let manifest = makeManifest(items: [item])
        let type = try #require(manifest.sourceTypeOptions.first { $0.source == .planting })
        let row = EntityRow(
            id: "PLT-5678", title: "Roma", subtitle: nil, imageURL: nil,
            raw: ["id": "PLT-5678", "locationId": "LOC-0009"])
        let client = try routeClient(gardenEntries: [])

        let resolution = await manifest.chooseSourceRecord(type, row: row, client: client)

        guard case .resolved = resolution else {
            Issue.record("An unmatched source with only-optional remaining create fields must stage directly")
            return
        }
        #expect(manifest.needsDestination.isEmpty)
        let body = try #require(manifest.createDraftBody(for: item.id))
        #expect(body["locationId"] == .string("LOC-0009"))
        // Developer overlays layer 2: an unconditional primary route with no matches records
        // `.automaticPrimary`.
        #expect(manifest.groups.first?.decision == .automaticPrimary)
    }

    @Test func chooseSourceRecordOpensTheRelatedChooserForMultipleMatches() async throws {
        let item = try selection(filename: "ambiguous.jpg")
        let manifest = makeManifest(items: [item])
        let type = try #require(manifest.sourceTypeOptions.first { $0.source == .planting })
        let row = EntityRow(
            id: "PLT-4321", title: "Cherokee", subtitle: nil, imageURL: nil,
            raw: ["id": "PLT-4321", "locationId": "LOC-0001"])
        let client = try routeClient(
            gardenEntries: [
                (id: "GDE-0001", locationId: "LOC-0001"), (id: "GDE-0002", locationId: "LOC-0001"),
            ])

        let resolution = await manifest.chooseSourceRecord(type, row: row, client: client)

        guard case .relatedChooser(let option, let page) = resolution else {
            Issue.record("Two same-day matches must hand the sheet a related-chooser context")
            return
        }
        #expect(option.route.kind == .existingRelated)
        #expect(page?.items.count == 2)
        #expect(manifest.needsDestination == [item.id])
    }

    @Test func chooseSourceRecordAlwaysPromptsWhenARouteIsMarkedPrompt() async throws {
        let item = try selection(filename: "inventory.jpg")
        let manifest = makeManifest(items: [item])
        let type = try #require(manifest.sourceTypeOptions.first { $0.source == .inventory })
        let row = EntityRow(
            id: "INV-0001", title: "Flour", subtitle: nil, imageURL: nil, raw: ["id": "INV-0001"])
        let client = try routeClient(gardenEntries: [])

        let resolution = await manifest.chooseSourceRecord(type, row: row, client: client)

        guard case .routePicker = resolution else {
            Issue.record("A `.prompt` route must always ask, regardless of the manifest's other routes")
            return
        }
    }

    @Test func destinationsIncludeEveryManifestIngressKind() throws {
        let manifest = makeManifest(items: [try selection(filename: "first.jpg")])
        let routes = manifest.destinationOptions.map(\.route)

        #expect(!routes.isEmpty)
        #expect(routes.allSatisfy { $0.storage != nil })
        #expect(routes.contains(where: { $0.kind == .`self` }))
        #expect(routes.contains(where: { $0.kind == .existingRelated }))
        #expect(routes.contains(where: { $0.kind == .createRelated }))
        #expect(routes.contains(where: { $0.target == .meal }))
        #expect(routes.contains(where: { $0.target == .project }))
        #expect(routes.contains(where: { $0.target == .task }))
        #expect(routes.contains(where: { $0.target == .gardenEntry }))
        #expect(
            routes.contains {
                $0.source == .recipe && $0.target == .meal && $0.kind == .existingRelated
            })
        #expect(
            routes.contains {
                $0.source == .planting && $0.target == .gardenEntry
                    && $0.kind == .createRelated
            })
    }

    @Test func naturalSourceTypesAreUniqueAndPlantingDefaultsToCreateRoute() throws {
        let manifest = makeManifest(items: [try selection(filename: "first.jpg")])
        let types = manifest.sourceTypeOptions

        #expect(Set(types.map(\.source)).count == types.count)
        let planting = try #require(types.first(where: { $0.source == .planting }))
        #expect(
            planting.options.first(where: { $0.route.choice == .primary })?.id
                == "planting-new-garden-entry")
    }

    @Test func missingNullableSourceBindingRemainsEditable() throws {
        let route = try #require(
            PhotoImportCatalog.ingressRoutes.first { $0.id == "planting-new-garden-entry" })
        let binding = try #require(route.bindings.first { $0.field == "locationId" })
        let source = EntityRow(
            id: "PLT-1234", title: "Santa Rosa", subtitle: nil, imageURL: nil,
            raw: .object(["id": .string("PLT-1234"), "locationId": .null]))

        #expect(PhotoImportManifest.nonNullSourceFieldValue(binding: binding, source: source) == nil)
    }

    /// 8a: a route's `primaryWhen` outranks the unconditional `.primary` when the picked record's
    /// field matches. Picks the predicate route from the catalog by `primaryWhen != nil`, never by
    /// entity name, so this stays correct if the manifest's declared values ever change.
    @Test func conditionalPrimaryOutranksTheUnconditionalPrimaryWhenThePredicateMatches() async throws {
        let captured = Date(timeIntervalSince1970: 1_789_000_000)
        let bed = try selection(filename: "bed.jpg", capturedAt: captured)
        let shelf = try selection(filename: "shelf.jpg", capturedAt: captured)
        let bedManifest = makeManifest(items: [bed])
        let shelfManifest = makeManifest(items: [shelf])
        let type = try #require(bedManifest.sourceTypeOptions.first { $0.source == .location })
        let conditional = try #require(type.options.first { $0.route.primaryWhen != nil })
        let predicate = try #require(conditional.route.primaryWhen)
        let bedRow = EntityRow(
            id: "LOC-0001", title: "Bed", subtitle: nil, imageURL: nil,
            raw: ["id": "LOC-0001", "type": .string(predicate.values[0])])
        let shelfRow = EntityRow(
            id: "LOC-0002", title: "Shelf", subtitle: nil, imageURL: nil,
            raw: ["id": "LOC-0002", "type": "a-non-predicate-value"])
        let client = try routeClient(gardenEntries: [])

        let bedResolution = await bedManifest.chooseSourceRecord(type, row: bedRow, client: client)
        guard case .resolved = bedResolution else {
            Issue.record("A matching predicate must resolve via the conditional route")
            return
        }
        #expect(bedManifest.groups.first?.id.hasPrefix(conditional.id) == true)
        // Developer overlays layer 2: the matched predicate is recorded, not just "automatic".
        #expect(
            bedManifest.groups.first?.decision
                == .automaticConditional(field: predicate.field, value: predicate.values[0]))

        let shelfResolution = await shelfManifest.chooseSourceRecord(type, row: shelfRow, client: client)
        guard case .resolved = shelfResolution else {
            Issue.record("A non-matching row must fall back to the unconditional primary")
            return
        }
        #expect(shelfManifest.groups.first?.source == .location)
        #expect(shelfManifest.createDraftBody(for: shelf.id) == nil)
        #expect(shelfManifest.groups.first?.decision == .automaticPrimary)
    }

    /// 8c: `createSelf`'s target-of-createRelated case is discovered purely from the catalog by
    /// `target == type && kind == .createRelated`, never by entity name; its reference fields are
    /// each candidate's source-id-bound field, singular or multiple.
    @Test func createTargetOptionsExposeTheReferenceFieldsForAPickedTargetType() throws {
        let candidates = PhotoImportManifest.createTargetOptions(for: .gardenEntry)
        let referenceFields = Set(
            candidates.compactMap { option in
                option.route.bindings.first {
                    $0.source == .sourceId || $0.source == .sourceIdList
                }?.field
            })

        #expect(!candidates.isEmpty)
        #expect(candidates.allSatisfy { $0.route.kind == .createRelated && $0.route.target == .gardenEntry })
        #expect(referenceFields == ["locationId", "plantingIds"])
        let fallback = try #require(PhotoImportManifest.createSelfOption(for: .gardenEntry))
        #expect(fallback.route.kind == .createSelf)
        #expect(fallback.route.enabled)
    }

    /// 8c: a disabled `createSelf` route (e.g. Project — "create one in Projects first") must
    /// never actually stage a draft, even if something upstream calls `stageCreate` on it — the
    /// UI disabling its row is not the only guard.
    @Test func stageCreateNeverStagesADisabledRoute() throws {
        let item = try selection(filename: "disabled.jpg")
        let manifest = makeManifest(items: [item])
        let option = try #require(PhotoImportManifest.createSelfOption(for: .project))
        #expect(!option.route.enabled)

        manifest.selectedIDs = [item.id]
        manifest.stageCreate(option: option, source: nil, body: [:])

        #expect(manifest.needsDestination == [item.id])
        #expect(manifest.groups.isEmpty)
    }

    @Test func aSharedVisionSuggestionTakesSelectedPhotosStraightToTheirSourceType() {
        let selected = Set(["photo-1", "photo-2"])

        #expect(
            PhotoImportManifest.preferredSourceType(
                selectedIDs: selected,
                suggestions: ["photo-1": .planting, "photo-2": .planting]) == .planting)
        #expect(
            PhotoImportManifest.preferredSourceType(
                selectedIDs: selected,
                suggestions: ["photo-1": .planting, "photo-2": .meal]) == nil)
        #expect(
            PhotoImportManifest.preferredSourceType(
                selectedIDs: selected,
                suggestions: ["photo-1": .planting]) == nil)
    }

    @Test func mixedBatchKeepsPartialSourceSuggestionsActionable() throws {
        let groups = PhotoImportManifest.sourceTypeSuggestionGroups(
            selectedIDs: ["plant-1", "plant-2", "meal-1", "unknown"],
            suggestions: [
                "plant-1": .planting,
                "plant-2": .planting,
                "meal-1": .meal,
            ])

        #expect(groups.count == 2)
        let planting = try #require(groups.first)
        #expect(planting.source == .planting)
        #expect(planting.photoIDs == ["plant-1", "plant-2"])
        #expect(groups[1].source == .meal)
        #expect(groups[1].photoIDs == ["meal-1"])
    }

    private func selection(filename: String, capturedAt: Date? = nil) throws -> PhotoSelectionItem {
        let image = try #require(
            CGContext(
                data: nil, width: 2, height: 2, bitsPerComponent: 8,
                bytesPerRow: 8, space: CGColorSpaceCreateDeviceRGB(),
                bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue)?.makeImage())
        let file = try PhotoFile(
            url: URL(fileURLWithPath: "/unused-\(filename)"), filename: filename,
            contentType: "image/jpeg", size: 1, width: 2, height: 2, capturedAt: capturedAt)
        return PhotoSelectionItem(file: file, preview: image)
    }

    /// A `CubbyClient` stubbed at the network layer (same approach as `PhotoMatchStoreTests`) so
    /// `chooseSourceRecord`'s auto-resolve exercises the real `findRelated` → `CubbyClient.list`
    /// path against a canned Garden Entry list page, rather than a re-implemented loader.
    /// Each row must satisfy the generated Garden Entry list schema: a decode failure is caught by
    /// `chooseSourceRecord` and silently falls back to the create path, so a stale fixture (it
    /// once lacked the required `dataQuality`) reads as a routing regression, not a decode error.
    private func routeClient(gardenEntries: [(id: String, locationId: String)]) throws -> CubbyClient {
        let items =
            gardenEntries
            .map { entry in
                """
                {"id":"\(entry.id)","locationId":"\(entry.locationId)","plantingIds":[],"kind":"note","observedOn":"2026-09-10","note":null,"harvestAmount":null,"images":[],"displayName":"\(entry.id)","locationName":"Test bed","plantings":[],"createdAt":"2026-09-10T00:00:00Z","updatedAt":"2026-09-10T00:00:00Z","displayImages":[],"dataQuality":{"status":"complete","score":100,"facets":[],"gaps":[],"exceptions":[],"relatedGaps":[],"relatedExceptions":[]}}
                """
            }.joined(separator: ",")
        let json =
            "{\"items\":[\(items)],\"meta\":{\"pageIndex\":1,\"pageSize\":25,\"totalCount\":\(gardenEntries.count)}}"
        PhotoRouteTestProtocol.response.withLock { $0 = Data(json.utf8) }
        let configuration = URLSessionConfiguration.ephemeral
        configuration.protocolClasses = [PhotoRouteTestProtocol.self]
        let store = InMemorySessionTokenStore()
        try store.save(.bearer("test-route-token"), for: "photo-routes.example.invalid")
        return CubbyClient(
            baseURL: URL(string: "https://photo-routes.example.invalid")!,
            credentials: CredentialProvider(host: "photo-routes.example.invalid", store: store),
            session: URLSession(configuration: configuration))
    }
}

/// The synchronized response belongs only to this serialized suite; it never reaches a network.
nonisolated private final class PhotoRouteTestProtocol: URLProtocol, @unchecked Sendable {
    static let response = Mutex(Data())
    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }
    override func startLoading() {
        let response = HTTPURLResponse(
            url: request.url!, statusCode: 200, httpVersion: nil,
            headerFields: ["Content-Type": "application/json"])!
        client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
        client?.urlProtocol(self, didLoad: Self.response.withLock { $0 })
        client?.urlProtocolDidFinishLoading(self)
    }
    override func stopLoading() {}
}
