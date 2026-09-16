import CubbyKit
import SwiftUI

/// The planting detail's `planting-guide` slot: the local planting windows for the row's
/// `gardenGuideKey`, from the shared `garden.guides` document. A planting whose crop has no
/// guide key, or a guide document that failed to load, renders one quiet line.
struct GardenGuideSlot: View {
    let row: EntityRow
    @Environment(AppModel.self) private var appModel
    @State private var garden: GardenModel?

    private var guideKey: String? { row.raw["gardenGuideKey"]?.stringValue }

    var body: some View {
        Group {
            if let guideKey, let garden {
                if let guide = garden.guide(forKey: guideKey) {
                    DisclosureGroup("Show guide") {
                        ForEach(guide.windows) { window in
                            GardenGuideWindowDetail(
                                window: window, source: garden.guideSource(id: window.sourceId))
                        }
                    }
                } else if garden.guideError != nil {
                    Text("Planting guides are temporarily unavailable.").foregroundStyle(.secondary)
                } else {
                    Text("No local guide for this crop.").foregroundStyle(.secondary)
                }
            } else if guideKey == nil {
                Text("This crop has no planting guide.").foregroundStyle(.secondary)
            } else {
                LoadingIndicator(label: "Loading guide")
            }
        }
        .task {
            let model = GardenModel.SharedStore.model(for: appModel.client)
            garden = model
            await model.loadIfNeeded()
        }
    }
}

struct GardenGuideWindowDetail: View {
    let window: GardenGuideWindow
    let source: GardenGuideSource?

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            Text(summary).font(.porcelainBody.weight(.semibold))
            if let note = window.notes { Text(note).font(.porcelainLabel) }
            if let source {
                if let url = URL(string: source.url) {
                    Link(GardenStrings.viewSource, destination: url).font(.porcelainLabel)
                }
                if let published = source.publishedOrRevised {
                    Text("\(GardenStrings.publishedOrRevised): \(published)").font(.porcelainLabel)
                        .foregroundStyle(PorcelainTokens.graphiteSecondary)
                }
                Text("\(GardenStrings.reviewed): \(source.reviewedAt)").font(.porcelainLabel)
                    .foregroundStyle(PorcelainTokens.graphiteSecondary)
                if !source.basedOn.isEmpty {
                    Text("\(GardenStrings.basedOn): \(source.basedOn.joined(separator: "; "))")
                        .font(.porcelainLabel).foregroundStyle(PorcelainTokens.graphiteSecondary)
                }
                Text(GardenStrings.sourcesMayDiffer).font(.porcelainLabel)
                    .foregroundStyle(PorcelainTokens.graphiteSecondary)
            }
        }
        .padding(.vertical, 2)
    }

    private var summary: String {
        let monthNames = window.months.compactMap { month -> String? in
            let symbols = Calendar.current.monthSymbols
            return symbols.indices.contains(month - 1) ? symbols[month - 1] : nil
        }
        let microclimate = window.microclimate == .unspecified ? nil : window.microclimate.rawValue
        let scope = [microclimate, window.monthPart?.rawValue].compactMap { $0 }.joined(separator: " · ")
        return [window.method.rawValue, monthNames.joined(separator: ", "), scope].filter { !$0.isEmpty }
            .joined(separator: " · ")
    }
}

#Preview("Guide") {
    Form {
        Section("Local planting guide") {
            GardenGuideSlot(row: GardenPreviewFixtures.growingPlantingRow)
        }
    }
    .environment(PreviewFixtures.signedInModel())
}
