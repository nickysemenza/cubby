import Foundation
import Testing

@testable import CubbyKit

@Suite("Direct native codecs")
struct NativeCodecTests {
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
        let present: JSONValue = ["command": .null, "remotePaused": false]
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
        let task = try JSONDecoder.cubby().decode(TaskBulkMutationOut.self, from: data)
        let inventory = try JSONDecoder.cubby().decode(
            InventoryWithLocationAndProductListAndSideEffectsOut.self, from: data)
        #expect(task.items.isEmpty)
        #expect(inventory.items.isEmpty)
        #expect(throws: DecodingError.self) {
            _ = try JSONDecoder.cubby().decode(TaskBulkMutationOut.self, from: Data(#"{"items":[]}"#.utf8))
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
        #expect(DataExceptionDraft(entityID: "synthetic-record", check: value.rawValue).clearInput() == nil)
    }

    @Test func timestampsAcceptBothWireSpellingsAndEncodeMilliseconds() throws {
        let transcoder = LenientISO8601DateTranscoder()
        let fractional = try transcoder.decode("2026-01-01T00:00:00.000Z")
        #expect(try transcoder.decode("2026-01-01T00:00:00Z") == fractional)
        #expect(try transcoder.encode(fractional) == "2026-01-01T00:00:00.000Z")
    }
}
