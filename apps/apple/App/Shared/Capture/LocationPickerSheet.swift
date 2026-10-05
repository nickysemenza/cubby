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
                    HStack(spacing: FieldGuideTokens.Space.md) {
                        DomainMark(.location, style: .symbol, size: 15)
                            .frame(width: 20)
                        VStack(alignment: .leading, spacing: 1) {
                            Text(option.name)
                                .font(.fieldGuideBody)
                                .foregroundStyle(FieldGuideTokens.graphite)
                                .lineLimit(1)
                            if let path = option.path, !path.isEmpty {
                                Text(path)
                                    .font(.fieldGuideLabel)
                                    .foregroundStyle(FieldGuideTokens.graphiteSecondary)
                                    .lineLimit(1)
                            }
                        }
                        Spacer(minLength: FieldGuideTokens.Space.sm)
                        Text(option.id.rawValue)
                            .font(.fieldGuideCode)
                            .foregroundStyle(FieldGuideTokens.graphiteSecondary)
                        if option.id == capture.session.location {
                            Image(systemName: "checkmark")
                                .font(.caption.weight(.semibold))
                                .foregroundStyle(FieldGuideTokens.interaction)
                        }
                    }
                    .frame(minHeight: FieldGuideTokens.touchTarget)
                    .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .accessibilityIdentifier("capture.location.\(option.id.rawValue)")
            }
            .listStyle(.plain)
            .fieldGuideScreen()
            .overlay {
                if capture.loadingLocations && capture.locations.isEmpty {
                    LoadingIndicator(label: "Loading locations")
                }
            }
            .searchable(text: $query, prompt: "Filter locations")
            .navigationTitle("Sweep location")
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() } }
            }
            .task { if capture.locations.isEmpty { await capture.loadLocations() } }
            .refreshControl { await capture.loadLocations() }
        }
        .nativeSheet(.picker)
    }
}

#Preview {
    @Previewable @State var appModel = PreviewFixtures.signedInModel()
    LocationPickerSheet(capture: CaptureModel(client: appModel.client))
}
