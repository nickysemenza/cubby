import CubbyKit
import SwiftUI

struct LocationPickerSheet: View {
    @Bindable var capture: CaptureModel
    @Environment(\.dismiss) private var dismiss
    @State private var query = ""

    private var filtered: [CaptureModel.LocationOption] {
        guard !query.isEmpty else { return capture.locations }
        return capture.locations.filter {
            $0.name.localizedCaseInsensitiveContains(query)
                || $0.id.rawValue.localizedCaseInsensitiveContains(query)
        }
    }

    var body: some View {
        NavigationStack {
            List(filtered) { option in
                Button {
                    capture.select(option)
                    dismiss()
                } label: {
                    HStack(spacing: PorcelainTokens.Space.md) {
                        DomainMark(.location, style: .symbol, size: 15)
                            .frame(width: 20)
                        VStack(alignment: .leading, spacing: 1) {
                            Text(option.name)
                                .font(.porcelainBody)
                                .foregroundStyle(PorcelainTokens.graphite)
                                .lineLimit(1)
                            if let path = option.path, !path.isEmpty {
                                Text(path)
                                    .font(.porcelainLabel)
                                    .foregroundStyle(PorcelainTokens.graphiteSecondary)
                                    .lineLimit(1)
                            }
                        }
                        Spacer(minLength: PorcelainTokens.Space.sm)
                        Text(option.id.rawValue)
                            .font(.porcelainCode)
                            .foregroundStyle(PorcelainTokens.graphiteSecondary)
                        if option.id == capture.session.location {
                            Image(systemName: "checkmark")
                                .font(.caption.weight(.semibold))
                                .foregroundStyle(PorcelainTokens.cobalt)
                        }
                    }
                    .frame(minHeight: PorcelainTokens.touchTarget)
                    .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .porcelainListRow()
            }
            .listStyle(.plain)
            .porcelainScreen()
            .overlay {
                if capture.loadingLocations && capture.locations.isEmpty { ProgressView() }
            }
            .searchable(text: $query, prompt: "Filter locations")
            .navigationTitle("Sweep location")
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() } }
            }
            .task { if capture.locations.isEmpty { await capture.loadLocations() } }
            .refreshControl { await capture.loadLocations() }
        }
        #if os(macOS)
            .frame(minWidth: 360, minHeight: 420)
        #endif
    }
}

#Preview {
    LocationPickerSheet(capture: CaptureModel(client: PreviewFixtures.signedInModel().client))
}
