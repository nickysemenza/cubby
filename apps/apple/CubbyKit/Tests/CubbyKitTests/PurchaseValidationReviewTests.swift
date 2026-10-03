import Foundation
import Testing

@testable import CubbyKit

@MainActor
@Suite("Purchase validation review")
struct PurchaseValidationReviewTests {
    private static let diffJSON = """
        {
          "version": 2,
          "expected": {"orderId": "ORD-1", "currency": "USD", "statedTotal": 12.5, "lines": [], "writeBlockReason": null},
          "actual": {"orderId": "ORD-1", "currency": "USD", "statedTotal": null, "lines": []},
          "corrections": [
            {"id": "c-total", "kind": "purchase_stated_total",
             "target": {"kind": "purchase", "code": "PUR-4K7M"},
             "field": "statedTotal", "before": null, "after": 12.5,
             "fingerprint": "\(String(repeating: "a", count: 64))"},
            {"id": "c-title", "kind": "expense_field",
             "target": {"kind": "expense", "code": "EXP-4K7M"},
             "field": "title", "before": "Oat milk", "after": "Oat milk 1 L",
             "fingerprint": "\(String(repeating: "b", count: 64))"},
            {"id": "c-add", "kind": "expense_add",
             "target": {"kind": "purchase", "code": "PUR-4K7M"},
             "field": "line", "before": null,
             "after": {"title": "Bag fee", "amount": 0.1},
             "fingerprint": "\(String(repeating: "c", count: 64))"}
          ],
          "notes": [
            {"id": "n-1", "target": {"kind": "expense", "code": "EXP-4K7M"},
             "field": "productId", "before": "PRD-4K7M", "after": "PRD-8H2Q",
             "message": "Product differs; review by hand."}
          ],
          "rawEvidenceDrift": false
        }
        """

    private static func diff() throws -> JSONValue {
        try JSONDecoder().decode(JSONValue.self, from: Data(diffJSON.utf8))
    }

    private static func target() throws -> PurchaseValidationTarget {
        try #require(
            PurchaseValidationTarget(purchaseCode: "PUR-4K7M", name: "Example order", diff: diff()))
    }

    @Test("Only a version 2 diff is parsed")
    func versionGate() throws {
        #expect(try Self.target().corrections.count == 3)
        let v1: JSONValue = ["version": 1, "corrections": []]
        #expect(PurchaseValidationTarget(purchaseCode: "PUR-4K7M", name: nil, diff: v1) == nil)
        #expect(PurchaseValidationTarget(purchaseCode: "PUR-4K7M", name: nil, diff: nil) == nil)
    }

    @Test("Values render for review without JSON noise")
    func displayValues() throws {
        let target = try Self.target()
        #expect(target.corrections[0].beforeText == "—")
        #expect(target.corrections[0].afterText == "12.5")
        #expect(target.corrections[1].beforeText == "Oat milk")
        #expect(target.corrections[2].afterText == "Bag fee · 0.1")
        #expect(target.corrections[1].recordText == "EXP-4K7M")
        #expect(target.notes.first?.message == "Product differs; review by hand.")
    }

    @Test("Every correction starts selected, and toggling is per correction")
    func defaultSelection() async throws {
        let service = FakeService(targets: [try Self.target()])
        let session = PurchaseValidationReviewSession(service: service)
        await session.refresh(runID: "RUN-4K7M")

        #expect(session.selectedIDs(for: "PUR-4K7M") == ["c-total", "c-title", "c-add"])
        session.toggle("c-title", purchase: "PUR-4K7M")
        #expect(session.selectedIDs(for: "PUR-4K7M") == ["c-total", "c-add"])
        // A refresh keeps a deliberate deselection.
        await session.refresh(runID: "RUN-4K7M")
        #expect(session.selectedIDs(for: "PUR-4K7M") == ["c-total", "c-add"])
    }

    @Test("Applying sends only the selected ids with a fresh operation id each time")
    func applyUsesFreshOperationIDs() async throws {
        let service = FakeService(targets: [try Self.target()])
        service.result = .applied(
            .init(
                status: .applied, runId: "RUN-4K7M", purchaseId: "PUR-4K7M",
                operationId: "ignored", applied: ["c-total", "c-add"], outcome: .replayed,
                remainingCorrections: 1))
        let session = PurchaseValidationReviewSession(service: service)
        await session.refresh(runID: "RUN-4K7M")
        session.toggle("c-title", purchase: "PUR-4K7M")

        await session.apply(purchase: "PUR-4K7M", runID: "RUN-4K7M")
        await session.apply(purchase: "PUR-4K7M", runID: "RUN-4K7M")

        let inputs = service.inputs
        #expect(inputs.count == 2)
        #expect(inputs[0].correctionIds == ["c-total", "c-add"])
        #expect(inputs[0].runId == "RUN-4K7M")
        #expect(inputs[0].purchaseId == "PUR-4K7M")
        #expect(inputs[0].operationId != inputs[1].operationId)
        #expect(UUID(uuidString: inputs[0].operationId) != nil)
        #expect(session.outcome(for: "PUR-4K7M")?.contains("2") == true)
        #expect(session.staleReasons(for: "PUR-4K7M").isEmpty)
    }

    @Test("A stale refusal keeps the review and shows each raw reason")
    func staleRefusal() async throws {
        let service = FakeService(targets: [try Self.target()])
        service.result = .stale(
            .init(
                status: .stale, runId: "RUN-4K7M", purchaseId: "PUR-4K7M",
                stale: [
                    .init(correctionId: "c-title", reason: "expense EXP-4K7M title changed since review"),
                    .init(correctionId: nil, reason: "purchase edited by another run"),
                ]))
        let session = PurchaseValidationReviewSession(service: service)
        await session.refresh(runID: "RUN-4K7M")

        await session.apply(purchase: "PUR-4K7M", runID: "RUN-4K7M")

        #expect(
            session.staleReasons(for: "PUR-4K7M").map(\.reason) == [
                "expense EXP-4K7M title changed since review", "purchase edited by another run",
            ])
        #expect(session.targets.count == 1)
        #expect(session.error == nil)
        #expect(session.outcome(for: "PUR-4K7M") == nil)
    }

    @Test("Nothing selected sends nothing")
    func emptySelectionIsNotSent() async throws {
        let service = FakeService(targets: [try Self.target()])
        let session = PurchaseValidationReviewSession(service: service)
        await session.refresh(runID: "RUN-4K7M")
        for id in ["c-total", "c-title", "c-add"] { session.toggle(id, purchase: "PUR-4K7M") }

        await session.apply(purchase: "PUR-4K7M", runID: "RUN-4K7M")

        #expect(service.inputs.isEmpty)
    }

    @Test("A transport failure is reported raw and re-enables apply")
    func transportFailure() async throws {
        struct Boom: LocalizedError { var errorDescription: String? { "connection reset" } }
        let service = FakeService(targets: [try Self.target()])
        service.failure = Boom()
        let session = PurchaseValidationReviewSession(service: service)
        await session.refresh(runID: "RUN-4K7M")

        await session.apply(purchase: "PUR-4K7M", runID: "RUN-4K7M")

        #expect(session.error == "connection reset")
        #expect(!session.busy)
    }
}

@MainActor
private final class FakeService: PurchaseValidationServing {
    let targets: [PurchaseValidationTarget]
    var result: ApplyValidationCorrectionsOut?
    var failure: (any Error)?
    private(set) var inputs: [ApplyValidationCorrectionsInput] = []

    init(targets: [PurchaseValidationTarget]) { self.targets = targets }

    func validationTargets(runID: String) async throws -> [PurchaseValidationTarget] { targets }

    func applyValidationCorrections(_ input: ApplyValidationCorrectionsInput) async throws
        -> ApplyValidationCorrectionsOut
    {
        inputs.append(input)
        if let failure { throw failure }
        return try #require(result)
    }
}
