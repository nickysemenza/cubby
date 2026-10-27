import CubbyKit
import Foundation
import Testing

@testable import Cubby

/// The classification lives in `packages/schemas/src/native-coverage.ts`. The generated
/// per-status id enums hold the view registries to it at compile time; these tests cover what
/// the compiler cannot.
@Suite("Native coverage view paths")
@MainActor
struct NativeCoverageViewPathTests {
    #if os(macOS)
        @Test func cachedRunListOpensAsTableAndPreservesItsSession() {
            let client = CubbyClient(
                baseURL: URL(string: "https://example.invalid")!,
                credentials: CredentialProvider(
                    host: "example.invalid", store: InMemorySessionTokenStore()))
            let session = NativeBrowserSession(client: client)
            let runs = session.list(for: .run)
            #expect(runs.view == .table)
            #expect(session.list(for: .run) === runs)
        }
    #endif

    @Test func nativeCoverageDecodesAndHandsUnknownSlotsOffToTheRecord() {
        #expect(NativePresentationCoverage.detailSlot("purchase.receiving") == .implemented)
        let unknown = NativePresentationCoverage.detailSlot("not.a-slot").handoff
        #expect(unknown?.section == nil && unknown?.reason == "Unknown native detail slot.")
    }

    /// Reconciliation and its verbs are web's; receiving what an expense bought stays native.
    @Test func financeReconciliationHandsOffAndReceivingStaysNative() {
        #expect(NativePresentationCoverage.sectionAction(.receiveExpense) == .implemented)
        #expect(
            NativePresentationCoverage.sectionAction(.matchStatement).handoff?.section
                == "financial-settlement")
        let purchase = EntityRow(
            id: "PUR-4K7M", title: "Synthetic order", subtitle: nil, imageURL: nil, raw: ["id": "PUR-4K7M"])
        #expect(
            NativePresentationCoverage.recordHandoffs(EntityCatalog[.purchase], row: purchase).map(\.label)
                == ["Review reconciliation on web"])
    }

    @Test func receivingUsesTheCanonicalExpenseProductDecision() {
        func expense(_ result: JSONValue) -> EntityRow {
            EntityRow(
                id: "EXP-4K7M", title: "Synthetic purchase line", subtitle: nil, imageURL: nil,
                raw: [
                    "id": "EXP-4K7M", "productId": "PRD-OLD2",
                    "fields": ["productId": ["result": result]],
                ])
        }
        let linked = expense([
            "kind": "live",
            "decision": ["outcome": ["kind": "value", "value": "PRD-4K7M"]],
        ])
        let empty = expense([
            "kind": "live", "decision": ["outcome": ["kind": "empty", "reason": "unset"]],
        ])
        let missing = expense(["kind": "missing"])

        #expect(DetailSlotRegistry.supplement(for: .expense, row: linked) != nil)
        #expect(DetailSlotRegistry.supplement(for: .expense, row: empty) == nil)
        #expect(DetailSlotRegistry.supplement(for: .expense, row: missing) == nil)
    }

    /// A handoff slot draws its row only where web's slot predicate would draw the slot.
    @Test func importAgentHandoffFollowsTheRunsPurposeAndLiveness() throws {
        func run(_ purpose: String, _ status: String) -> EntityRow {
            EntityRow(
                id: "RUN-4K7M", title: "Import", subtitle: nil, imageURL: nil,
                raw: ["id": "RUN-4K7M", "purpose": .string(purpose), "status": .string(status)])
        }
        let importPurpose = try #require(SharedConstants.importReportRunPurposes.first)
        let live = try #require(SharedConstants.activeRunStatuses.first)
        let liveImport = run(importPurpose, live)
        let stoppedImport = run(importPurpose, "completed")

        #expect(
            DetailSlotRegistry.handoff(slot: "run.import-agent-live", row: liveImport)?.section
                == "import-agent-live")
        #expect(DetailSlotRegistry.handoff(slot: "run.import-agent-stopped", row: liveImport) == nil)
        #expect(
            DetailSlotRegistry.handoff(slot: "run.import-agent-stopped", row: stoppedImport)?.section
                == "import-agent-stopped")
        let photoRun = run("photo_inventory", live)
        #expect(DetailSlotRegistry.handoff(slot: "run.import-agent-live", row: photoRun) == nil)
        // Photo-group review is web's, and only a photo Run takes it.
        #expect(
            DetailSlotRegistry.handoff(slot: "run.photo-batch", row: photoRun)?.label
                == "Review photo groups on web")
        #expect(DetailSlotRegistry.handoff(slot: "run.photo-batch", row: stoppedImport) == nil)
        #expect(
            NativePresentationCoverage.recordHandoffs(EntityCatalog[.run], row: stoppedImport).map(\.label)
                == ["Open agent history on web"])
    }
}
