import CubbyKit
import SwiftUI

struct LocationPickerSheet: View {
    @Bindable var capture: CaptureModel
    @Environment(\.dismiss) private var dismiss
    @State private var query = ""

    private var filtered: [CaptureModel.LocationOption] {
        guard !query.isEmpty else { return capture.locations }
        return capture.locations.filter { $0.name.localizedCaseInsensitiveContains(query) || $0.id.rawValue.localizedCaseInsensitiveContains(query) }
    }

    var body: some View {
        NavigationStack {
            List(filtered) { option in
                Button {
                    capture.select(option)
                    dismiss()
                } label: {
                    VStack(alignment: .leading) {
                        Text(option.name)
                        Text(option.id.rawValue).font(.footnote).foregroundStyle(PorcelainTokens.graphiteSecondary)
                    }
                }
                .buttonStyle(.plain)
            }
            .overlay {
                if capture.loadingLocations && capture.locations.isEmpty { ProgressView() }
            }
            .searchable(text: $query, prompt: "Filter locations")
            .navigationTitle("Sweep location")
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() } }
            }
            .task { if capture.locations.isEmpty { await capture.loadLocations() } }
        }
        #if os(macOS)
        .frame(minWidth: 360, minHeight: 420)
        #endif
    }
}
