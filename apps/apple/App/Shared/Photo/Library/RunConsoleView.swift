import CubbyKit
import SwiftUI

/// A Run's server-composed console: the declared `run` detail slots (progress, approvals,
/// findings, targets, evidence, transcript, log, usage, changes) drawn by the same
/// `ReportDetailSlot` the generic detail screen uses. A Run has no generic `get` read (the review
/// screen loads it through `run.workSnapshot`), so this builds the slot host's row from the
/// snapshot's purpose and status — the only fields the slot registry reads — instead of going
/// through `EntityDetailView`.
struct RunConsoleView: View {
    let run: RunWorkSnapshotOutput

    @State private var reportBatches = ReportBatchStore()

    private var row: EntityRow {
        EntityRow(
            id: run.runId, title: "Run", subtitle: nil, imageURL: nil,
            raw: .object([
                "purpose": .string(run.purpose.rawValue),
                "status": .string(run.status.rawValue),
            ]))
    }

    private var sections: [DetailSection] {
        EntityCatalog[.run].presentation.detailSections.filter {
            if case .slot = $0.kind { return true }
            return false
        }
    }

    var body: some View {
        let row = row
        List {
            ForEach(sections) { section in
                if let view = DetailSlotRegistry.view(slot: section.id, row: row) {
                    Section(section.title ?? "") { view }
                }
            }
        }
        .environment(\.reportBatchStore, reportBatches)
        .navigationTitle("Run console")
        #if os(iOS)
            .navigationBarTitleDisplayMode(.inline)
        #endif
    }
}
