import Foundation
import Testing

@testable import CubbyKit

@Suite("Direct native codecs")
struct NativeCodecTests {
    @Test(arguments: [false, true])
    func imageURLsUseCanonicalRepresentationSnapshots(cached: Bool) throws {
        let missing: JSONValue = [
            "current": ["assignment": .null, "controls": ["kind": "readonly", "reason": "computed"]],
            "result": ["kind": "missing"], "work": ["kind": "idle"],
        ]
        var representation = try #require(missing.objectValue)
        var result: [String: JSONValue] = [
            "kind": .string(cached ? "cached" : "live"),
            "decision": [
                "outcome": [
                    "kind": "value",
                    "value": [
                        "original": "https://example.com/original.png",
                        "preferred": "https://example.com/transparent.png",
                        "transparent": "https://example.com/transparent.png", "preferredKind": "transparent",
                    ],
                ], "provenance": ["kind": "computed"],
            ],
        ]
        if cached {
            result["computedAt"] = "2026-10-01T00:00:00Z"
            result["freshness"] = "stale"
        }
        representation["result"] = .object(result)
        var fields = Dictionary(
            uniqueKeysWithValues: [
                "representations", "url", "capturedByName", "sightings", "provenanceEvidenceLabel",
                "dataQuality", "displayImages",
            ].map { ($0, missing) })
        fields["representations"] = .object(representation)
        var row = Dictionary(
            uniqueKeysWithValues: [
                "width", "height", "detectedContentType", "sha256", "renderStatus", "storageStatus",
                "sourcePageUrl", "sourceAssetUrl", "sourceName", "verifiedAt", "capturedAt",
                "capturedAtOffsetMinutes", "captureLocation", "capturePlaceName", "captureDeviceLabel",
                "capturedByPartyId", "provenanceEvidence", "sourceEvidence",
            ].map { ($0, JSONValue.null) })
        row.merge(
            [
                "id": "IMG-2345", "key": "synthetic-image", "filename": "synthetic.png", "size": 1,
                "contentType": "image/png", "status": "UPLOADED", "source": "upload",
                "useOriginal": false, "captureAttribution": "none", "associations": [], "attachments": [],
                "createdAt": "2026-10-01T00:00:00Z",
                "updatedAt": "2026-10-01T00:00:00Z",
                "fields": .object(fields),
            ], uniquingKeysWith: { _, next in next })
        let image: ImageWithEntity = try JSONValue.object(row).decoded()
        #expect(image.imageURL?.absoluteString == "https://example.com/transparent.png")
        #expect(image.originalImageURL?.absoluteString == "https://example.com/original.png")
        #expect(image.transparentImageURL?.absoluteString == "https://example.com/transparent.png")
    }

    @Test func recursiveLocationParentsRoundTripWithValueSemantics() throws {
        let missing: JSONValue = [
            "current": ["assignment": .null, "controls": ["kind": "readonly", "reason": "computed"]],
            "result": ["kind": "missing"], "work": ["kind": "idle"],
        ]
        let fields = JSONValue.object(
            Dictionary(
                uniqueKeysWithValues: [
                    "type", "product", "aiDescription", "images", "valuationLabel", "valuation",
                    "dataQuality", "dataGaps", "displayImages",
                ].map { ($0, missing) }))
        func node(_ id: String, _ name: String, parent: JSONValue? = nil) -> [String: JSONValue] {
            var row: [String: JSONValue] = [
                "id": .string(id), "name": .string(name), "aliases": [], "notes": .null,
                "lastBulkInventory": .null, "createdAt": "2026-10-01T00:00:00.000Z",
                "updatedAt": "2026-10-01T00:00:00.000Z", "fields": fields, "children": [],
            ]
            if let parent { row["parent"] = parent }
            return row
        }
        let ancestor = JSONValue.object(node("LOC-2345", "Synthetic ancestor"))
        let parent = JSONValue.object(node("LOC-3456", "Synthetic parent", parent: ancestor))
        var root = node("LOC-4567", "Synthetic location", parent: parent)
        root["attachments"] = []
        root["children"] = [.object(node("LOC-5678", "Synthetic child"))]
        let original: InfLocation = try JSONValue.object(root).decoded()
        #expect(original.parent?.parent?.name == "Synthetic ancestor")
        #expect(original.children?.first?.name == "Synthetic child")
        var changed = original
        changed.parent?.parent?.name = "Synthetic changed ancestor"
        #expect(original.parent?.parent?.name == "Synthetic ancestor")
        #expect(changed.parent?.parent?.name == "Synthetic changed ancestor")
        #expect(Set([original, changed]).count == 2)
        let roundTrip: InfLocation = try JSONValue(encoding: changed).decoded()
        #expect(roundTrip == changed)
    }

    @Test func retainedStatementSweepPreservesCollectionAndIntersectingScope() throws {
        let wire: JSONValue = [
            "families": [
                [
                    "family": "statement_transaction", "importId": "TIM-2345",
                    "accountIds": ["FAC-2345"], "since": "2026-05-01",
                ]
            ]
        ]
        let input: SweepStartInput = try wire.decoded()
        #expect(try JSONValue(encoding: input) == wire)
    }

    @Test func readySpendingAllowsUnknownPurchaserRoundTrip() throws {
        let wire: JSONValue = [
            "request": ["advice": .null, "rejectedPurchaseIds": []],
            "snapshot": "synthetic-spending", "candidates": [],
            "status": "ready", "effect": "create_aggregate",
            "purchaserId": .null, "purchaserSnapshot": "synthetic-purchaser",
            "vendorId": .null, "vendorName": "Synthetic Orchard",
            "spendingCategoryId": "SPC-2345", "purchaseId": .null,
        ]
        let ready: FinancialSpendingPlanReady = try wire.decoded()
        #expect(ready.purchaserId == nil)
        #expect(try JSONValue(encoding: ready)["purchaserId"] == .null)
        let plan: FinancialSpendingPlan = try wire.decoded()
        #expect(try JSONValue(encoding: plan) == wire)
    }

    @Test func propagatedImageTextRetainsReceiptAuthorityWithoutModelClaims() throws {
        let owner: JSONValue = [
            "kind": "correction",
            "effectId": "00000000-0000-4000-8000-000000000001",
            "sourceFeedbackId": "00000000-0000-4000-8000-000000000002",
            "sourceApplicationFeedbackId": "00000000-0000-4000-8000-000000000003",
            "sourceActorUserId": "synthetic-member",
            "targetAssessmentId": "00000000-0000-4000-8000-000000000004",
            "originalApplicationFeedbackId": .null,
            "priorCorrectionApplicationFeedbackId": .null,
        ]
        let raw: JSONValue = [
            "description": "Synthetic corrected image",
            "authority": "correction",
            "correction": owner,
            "analysis": .null,
            "claims": [],
            "missingReason": .null,
        ]
        let selected: SelectedImageDescriptionEvidence = try raw.decoded()
        #expect(selected.authority == .correction)
        #expect(selected.analysis == nil)
        #expect(selected.claims.isEmpty)
        #expect(try JSONValue(encoding: selected)["correction"] == owner)
        let confirmation: ImageDescriptionConfirmationOwner = try owner.decoded()
        guard case .correction = confirmation else {
            Issue.record("Automatic image correction was interpreted as direct member confirmation")
            return
        }
        #expect(try JSONValue(encoding: confirmation) == owner)
    }

    @Test func optionalNullableRoundTripPreservesAllThreeStates() throws {
        let base: JSONValue = ["operationId": "synthetic-operation", "verdict": "accept"]
        let absent: AssessmentReviewInput = try base.decoded()
        #expect(absent.reason == .absent)
        #expect(try JSONValue(encoding: absent)["reason"] == nil)

        var null = try #require(base.objectValue)
        null["reason"] = .null
        let cleared: AssessmentReviewInput = try JSONValue.object(null).decoded()
        #expect(cleared.reason == .value(nil))
        #expect(try JSONValue(encoding: cleared)["reason"] == .null)

        null["reason"] = "Synthetic explanation"
        let value: AssessmentReviewInput = try JSONValue.object(null).decoded()
        #expect(value.reason == .value("Synthetic explanation"))
        #expect(try JSONValue(encoding: value)["reason"] == "Synthetic explanation")
    }

    @Test func nullableNamedAliasPreservesOmittedNullAndValue() throws {
        let base: JSONValue = [
            "assetKey": "synthetic-asset", "sourceType": "userLibrary",
            "observedAt": "2026-01-01T00:00:00.000Z",
        ]
        let absent: ImageSightingReportFields = try base.decoded()
        #expect(absent.cloudIdentifier == .absent)
        #expect(try JSONValue(encoding: absent)["cloudIdentifier"] == nil)
        var fields = try #require(base.objectValue)
        fields["cloudIdentifier"] = .null
        let cleared: ImageSightingReportFields = try JSONValue.object(fields).decoded()
        #expect(cleared.cloudIdentifier == .value(nil))
        #expect(try JSONValue(encoding: cleared)["cloudIdentifier"] == .null)
        fields["cloudIdentifier"] = "synthetic-cloud"
        let present: ImageSightingReportFields = try JSONValue.object(fields).decoded()
        #expect(present.cloudIdentifier == .value("synthetic-cloud"))
        #expect(try JSONValue(encoding: present)["cloudIdentifier"] == "synthetic-cloud")
    }

    @Test func optionalNonNullableRejectsExplicitNull() {
        let input: JSONValue = ["operationId": "synthetic-operation", "verdict": "accept", "intent": .null]
        #expect(throws: DecodingError.self) {
            let _: AssessmentReviewInput = try input.decoded()
        }
    }

    @Test func requiredNullableKeyMustBePresent() throws {
        let present: JSONValue = ["command": .null, "commands": [], "remotePaused": false]
        let output: PullCompanionImageProcessingOutput = try present.decoded()
        #expect(output.command == nil)
        #expect(try JSONValue(encoding: output)["command"] == .null)
        #expect(throws: DecodingError.self) {
            let _: PullCompanionImageProcessingOutput = try JSONValue.object(["remotePaused": false])
                .decoded()
        }
    }

    @Test func futureCommandRetainsRawJSONAndCannotExecute() throws {
        let raw: JSONValue = ["kind": "future-command", "payload": ["revision": 2, "optional": .null]]
        let command: ImageProcessingCommand = try raw.decoded()
        guard case .unrecognized(let retained) = command else {
            Issue.record("Future command was interpreted as an existing command")
            return
        }
        #expect(retained == raw)
        #expect(try JSONValue(encoding: command) == raw)
        #expect(throws: UnsupportedNativeResponse.self) {
            _ = try CompanionImageCommandMetadata(command)
        }
    }

    @Test func futureCommandRevisionIsRetainedAndCannotExecute() throws {
        let raw: JSONValue = [
            "kind": "describe_image", "jobId": "00000000-0000-4000-8000-000000000001",
            "attemptId": "00000000-0000-4000-8000-000000000002", "deadline": "2099-01-01T00:00:00.000Z",
            "source": [
                "url": "https://example.test/source.jpg",
                "sha256": .string(String(repeating: "a", count: 64)), "contentType": "image/jpeg",
            ],
            "promptRevision": 99, "resultSchemaRevision": 1,
        ]
        let command: ImageProcessingCommand = try raw.decoded()
        #expect(try JSONValue(encoding: command)["promptRevision"] == 99)
        #expect(throws: UnsupportedNativeResponse.self) { _ = try CompanionImageCommandMetadata(command) }
    }

    @Test func malformedKnownCommandIsADecodingFailure() {
        #expect(throws: DecodingError.self) {
            let _: ImageProcessingCommand = try JSONValue.object(["kind": "subject_lift"]).decoded()
        }
    }

    @Test func malformedKnownBooleanTaggedVariantIsADecodingFailure() {
        #expect(throws: DecodingError.self) {
            let _: AssessmentReviewBatchOut = try JSONValue.array([
                ["ok": false, "error": "Synthetic failure"]
            ]).decoded()
        }
    }

    @Test func generatedMutationPayloadsRequireEffectsAndIgnoreAdditions() throws {
        let data = Data(#"{"items":[],"sideEffects":{},"future":true}"#.utf8)
        let task = try JSONDecoder.cubby().decode(TaskBulkReorderOutput.self, from: data)
        let inventory = try JSONDecoder.cubby().decode(
            InventoryReconcileSessionOutput.self, from: data)
        #expect(task.items.isEmpty)
        #expect(inventory.items.isEmpty)
        #expect(throws: DecodingError.self) {
            _ = try JSONDecoder.cubby().decode(TaskBulkReorderOutput.self, from: Data(#"{"items":[]}"#.utf8))
        }
    }

    @Test func financialUnionRetainsFutureTagAndRejectsMalformedKnownTag() throws {
        let future: JSONValue = ["status": "future", "reason": "Synthetic reason", "extra": 1]
        let output: FinancialConvergenceResult = try future.decoded()
        guard case .unrecognized(let retained) = output else {
            Issue.record("Future financial result was interpreted as a known result")
            return
        }
        #expect(retained == future)
        #expect(try JSONValue(encoding: output) == future)
        #expect(throws: DecodingError.self) {
            let _: FinancialConvergenceResult = try JSONValue.object(["status": "applied"]).decoded()
        }
    }

    @Test func failedImageOutcomeDoesNotBecomeSkipped() throws {
        let raw: JSONValue = [
            "kind": "subject_lift", "status": "failed", "retryable": true, "reason": "Synthetic failure",
        ]
        let outcome: ImageProcessingResultOutcome = try raw.decoded()
        guard case .failed(let failure) = outcome else {
            Issue.record("Failed image outcome was interpreted as another outcome")
            return
        }
        #expect(failure.retryable)
        #expect(try JSONValue(encoding: outcome) == raw)
    }

    @Test func orderDateUnionUsesTimestampStrategies() throws {
        let raw: JSONValue = "2026-01-01T00:00:00.000Z"
        let value: ExtractedOrderDate = try raw.decoded()
        guard case .value2(let timestamp) = try #require(value) else {
            Issue.record("Timestamp was interpreted as a calendar day")
            return
        }
        let encoded = try JSONValue(encoding: ExtractedOrderDate.some(.value2(timestamp)))
        #expect(encoded == raw)
        let day: ExtractedOrderDate = try JSONValue.string("2026-01-01").decoded()
        guard case .value1 = try #require(day) else {
            Issue.record("Calendar day was interpreted as a timestamp")
            return
        }
    }

    @Test func numericLiteralArraysRetainKnownAndFutureValues() throws {
        let values: [EntityGraphExploreInputDepth] = try JSONValue.array([1, 2, 4, 99]).decoded()
        #expect(values[0] == ._1)
        #expect(values[1] == ._2)
        #expect(values[2] == ._4)
        #expect(values[3] == .unrecognized(99))
        #expect(try JSONValue(encoding: values) == .array([1, 2, 4, 99]))
    }

    @Test func futureEnumRetainsItsRawValue() throws {
        let value: DataCheck = try JSONValue.string("future-check").decoded()
        #expect(value.rawValue == "future-check")
        #expect(try JSONValue(encoding: value) == "future-check")
    }

    @Test func timestampsAcceptBothWireSpellingsAndEncodeMilliseconds() throws {
        let transcoder = LenientISO8601DateTranscoder()
        let fractional = try transcoder.decode("2026-01-01T00:00:00.000Z")
        #expect(try transcoder.decode("2026-01-01T00:00:00Z") == fractional)
        #expect(try transcoder.encode(fractional) == "2026-01-01T00:00:00.000Z")
        for milliseconds in ["001", "010", "123", "280", "283", "999"] {
            let revision = "2026-10-24T05:34:23.\(milliseconds)Z"
            let decoded = try transcoder.decode(revision)
            #expect(try transcoder.encode(decoded) == revision)
            #expect(try JSONValue(encoding: decoded) == .string(revision))
        }
    }
}
