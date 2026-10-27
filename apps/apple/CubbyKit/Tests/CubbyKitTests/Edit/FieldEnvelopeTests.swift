import Foundation
import Testing

@testable import CubbyKit

/// The canonical envelope: stored intent S, current controls, a possibly cached result V and
/// refresh work. Controls and ownership are current; a cached decision is never re-attributed.
@Suite("Field envelope")
@MainActor
struct FieldEnvelopeTests {
    typealias F = FieldEnvelopeFixture

    private func itemization() throws -> FieldDescriptor {
        let source =
            #"{"key":"itemizationExpectation","label":"Receipt expectation","kind":"enum","nullable":true,"controlKind":"select","controlOptions":[{"value":"unknown","label":"Unclassified"},{"value":"required","label":"Expected"},{"value":"not_expected","label":"Not expected"}],"resolution":{"reset":{"itemizationExpectation":null},"none":null,"redundancy":"eligible"},"inCreate":true,"requiredOnCreate":false,"inUpdate":true,"showInList":true,"showInDetail":true,"listHidden":false,"mobileInteractive":false}"#
        return try JSONDecoder().decode(FieldDescriptor.self, from: Data(source.utf8))
    }

    private func owner() throws -> FieldDescriptor {
        try #require(EntityCatalog[.inventory].field("ownerLedgerPartyId"))
    }

    private func envelope(_ json: JSONValue) throws -> FieldEnvelope {
        try #require(FieldEnvelope(json))
    }

    // MARK: Parsing

    @Test func parsesEveryKnownVariant() throws {
        let cached = try envelope(
            F.envelope(
                assignment: F.value("required", ownership: F.automatic(0.5)),
                controls: F.editable(canSetNone: true, canConfirm: true, reset: F.resetNotLoaded),
                result: F.cached(
                    F.decision("not_expected", provenance: F.inherited("purchase", "PUR-4K7M")),
                    freshness: "stale"),
                work: ["kind": "failed", "error": "Synthetic refresh failure", "retryAt": .null]))
        #expect(
            cached.assignment
                == .value("required", ownership: .automatic(receiptID: "RCPT-4K7M", confidence: 0.5)))
        #expect(
            cached.controls == .editable(canSetNone: true, canConfirm: true, reset: .available(.notLoaded)))
        #expect(cached.effectiveValue == "not_expected")
        #expect(cached.isInherited)
        #expect(cached.isUpdating)
        #expect(cached.failure == "Synthetic refresh failure")
        #expect(cached.unsupportedKinds.isEmpty)

        let computed = try envelope(
            F.envelope(result: F.live(F.decision(3, provenance: ["kind": "computed"]))))
        #expect(computed.assignment == nil)
        #expect(computed.controls == .readonly(.computed))
        #expect(computed.state(field: try itemization()).tone == .computed)
        #expect(FieldEnvelope(["result": F.missing]) == nil)
    }

    @Test func unknownVariantsStayVisibleAndDisableActions() throws {
        let field = try owner()
        let future = try envelope(
            F.envelope(
                assignment: ["kind": "future_intent"],
                controls: F.editable(canSetNone: true, canConfirm: true, reset: F.resetNotLoaded),
                result: ["kind": "future_result"], work: ["kind": "future_work"]))
        #expect(future.unsupportedKinds == ["future_intent", "future_result", "future_work"])
        #expect(future.actions(field: field).isEmpty)
        #expect(future.readableValue == nil)
        #expect(future.storedDraft(field: field) == nil)
        #expect(future.state(field: field).tone == .unsupported)

        let controls = try envelope(F.envelope(controls: ["kind": "future_controls"], result: F.missing))
        #expect(controls.controls == .unsupported("future_controls"))
        #expect(controls.actions(field: field).isEmpty)
    }

    /// Missing is not a successful empty result: both read `.null`, the result tells them apart.
    @Test func missingAndEmptyReadNullButStayDistinct() throws {
        let field = try owner()
        let missing = try envelope(F.envelope(result: F.missing, work: ["kind": "pending"]))
        #expect(missing.readableValue == .null)
        #expect(missing.isMissing)
        #expect(missing.isUpdating)
        #expect(missing.emptyLabel(field: field) == "Updating…")
        #expect(missing.visibleEmptyLabel(field: field) == "Updating…")
        let failed = try envelope(
            F.envelope(result: F.missing, work: ["kind": "failed", "error": "Synthetic", "retryAt": .null]))
        #expect(failed.emptyLabel(field: field) == "Unavailable")

        let household = try envelope(
            F.envelope(result: F.live(F.emptyDecision("explicit_none", provenance: F.own))))
        #expect(household.readableValue == .null)
        #expect(!household.isMissing)
        #expect(household.emptyLabel(field: field) == "Household")
        let unknown = try envelope(F.envelope(result: F.live(F.emptyDecision("unset"))))
        #expect(unknown.emptyLabel(field: field) == "Unknown")
        let plain = try envelope(F.envelope(result: F.live(F.emptyDecision("unset"))))
        #expect(plain.visibleEmptyLabel(field: try itemization()) == nil)
    }

    @Test func freshCacheIsNotUpdating() throws {
        let fresh = try envelope(
            F.envelope(result: F.cached(F.decision("required", provenance: F.own), freshness: "fresh")))
        #expect(!fresh.isUpdating)
        #expect(fresh.effectiveValue == "required")
    }

    // MARK: Stored intent

    /// Drafts seed from S and the declared companions, never from the inherited or cached V.
    @Test func storedDraftSeedsFromIntentNeverTheEffectiveValue() throws {
        let field = try owner()
        let result = F.live(F.decision("LPY-4K7M", provenance: F.inherited("product", "PRD-4K7M")))
        let inherit = try envelope(F.envelope(assignment: F.inherit, controls: F.editable(), result: result))
        #expect(inherit.storedDraft(field: field)?.value == .null)
        #expect(inherit.storedDraft(field: field)?.companions == ["ownershipMode": "inherit"])
        let none = try envelope(F.envelope(assignment: F.none, controls: F.editable(), result: result))
        #expect(none.storedDraft(field: field)?.value == .null)
        #expect(none.storedDraft(field: field)?.companions == ["ownershipMode": "explicit"])
        let own = try envelope(
            F.envelope(assignment: F.value("LPY-7M4K"), controls: F.editable(), result: result))
        #expect(own.storedDraft(field: field)?.value == "LPY-7M4K")
        #expect(own.storedDraft(field: field)?.companions == ["ownershipMode": "explicit"])
        let nothing = try envelope(F.envelope(result: result))
        #expect(nothing.storedDraft(field: field)?.value == .null)
        #expect(nothing.storedDraft(field: field)?.companions == [:])
    }

    // MARK: Actions

    /// An inherited owner offers Keep this value (pin it explicitly) and Set to Household from
    /// current controls, including a usable stale value the member explicitly chooses to keep.
    @Test func currentFactsDoNotRewriteCachedProvenance() throws {
        let historicalRecord = try envelope(
            F.envelope(
                assignment: F.value("required", ownership: F.automatic()),
                controls: F.readonly("allocated"),
                result: F.cached(F.decision("not_expected", provenance: F.own), freshness: "stale")))
        #expect(!historicalRecord.isAutomatic)
        #expect(!historicalRecord.isAllocated)
        let confirmed = try envelope(
            F.envelope(
                assignment: F.value("required"),
                controls: F.editable(),
                result: F.cached(
                    F.decision("required", provenance: ["kind": "own", "ownership": F.automatic()]),
                    freshness: "stale")))
        #expect(!confirmed.isAutomatic)
    }

    @Test func ownershipActionsFollowCurrentControls() throws {
        let field = try owner()
        let inherited = try envelope(
            F.envelope(
                assignment: F.inherit, controls: F.editable(canSetNone: true, canConfirm: true),
                result: F.live(F.decision("LPY-4K7M", provenance: F.inherited("product", "PRD-4K7M")))))
        #expect(inherited.state(field: field).systemImage == "list.bullet.indent")
        #expect(inherited.actions(field: field).map(\.label) == ["Keep this value", "Set to Household"])
        #expect(
            inherited.actions(field: field).first?.payload
                == ["ownershipMode": "explicit", "ownerLedgerPartyId": "LPY-4K7M"])

        let stale = try envelope(
            F.envelope(
                assignment: F.inherit, controls: F.editable(canSetNone: true, canConfirm: true),
                result: F.cached(
                    F.decision("LPY-4K7M", provenance: F.inherited("product", "PRD-4K7M")), freshness: "stale"
                )))
        #expect(stale.actions(field: field).map(\.kind) == [.keepValue, .setNone])
        #expect(
            stale.actions(field: field).first?.payload == [
                "ownershipMode": "explicit", "ownerLedgerPartyId": "LPY-4K7M",
            ])

        let explicit = try envelope(
            F.envelope(
                assignment: F.value("LPY-4K7M"),
                controls: F.editable(
                    reset: F.resetReady(
                        F.live(F.decision("LPY-7M4K", provenance: F.inherited("product", "PRD-4K7M"))))),
                result: F.live(F.decision("LPY-4K7M", provenance: F.own))))
        #expect(explicit.actions(field: field).map(\.label) == ["Use inherited"])
        #expect(
            explicit.actions(field: field).first?.payload == [
                "ownershipMode": "inherit", "ownerLedgerPartyId": .null,
            ])
        #expect(explicit.resetPreview?.value == "LPY-7M4K")

        let household = try envelope(
            F.envelope(
                assignment: F.none, controls: F.editable(canSetNone: true, canConfirm: true),
                result: F.live(F.emptyDecision("explicit_none", provenance: F.own))))
        #expect(household.actions(field: field).isEmpty)

        let refused = try envelope(
            F.envelope(
                assignment: F.value("LPY-4K7M"), controls: F.readonly("not_allowed"),
                result: F.live(F.emptyDecision("not_applicable"))))
        #expect(refused.actions(field: field).isEmpty)
    }

    /// Equal values never grant an action; only `reset.kind == available` offers Use inherited.
    @Test func resetIsOfferedOnlyByCurrentControls() throws {
        let field = try itemization()
        let unavailable = try envelope(
            F.envelope(
                assignment: F.value("not_expected"), controls: F.editable(),
                result: F.live(F.decision("not_expected", provenance: F.own))))
        #expect(unavailable.actions(field: field).isEmpty)
        let notLoaded = try envelope(
            F.envelope(
                assignment: F.value("required"), controls: F.editable(reset: F.resetNotLoaded),
                result: F.live(F.decision("required", provenance: F.own))))
        #expect(notLoaded.actions(field: field).map(\.payload) == [["itemizationExpectation": .null]])
        #expect(notLoaded.resetPreview == nil)
    }

    // Regression: an explicit value with nothing to inherit was labelled an override.
    @Test func ownValueReadsSetHereUnlessTheReadyPreviewMatches() throws {
        let field = try itemization()
        func state(reset: JSONValue, ownership: JSONValue = F.record) throws -> FieldValueState {
            try envelope(
                F.envelope(
                    assignment: F.value("required", ownership: ownership), controls: F.editable(reset: reset),
                    result: F.live(
                        F.decision("required", provenance: ["kind": "own", "ownership": ownership])))
            ).state(field: field)
        }
        #expect(try state(reset: ["kind": "unavailable"]).label == "Set here")
        #expect(try state(reset: F.resetNotLoaded).tone == .set)
        #expect(try state(reset: F.resetReady(F.live(F.decision("not_expected")))).tone == .set)
        #expect(try state(reset: F.resetReady(F.live(F.decision("required")))).tone == .redundant)
        #expect(try state(reset: ["kind": "unavailable"], ownership: F.automatic()).tone == .automatic)
    }

    // MARK: Reads

    @Test func ordinaryFieldKeepsItsOwnValueAndEnvelopesReadTheirResult() throws {
        let field = try itemization()
        #expect(
            FieldEnvelopePresentation.readValue(
                in: ["itemizationExpectation": "unknown"], field: field, surface: "detail")
                == "unknown")
        let row = F.row(
            fields: [
                "itemizationExpectation": F.envelope(
                    assignment: F.value("required"), controls: F.readonly("allocated"),
                    result: F.live(F.decision("not_expected", provenance: ["kind": "allocated"])))
            ])
        #expect(FieldEnvelopePresentation.readValue(in: row, field: field, surface: "list") == "not_expected")
        let allocated = try #require(FieldEnvelope.of(row, field: field))
        #expect(allocated.isAllocated)
        #expect(allocated.storedDraft(field: field)?.value == "required")
        #expect(allocated.actions(field: field).isEmpty)
        let missing = F.row(fields: ["itemizationExpectation": F.envelope(result: F.missing)])
        #expect(FieldEnvelopePresentation.readValue(in: missing, field: field, surface: "detail") == .null)
    }

    // A custom label belongs only to its projected target, never an inherited replacement.
    @Test func declaredRunAccountLabelPreservesTargetIdentity() throws {
        let descriptor = try #require(EntityCatalog.all.first { $0.key == .run })
        let field = try #require(descriptor.fields.first { $0.key == "vendorAccountId" })
        let raw: JSONValue = ["vendorAccountId": "VACCT-4K7M", "vendorAccountLabel": "Fixture store login"]
        #expect(
            FieldEnvelopePresentation.referenceName(in: raw, field: field, effectiveID: "VACCT-4K7M")
                == "Fixture store login")
        #expect(
            FieldEnvelopePresentation.referenceName(in: raw, field: field, effectiveID: "VACCT-7M4K") == nil)
    }

    /// A projected name describes the stored target; the inherited source names itself.
    @Test func governedReferenceNamesOnlyTheMatchingTarget() throws {
        let field = try owner()
        let row = F.row(
            ["ownerLedgerPartyName": "Stored member"],
            fields: [
                "ownerLedgerPartyId": F.envelope(
                    assignment: F.inherit, controls: F.editable(),
                    result: F.live(
                        F.decision("LPY-4K7M", provenance: F.inherited("ledgerParty", "LPY-4K7M", "Alex"))))
            ])
        #expect(
            FieldEnvelopePresentation.referenceName(in: row, field: field, effectiveID: "LPY-4K7M") == "Alex")
        #expect(
            FieldEnvelopePresentation.referenceName(in: row, field: field, effectiveID: "LPY-7M4K") == nil)
        let own = F.row(
            ["ownerLedgerPartyName": "Stored member"],
            fields: [
                "ownerLedgerPartyId": F.envelope(
                    assignment: F.value("LPY-7M4K"), controls: F.editable(),
                    result: F.live(F.decision("LPY-7M4K", provenance: F.own)))
            ])
        #expect(
            FieldEnvelopePresentation.referenceName(in: own, field: field, effectiveID: "LPY-7M4K")
                == "Stored member")
        // The declared label names the effective owner only when its record id matches.
        let projected = F.row(
            ["effectiveOwnership": ["effectiveOwner": ["id": "LPY-4K7M", "name": "Alex"]]],
            fields: [
                "ownerLedgerPartyId": F.envelope(
                    assignment: F.inherit, controls: F.editable(),
                    result: F.live(F.decision("LPY-4K7M", provenance: F.inherited("product", "PRD-4K7M"))))
            ])
        #expect(
            FieldEnvelopePresentation.referenceName(in: projected, field: field, effectiveID: "LPY-4K7M")
                == "Alex")
        #expect(
            FieldEnvelopePresentation.referenceName(in: projected, field: field, effectiveID: "LPY-7M4K")
                == nil)
    }

    // An allocation label belongs to its effective target, not a stored override or source Purchase.
    @Test func allocatedReferenceUsesTheMatchingTargetName() throws {
        let source =
            #"{"key":"spendingCategoryId","label":"Spending category","kind":"identifier","nullable":true,"reference":{"entity":"spendingCategory","multiple":false,"scope":[],"filters":[]},"inCreate":true,"requiredOnCreate":false,"inUpdate":true,"showInList":true,"showInDetail":true,"listHidden":false,"mobileInteractive":false}"#
        let field = try JSONDecoder().decode(FieldDescriptor.self, from: Data(source.utf8))
        let raw: JSONValue = [
            "spendingCategoryId": "SPC-4K7M", "spendingCategoryName": "Stored label",
            "spendingCategoryAllocations": [
                ["spendingCategoryId": "SPC-7M4K", "spendingCategoryName": "Supplies", "incomplete": false]
            ],
        ]
        #expect(
            FieldEnvelopePresentation.referenceName(in: raw, field: field, effectiveID: "SPC-7M4K")
                == "Supplies")
        let allocated = F.row(
            [
                "spendingCategoryAllocations": [
                    [
                        "spendingCategoryId": "SPC-7M4K", "spendingCategoryName": "Supplies",
                        "incomplete": false,
                    ],
                    [
                        "spendingCategoryId": "SPC-4M7K", "spendingCategoryName": "Services",
                        "incomplete": false,
                    ],
                    ["spendingCategoryId": .null, "spendingCategoryName": .null, "incomplete": true],
                ]
            ],
            fields: [
                // A retained assignment coexists with the allocated, mixed result.
                "spendingCategoryId": F.envelope(
                    assignment: F.value("SPC-4K7M"), controls: F.readonly("allocated"),
                    result: F.live(F.emptyDecision("mixed", provenance: ["kind": "allocated"])))
            ])
        #expect(
            FieldEnvelopePresentation.allocatedReferenceLabel(in: allocated, field: field)
                == "Supplies, Services, Partly unclassified")
        #expect(FieldEnvelopePresentation.allocatedReferenceLabel(in: raw, field: field) == nil)
        let envelope = try #require(FieldEnvelope.of(allocated, field: field))
        #expect(envelope.emptyLabel(field: field) == "Mixed")
        #expect(envelope.decision?.provenance == .allocated)
    }
}
