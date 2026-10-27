import Foundation
import Synchronization
import Testing

@testable import CubbyKit

private final class EditStub: URLProtocol, @unchecked Sendable {
    static let handler = Mutex<StubNetworking.Handler?>(nil)
    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }
    override func startLoading() {
        StubNetworking.startLoading(
            request, client: client, target: self, handler: Self.handler.withLock { $0 })
    }
    override func stopLoading() {}
    static func session() -> URLSession { StubNetworking.session(protocolClass: self) }
}

/// The generic editor's wire contract: exactly the changed keys, `null` for a cleared nullable
/// key, never a locked key, and a validation rejection mapped back onto its fields with the draft
/// intact.
@Suite("GenericEntityEditModel", .serialized)
@MainActor
struct GenericEntityEditModelTests {
    @Test func dirtyStateTracksChangesAgainstSeededDefaultsAndPrefills() throws {
        let model = GenericEntityEditModel(
            descriptor: EntityCatalog[.gardenEntry],
            mode: .create(prefill: ["locationId": "LOC-2345"]), client: try makeClient())
        #expect(!model.isDirty)
        #expect(model.draft["observedOn"] != .null)
        model.markEdited("notes")
        #expect(!model.isDirty)
        model.draft["locationId"] = .null
        #expect(model.isDirty)
        #expect(!model.canSave)
        model.draft["locationId"] = "LOC-2345"
        #expect(!model.isDirty)
        #expect(model.stage(["notes": "Inspect the lower leaves"]))
        #expect(model.isDirty)
    }

    @Test func dirtyStateIncludesImageOnlyChangesAndTheirReversal() throws {
        let model = GenericEntityEditModel(
            descriptor: EntityCatalog[.product], mode: .update(id: "PRD-2345"),
            client: try makeClient(), original: Self.productOriginal)
        #expect(!model.isDirty)
        model.pendingUploads = [ImageCode("IMG-5678")]
        #expect(model.isDirty)
        model.pendingUploads = []
        model.removedImages = [ImageCode("IMG-3456")]
        model.imageOrder.removeAll { $0 == ImageCode("IMG-3456") }
        #expect(model.isDirty)
        model.removedImages = []
        model.imageOrder = model.originalImageOrder.reversed()
        #expect(model.isDirty)
        model.imageOrder = model.originalImageOrder
        #expect(!model.isDirty)
    }

    @Test func refusedAccountFieldsHaveNoEditorAndBecomeEditableForCreditCards() throws {
        let model = GenericEntityEditModel(
            descriptor: EntityCatalog[.financialAccount], mode: .update(id: "FAC-2345"),
            client: try makeClient(), original: ["identity": ["kind": "bank_account"]])
        let refused: Set<String> = ["network", "primaryCardholderId", "authorizedUsers"]
        #expect(Set(model.visibleFields.map(\.key)).isDisjoint(with: refused))
        model.draft["identity"] = ["kind": "credit_card"]
        #expect(refused.isSubset(of: Set(model.visibleFields.map(\.key))))
        model.draft["identity"] = .null
        #expect(Set(model.visibleFields.map(\.key)).isDisjoint(with: refused))
    }

    @Test func reloadingUsesTheIncomingClassifierInsteadOfThePreviousDraft() async throws {
        defer { EditStub.handler.withLock { $0 = nil } }
        let incoming: JSONValue = [
            "id": "EXP-2345", "lineKind": "principal", "spendingCategoryId": "SPC-2345",
        ]
        let data = try JSONEncoder.cubby().encode(incoming)
        EditStub.handler.withLock { handler in handler = { _ in (200, data) } }
        let model = GenericEntityEditModel(
            descriptor: EntityCatalog[.expense], mode: .update(id: "EXP-2345"), client: try makeClient(),
            original: ["id": "EXP-2345", "lineKind": "unclassified"])
        model.draft["lineKind"] = "fee"
        await model.load()
        #expect(model.loadError == nil)
        #expect(model.draft["lineKind"] == "principal")
        #expect(model.draft["spendingCategoryId"] == "SPC-2345")
        #expect(try model.patch().isEmpty)
    }

    @Test func reclassificationOmitsNewlyRefusedDraftEditsFromWrites() throws {
        let update = GenericEntityEditModel(
            descriptor: EntityCatalog[.expense], mode: .update(id: "EXP-2345"), client: try makeClient(),
            original: ["id": "EXP-2345", "lineKind": "principal", "productId": .null])
        update.draft["productId"] = "PRD-2345"
        update.draft["lineKind"] = "fee"
        #expect(!update.visibleFields.contains { $0.key == "productId" })
        let patch = try update.patch()
        #expect(patch.values["productId"] == nil)
        #expect(!patch.cleared.contains("productId"))
        #expect(patch.values["lineKind"] == "fee")
        let create = GenericEntityEditModel(
            descriptor: EntityCatalog[.expense], mode: .create(prefill: ["lineKind": "principal"]),
            client: try makeClient())
        create.draft["productId"] = "PRD-2345"
        create.draft["lineKind"] = "fee"
        #expect(create.createBody()["productId"] == nil)
    }

    @Test func dateRangePatchReplacesClearsAndRejectsReversedDates() async throws {
        let original: JSONValue = [
            "id": "PRJ-2345", "dates": ["start": "2039-05-10", "end": "2039-05-20"],
        ]
        let model = GenericEntityEditModel(
            descriptor: EntityCatalog[.project], mode: .update(id: "PRJ-2345"),
            client: try makeClient(), original: original)
        #expect(try model.patch().isEmpty)
        let replacement: JSONValue = ["start": .null, "end": "2039-05-21"]
        model.draft["dates"] = replacement
        #expect(try model.patch().values["dates"] == replacement)
        model.draft["dates"] = .null
        #expect(try model.patch().cleared == ["dates"])
        model.draft["dates"] = ["start": "2039-05-21", "end": "2039-05-10"]
        #expect(!model.canSave)
        #expect(!(await model.save()))
        #expect(model.fieldErrors["dates"] == "Start must be on or before end")
        let historical = GenericEntityEditModel(
            descriptor: EntityCatalog[.project], mode: .update(id: "PRJ-2345"),
            client: try makeClient(),
            original: [
                "id": "PRJ-2345", "name": "Original",
                "dates": ["start": "2039-05-21", "end": "2039-05-10"],
            ])
        historical.draft["name"] = "Renamed"
        #expect(historical.canSave)
        #expect(historical.dateRangeErrors.isEmpty)
        #expect(try historical.patch().values["dates"] == nil)

    }

    @Test func invalidCollectionDraftCanExposeItsSaveErrorWithoutLosingInput() async throws {
        let model = GenericEntityEditModel(
            descriptor: EntityCatalog[.product], mode: .update(id: "PRD-2345"), client: try makeClient(),
            original: ["id": "PRD-2345", "externalIds": []])
        var edit = try #require(CollectionEdit.decode(model.draft["externalIds"]))
        edit.rows.append(
            CollectionEdit.Row(
                baseline: nil,
                value: [
                    "source": "gtin", "kind": "gtin_14", "externalId": "00012345678906", "url": .null,
                ]))
        model.draft["externalIds"] = edit.json
        #expect(model.canSave)
        #expect(!(await model.save()))
        #expect(model.bannerError != nil)
        #expect(model.draft["externalIds"] == edit.json)
        #expect(model.savedID == nil)
    }

    @Test func collectionPromotionSendsKeyedIntentWithStoredExpectations() async throws {
        let seen = capture { _ in (200, Self.productUpdated) }
        let original: JSONValue = [
            "id": "PRD-2345", "name": "Sample",
            "externalIds": [
                [
                    "source": "amazon", "kind": "asin", "externalId": "B0EXAMP001",
                    "url": "https://www.amazon.com/dp/B0EXAMP001", "isPrimary": false,
                ]
            ],
        ]
        let model = GenericEntityEditModel(
            descriptor: EntityCatalog[.product], mode: .update(id: "PRD-2345"), client: try makeClient(),
            original: original)
        var edit = try #require(CollectionEdit.decode(model.draft["externalIds"]))
        #expect(try model.patch().values["externalIds"] == nil)
        edit.rows[0].primaryIntent = true
        model.draft["externalIds"] = edit.json
        #expect(await model.save())
        #expect(
            seen.requests.first?.body["data"]?["externalIds"] == [
                [
                    "op": "replace", "key": ["source": "amazon", "kind": "asin", "externalId": "B0EXAMP001"],
                    "value": ["isPrimary": true], "expect": ["url": .null, "isPrimary": false],
                ]
            ])
    }

    @Test func equivalentBarcodeDraftDoesNotRetireTheSavedIdentity() throws {
        let original: JSONValue = [
            "id": "PRD-2345",
            "externalIds": [
                [
                    "source": "gtin", "kind": "gtin_14", "externalId": "00012345678905", "url": .null,
                    "isPrimary": true,
                ]
            ],
        ]
        let model = GenericEntityEditModel(
            descriptor: EntityCatalog[.product], mode: .update(id: "PRD-2345"), client: try makeClient(),
            original: original)
        var edit = try #require(CollectionEdit.decode(model.draft["externalIds"]))
        edit.rows[0].value?["externalId"] = "012345678905"
        model.draft["externalIds"] = edit.json
        #expect(try model.patch().values["externalIds"] == nil)
        #expect(!model.visibleFields.contains { $0.key == "barcode" })
    }

    private struct Seen: Sendable {
        let method: String?
        let path: String
        let body: [String: JSONValue]
    }

    private final class Recorder: Sendable {
        let seen = Mutex<[Seen]>([])
        var requests: [Seen] { seen.withLock { $0 } }
    }

    private func makeClient() throws -> CubbyClient {
        let store = InMemorySessionTokenStore()
        try store.save(.bearer("tok"), for: "localhost:3000")
        let credentials = CredentialProvider(host: "localhost:3000", store: store)
        return CubbyClient(
            baseURL: URL(string: "http://localhost:3000")!, credentials: credentials,
            session: EditStub.session())
    }

    /// Installs a handler that records every request and answers with `respond`.
    private func capture(_ respond: @escaping @Sendable (URLRequest) -> (Int, Data)) -> Recorder {
        let recorder = Recorder()
        EditStub.handler.withLock { handler in
            handler = { request in
                let fields = StubNetworking.operationFields(of: request)
                recorder.seen.withLock {
                    $0.append(Seen(method: request.httpMethod, path: request.url?.path ?? "", body: fields))
                }
                return respond(request)
            }
        }
        return recorder
    }

    // Mutation receipts carry identity and submitted scalars; detail refresh is separate.
    nonisolated private static let productUpdated = Data(
        #"{"action":"update","entity":"product","item":{"id":"PRD-2345"},"appliedFields":[],"sideEffects":{"derivedRefresh":{"mode":"background"}}}"#
            .utf8)
    nonisolated private static let locationCreated = Data(
        #"{"action":"create","entity":"location","item":{"id":"LOC-9ABC","name":"Bin 9","type":"area"},"appliedFields":["name","type"],"sideEffects":{"derivedRefresh":{"mode":"background"}}}"#
            .utf8)

    private static let productOriginal: JSONValue = [
        "id": "PRD-2345", "name": "Skillet", "brandId": "VEN-2345", "brandName": "Sample Co",
        "categoryId": "CAT-2224",
        "attachments": [["id": "IMG-2345"], ["id": "IMG-3456"], ["id": "IMG-4567"]],
    ]

    @Test func acknowledgingSavedCategoryPreservesNewerDraftAndSiblingChanges() throws {
        let model = GenericEntityEditModel(
            descriptor: EntityCatalog[.expense], mode: .update(id: "EXP-4K7M"),
            client: try makeClient(),
            original: ["lineKind": "principal", "spendingCategoryId": .null, "notes": "Saved note"])
        model.draft["notes"] = .string("Unsaved sibling")
        model.draft["spendingCategoryId"] = .string("SPC-8K7M")
        model.acknowledgeSavedField(
            "spendingCategoryId", value: .string("SPC-4K7M"), reviewedDraftValue: .null)
        #expect(model.original?["spendingCategoryId"] == .string("SPC-4K7M"))
        #expect(model.draft["spendingCategoryId"] == .string("SPC-8K7M"))
        #expect(try model.patch().values["spendingCategoryId"] == .string("SPC-8K7M"))
        #expect(try model.patch().values["notes"] == .string("Unsaved sibling"))
    }

    @Test func acknowledgedCategoryDoesNotReplayOnLaterSiblingSave() throws {
        let model = GenericEntityEditModel(
            descriptor: EntityCatalog[.expense], mode: .update(id: "EXP-4K7M"),
            client: try makeClient(),
            original: ["lineKind": "principal", "spendingCategoryId": .null, "notes": "Saved note"])
        model.draft["notes"] = .string("Unsaved sibling")
        model.acknowledgeSavedField(
            "spendingCategoryId", value: .string("SPC-4K7M"), reviewedDraftValue: .null)
        #expect(model.draft["spendingCategoryId"] == .string("SPC-4K7M"))
        #expect(try model.patch().values["spendingCategoryId"] == nil)
        #expect(try model.patch().values["notes"] == .string("Unsaved sibling"))
        #expect(model.isDirty)
        model.draft["notes"] = "Saved note"
        #expect(!model.isDirty)
    }

    private typealias F = FieldEnvelopeFixture

    private static func category(
        assignment: JSONValue, reset: JSONValue = ["kind": "unavailable"], result: JSONValue
    ) -> JSONValue {
        F.envelope(assignment: assignment, controls: F.editable(reset: reset), result: result)
    }

    @Test func inheritedReadDoesNotBecomeStoredDraftOrUnchangedPatch() throws {
        let original = F.row(
            ["lineKind": "principal"],
            fields: [
                "spendingCategoryId": Self.category(
                    assignment: F.inherit,
                    result: F.live(F.decision("SPC-4K7M", provenance: F.inherited("purchase", "PUR-4K7M"))))
            ])
        let model = GenericEntityEditModel(
            descriptor: EntityCatalog[.expense], mode: .update(id: "EXP-4K7M"), client: try makeClient(),
            original: original)
        #expect(model.draft["spendingCategoryId"] == .null)
        #expect(try model.patch().values["spendingCategoryId"] == nil)
        #expect(!model.canSave)
    }

    /// A stale cached value is a result, not stored intent: the draft keeps S.
    @Test func cachedEffectiveValueNeverSeedsTheDraft() throws {
        let original = F.row(
            ["lineKind": "principal"],
            fields: [
                "spendingCategoryId": Self.category(
                    assignment: F.value("SPC-8K7M"),
                    result: F.cached(
                        F.decision("SPC-4K7M", provenance: F.inherited("purchase", "PUR-4K7M")),
                        freshness: "stale"))
            ])
        let model = GenericEntityEditModel(
            descriptor: EntityCatalog[.expense], mode: .update(id: "EXP-4K7M"), client: try makeClient(),
            original: original)
        #expect(model.draft["spendingCategoryId"] == .string("SPC-8K7M"))
        #expect(try model.patch().isEmpty)
    }

    @Test func resolutionResetStagesDeclaredPatchOnlyWhenServerAllowsIt() throws {
        func original(_ reset: JSONValue) -> JSONValue {
            F.row(
                ["lineKind": "principal", "notes": "Keep this"],
                fields: [
                    "spendingCategoryId": Self.category(
                        assignment: F.value("SPC-8K7M"), reset: reset,
                        result: F.live(F.decision("SPC-8K7M", provenance: F.own)))
                ])
        }
        let blocked = GenericEntityEditModel(
            descriptor: EntityCatalog[.expense], mode: .update(id: "EXP-4K7M"), client: try makeClient(),
            original: original(["kind": "unavailable"]))
        #expect(!blocked.stageResolutionReset("spendingCategoryId"))
        #expect(try blocked.patch().isEmpty)
        let allowed = GenericEntityEditModel(
            descriptor: EntityCatalog[.expense], mode: .update(id: "EXP-4K7M"), client: try makeClient(),
            original: original(F.resetNotLoaded))
        #expect(allowed.stageResolutionReset("spendingCategoryId"))
        let resetPatch = try allowed.patch()
        #expect(resetPatch.values.isEmpty)
        #expect(resetPatch.cleared == ["spendingCategoryId"])
        #expect(allowed.draft["notes"] == .string("Keep this"))
    }

    /// A saved acknowledgement drops the pre-write envelope; its controls are not reused.
    @Test func acknowledgedFieldDoesNotKeepStaleResolutionEvidence() throws {
        let field = try #require(EntityCatalog[.expense].field("spendingCategoryId"))
        let original = F.row(
            ["lineKind": "principal"],
            fields: [
                "spendingCategoryId": Self.category(
                    assignment: F.inherit, reset: F.resetNotLoaded,
                    result: F.live(F.decision("SPC-4K7M", provenance: F.inherited("purchase", "PUR-4K7M"))))
            ])
        let model = GenericEntityEditModel(
            descriptor: EntityCatalog[.expense], mode: .update(id: "EXP-4K7M"), client: try makeClient(),
            original: original)
        model.acknowledgeSavedField(
            "spendingCategoryId", value: .string("SPC-8K7M"), reviewedDraftValue: .null)
        let saved = try #require(model.original)
        #expect(FieldEnvelope.of(saved, field: field) == nil)
        #expect(saved.recordValue("spendingCategoryId") == .string("SPC-8K7M"))
        #expect(model.resolutionForEditor(field) == nil)
        #expect(!model.stageResolutionReset(field.key))
        #expect(try model.patch().values["spendingCategoryId"] == nil)
    }

    @Test func editedAssignmentOrDependencyCannotPresentSavedResolutionAsCurrent() throws {
        let field = try #require(EntityCatalog[.expense].field("spendingCategoryId"))
        let original = F.row(
            ["purchaseId": "PUR-4K7M"],
            fields: [
                "spendingCategoryId": Self.category(
                    assignment: F.value("SPC-8K7M"), reset: F.resetNotLoaded,
                    result: F.live(F.decision("SPC-8K7M", provenance: F.own)))
            ])
        let model = GenericEntityEditModel(
            descriptor: EntityCatalog[.expense], mode: .update(id: "EXP-4K7M"),
            client: try makeClient(), original: original)
        #expect(model.resolutionForEditor(field) != nil)
        model.draft["purchaseId"] = .string("PUR-8K7M")
        #expect(model.resolutionForEditor(field) == nil)
        #expect(!model.stageResolutionReset(field.key))
        model.draft["purchaseId"] = .string("PUR-4K7M")
        #expect(model.resolutionForEditor(field) != nil)
        #expect(model.stageResolutionReset(field.key))
        #expect(model.resolutionForEditor(field) == nil)
        #expect(!model.stageResolutionReset(field.key))
    }

    /// Draft classifiers replace the saved envelope in the applicability record.
    @Test func applicabilityRecordReadsDraftedGovernedKeys() throws {
        let original = F.row(
            ["lineKind": "principal"],
            fields: [
                "spendingCategoryId": Self.category(
                    assignment: F.inherit,
                    result: F.live(F.decision("SPC-4K7M", provenance: F.inherited("purchase", "PUR-4K7M"))))
            ])
        let model = GenericEntityEditModel(
            descriptor: EntityCatalog[.expense], mode: .update(id: "EXP-4K7M"), client: try makeClient(),
            original: original)
        #expect(model.applicabilityRecord.recordValue("spendingCategoryId") == .null)
        model.draft["spendingCategoryId"] = .string("SPC-8K7M")
        #expect(model.applicabilityRecord.recordValue("spendingCategoryId") == .string("SPC-8K7M"))
    }

    /// A manual picker choice after reset must replace the staged inheritance intent.
    @Test func referenceSelectionAfterResetRestoresExplicitIntent() throws {
        let prefix = try #require(EntityCatalog[.ledgerParty].shortcodePrefix)
        let first = prefix + "4K7M"
        let second = prefix + "8K7M"
        for key in [EntityKey.task, .project] {
            let original = F.row(
                fields: [
                    "assigneeId": F.envelope(
                        assignment: F.value(.string(first)),
                        controls: F.editable(canSetNone: true, reset: F.resetNotLoaded),
                        result: F.live(F.decision(.string(first), provenance: F.own)))
                ])
            let model = GenericEntityEditModel(
                descriptor: EntityCatalog[key], mode: .update(id: "synthetic-record"),
                client: try makeClient(), original: original)
            #expect(model.stageResolutionReset("assigneeId"))
            #expect(try model.patch().values["assigneeMode"] == .string("inherit"))
            #expect(model.stageReferenceSelection("assigneeId", value: .string(second)))
            let patch = try model.patch()
            #expect(patch.values["assigneeId"] == .string(second))
            // The stored intent is already explicit, so the mode is unchanged and not resent.
            #expect(patch.values["assigneeMode"] == nil)
            #expect(model.draft["assigneeMode"] == .string("explicit"))
            #expect(model.stageReferenceSelection("assigneeId", value: .null))
            #expect(try model.patch().cleared.contains("assigneeId"))
            #expect(model.draft["assigneeMode"] == .string("explicit"))
        }
    }

    /// Keep this value pins the current inherited owner explicitly; Set to Household is
    /// explicit with no owner. Both come from current controls.
    @Test func ownershipResolutionActionsStageTheDeclaredPatch() throws {
        let prefix = try #require(EntityCatalog[.ledgerParty].shortcodePrefix)
        let owner = prefix + "4K7M"
        let original = F.row(
            fields: [
                "ownerLedgerPartyId": F.envelope(
                    assignment: F.inherit, controls: F.editable(canSetNone: true, canConfirm: true),
                    result: F.live(F.decision(.string(owner), provenance: F.inherited("product", "PRD-4K7M")))
                )
            ])
        func model() throws -> GenericEntityEditModel {
            GenericEntityEditModel(
                descriptor: EntityCatalog[.inventory], mode: .update(id: "synthetic-entry"),
                client: try makeClient(), original: original)
        }
        let keeping = try model()
        #expect(keeping.draft["ownerLedgerPartyId"] == .null)
        #expect(!keeping.stageResolution(.useInherited, for: "ownerLedgerPartyId"))
        #expect(keeping.stageResolution(.keepValue, for: "ownerLedgerPartyId"))
        let kept = try keeping.patch()
        #expect(kept.values["ownershipMode"] == .string("explicit"))
        #expect(kept.values["ownerLedgerPartyId"] == .string(owner))

        let household = try model()
        #expect(household.stageResolution(.setNone, for: "ownerLedgerPartyId"))
        let cleared = try household.patch()
        #expect(cleared.values["ownershipMode"] == .string("explicit"))
        // The stored owner is already null under inherit, so the mode alone carries Household.
        #expect(cleared.values["ownerLedgerPartyId"] == nil)
    }

    /// None and inherit stay distinct stored intents: an untouched explicit None saves nothing,
    /// and Use inherited from None sends only the mode.
    @Test func explicitNoneStaysDistinctFromInherit() throws {
        let original = F.row(
            fields: [
                "ownerLedgerPartyId": F.envelope(
                    assignment: F.none,
                    controls: F.editable(canSetNone: true, canConfirm: true, reset: F.resetNotLoaded),
                    result: F.live(F.emptyDecision("explicit_none", provenance: F.own)))
            ])
        let model = GenericEntityEditModel(
            descriptor: EntityCatalog[.inventory], mode: .update(id: "synthetic-entry"),
            client: try makeClient(), original: original)
        #expect(model.draft["ownerLedgerPartyId"] == .null)
        #expect(try model.patch().isEmpty)
        #expect(!model.stageResolution(.setNone, for: "ownerLedgerPartyId"))
        #expect(model.stageResolutionReset("ownerLedgerPartyId"))
        let reset = try model.patch()
        #expect(reset.values["ownershipMode"] == .string("inherit"))
        #expect(reset.values["ownerLedgerPartyId"] == nil)
    }

    @Test func updateSendsExactlyTheChangedAndClearedKeys() async throws {
        defer { EditStub.handler.withLock { $0 = nil } }
        let seen = capture { _ in (200, Self.productUpdated) }
        let model = GenericEntityEditModel(
            descriptor: EntityCatalog[.product], mode: .update(id: "PRD-2345"), client: try makeClient(),
            original: Self.productOriginal)
        #expect(!model.canSave)
        model.draft["brandId"] = "VEN-3456"
        model.draft["categoryId"] = .null
        #expect(model.canSave)
        let saved = await model.save()
        #expect(saved)
        #expect(model.savedID == "PRD-2345")
        let requests = seen.requests
        #expect(requests.count == 1)
        #expect(requests.first?.method == "POST")
        #expect(requests.first?.path == "/api/operations/entity.mutate")
        #expect(
            requests.first?.body == [
                "action": "update", "entity": "product", "id": "PRD-2345",
                "data": ["brandId": "VEN-3456", "categoryId": .null],
            ])
    }

    @Test func createPostsTheDraftAndReturnsTheID() async throws {
        defer { EditStub.handler.withLock { $0 = nil } }
        let seen = capture { _ in (200, Self.locationCreated) }
        let model = GenericEntityEditModel(
            descriptor: EntityCatalog[.location], mode: .create(prefill: ["type": "area"]),
            client: try makeClient())
        #expect(model.missingRequiredKeys.contains("name"))
        #expect(!model.canSave)
        model.draft["name"] = "Bin 9"
        #expect(model.canSave)
        let saved = await model.save()
        #expect(saved)
        #expect(model.savedID == "LOC-9ABC")
        let requests = seen.requests
        #expect(requests.first?.method == "POST")
        #expect(requests.first?.path == "/api/operations/entity.mutate")
        #expect(
            requests.first?.body == [
                "action": "create", "entity": "location", "data": ["name": "Bin 9", "type": "area"],
            ])
    }

    /// A failed read leaves no original to save; retrying the read must clear its error so the
    /// editor doesn't present the stale read failure as a refused save.
    @Test func retriedLoadClearsTheEarlierReadFailure() async throws {
        defer { EditStub.handler.withLock { $0 = nil } }
        let productRead = try Fixtures.data(named: "product-get.json")
        let attempts = Mutex(0)
        // Reads carry no body, so this stub skips `capture`'s body recording.
        EditStub.handler.withLock { handler in
            handler = { _ in
                let attempt = attempts.withLock { count in
                    count += 1
                    return count
                }
                return attempt == 1
                    ? (500, Data(#"{"code":"INTERNAL","message":"upstream unavailable"}"#.utf8))
                    : (200, productRead)
            }
        }
        let model = GenericEntityEditModel(
            descriptor: EntityCatalog[.product], mode: .update(id: "PRD-2345"), client: try makeClient())
        await model.load()
        #expect(model.original == nil)
        #expect(model.loadError != nil)
        #expect(model.bannerError == nil)
        #expect(!model.canSave)
        await model.load()
        #expect(model.original != nil)
        #expect(model.loadError == nil)
        #expect(!model.isDirty)
    }

    /// Update editors open with the detail projection as a seed. When the fresh read fails, that
    /// projection is not an edit baseline: the failure is a read error, not a refused save, and an
    /// edit can't update against the stale projection.
    @Test func failedReadOverASeededProjectionBlocksSaving() async throws {
        defer { EditStub.handler.withLock { $0 = nil } }
        EditStub.handler.withLock { handler in
            handler = { _ in (500, Data(#"{"code":"INTERNAL","message":"upstream unavailable"}"#.utf8)) }
        }
        let model = GenericEntityEditModel(
            descriptor: EntityCatalog[.product], mode: .update(id: "PRD-2345"), client: try makeClient(),
            original: Self.productOriginal)
        await model.load()
        #expect(model.loadError != nil)
        #expect(model.bannerError == nil)
        model.draft["brandId"] = "VEN-3456"
        #expect(!model.canSave)
    }

    @Test func validationRejectionLandsOnTheFieldAndKeepsTheDraft() async throws {
        defer { EditStub.handler.withLock { $0 = nil } }
        _ = capture { _ in
            (
                400,
                Data(
                    #"{"code":"VALIDATION","message":"Invalid input","validationIssues":[{"code":"too_small","path":["name"],"message":"Name is required"}]}"#
                        .utf8)
            )
        }
        let model = GenericEntityEditModel(
            descriptor: EntityCatalog[.product], mode: .update(id: "PRD-2345"), client: try makeClient(),
            original: Self.productOriginal)
        model.draft["name"] = "x"
        let saved = await model.save()
        #expect(!saved)
        #expect(model.fieldErrors == ["name": "Name is required"])
        #expect(model.bannerError == nil)
        #expect(model.draft["name"] == "x")
        #expect(model.savedID == nil)
        #expect(model.isDirty)
    }

    @Test func kernelValidationPathsReachFieldsWithoutHidingOtherIssues() async throws {
        defer { EditStub.handler.withLock { $0 = nil } }
        _ = capture { _ in
            (
                400,
                Data(
                    #"{"code":"VALIDATION","message":"Invalid input","validationIssues":[{"code":"custom","path":["data","name"],"message":"Choose a longer name"},{"code":"custom","path":["name"],"message":"Name is reserved"},{"code":"custom","path":[],"message":"Record cannot be saved"},{"code":"custom","path":["data","unknownField"],"message":"Unsupported field"}]}"#
                        .utf8)
            )
        }
        let model = GenericEntityEditModel(
            descriptor: EntityCatalog[.product], mode: .update(id: "PRD-2345"),
            client: try makeClient(), original: Self.productOriginal)
        model.draft["name"] = "x"
        #expect(!(await model.save()))
        #expect(model.fieldErrors == ["name": "Choose a longer name; Name is reserved"])
        #expect(model.bannerError == "Record cannot be saved\ndata.unknownField: Unsupported field")
        #expect(model.draft["name"] == "x")
        #expect(model.isDirty)
    }

    @Test func validationForUnavailableFieldsPreservesRawServerDiagnostics() async throws {
        defer { EditStub.handler.withLock { $0 = nil } }
        let rejection = Data(
            #"{"code":"VALIDATION","message":"Invalid input","validationIssues":[{"code":"custom","path":["data","id"],"message":"Record no longer exists"}],"diagnostics":{"origin":"server","operation":"entity.mutate","stage":"input","causes":[{"name":"ConstraintError","message":"underlying check failed","code":"23514"}]}}"#
                .utf8)
        _ = capture { _ in (400, rejection) }
        let model = GenericEntityEditModel(
            descriptor: EntityCatalog[.product], mode: .update(id: "PRD-2345"),
            client: try makeClient(), original: Self.productOriginal)
        model.draft["name"] = "New name"
        #expect(!(await model.save()))
        #expect(model.fieldErrors.isEmpty)
        #expect(model.bannerError == String(decoding: rejection, as: UTF8.self))
        #expect(model.draft["name"] == "New name")
    }

    @Test func imageOrderTravelsOnlyWhenReordered() async throws {
        defer { EditStub.handler.withLock { $0 = nil } }
        let seen = capture { _ in (200, Self.productUpdated) }
        let model = GenericEntityEditModel(
            descriptor: EntityCatalog[.product], mode: .update(id: "PRD-2345"), client: try makeClient(),
            original: Self.productOriginal)
        model.removedImages = [ImageCode("IMG-3456")]
        model.imageOrder = [ImageCode("IMG-2345"), ImageCode("IMG-4567")]
        #expect(model.canSave)
        #expect(await model.save())
        #expect(seen.requests.first?.body["data"] == ["removeImageIds": ["IMG-3456"]])

        model.imageOrder = [ImageCode("IMG-4567"), ImageCode("IMG-2345")]
        model.pendingUploads = [ImageCode("IMG-5678")]
        #expect(await model.save())
        let body = seen.requests.last?.body["data"]
        #expect(body?["imageOrder"] == ["IMG-4567", "IMG-2345"])
        #expect(body?["pendingImageIds"] == ["IMG-5678"])
    }

    @Test func compiledSectionsPlaceEveryVisibleField() throws {
        let model = GenericEntityEditModel(
            descriptor: EntityCatalog[.product], mode: .create(prefill: [:]), client: try makeClient())
        let sections = model.sections
        #expect(!sections.isEmpty)
        let placed = Set(sections.flatMap(\.fields))
        #expect(placed == Set(model.visibleFields.map(\.key)))
        #expect(model.visibleFields.allSatisfy { $0.inCreate && $0.controlKind != nil })
    }

    @Test(arguments: [EntityKey.ingredient, .wish, .meal])
    func smallEditorsUseOneMainSection(key: EntityKey) throws {
        let model = GenericEntityEditModel(
            descriptor: EntityCatalog[key], mode: .create(prefill: [:]), client: try makeClient())
        #expect(model.sections.map(\.id) == ["main"])
    }
}
