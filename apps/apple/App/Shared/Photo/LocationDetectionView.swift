import CubbyKit
import SwiftUI

/// Review of the items detected in one Location photo: a matched Product, or a proposed new one,
/// each approved individually into the Location's inventory.
struct LocationDetectionView: View {
    let model: LocationDetectionModel

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: FieldGuideTokens.Space.lg) {
                switch model.phase {
                case .detecting:
                    Panel {
                        HStack(spacing: FieldGuideTokens.Space.md) {
                            LoadingIndicator(label: "Reading the photo").controlSize(.small)
                            Text("Reading the photo…")
                                .font(.fieldGuideBody)
                                .foregroundStyle(FieldGuideTokens.graphiteSecondary)
                        }
                    }
                case .failed(let message):
                    LoadFailureView(title: "Couldn't read the photo", message: message) {
                        await model.detect()
                    }
                case .ready:
                    if !model.summary.isEmpty {
                        Text(model.summary)
                            .font(.fieldGuideBody)
                            .foregroundStyle(FieldGuideTokens.graphiteSecondary)
                    }
                    if model.rows.isEmpty {
                        Panel { Text("No items found in this photo.").font(.fieldGuideBody) }
                    } else {
                        Eyebrow("Found in \(model.locationTitle)")
                        Panel(padding: 0, spacing: 0) {
                            ForEach(model.rows) { row in
                                if row.id != model.rows.first?.id { PanelDivider() }
                                DetectedItemRow(row: row) { Task { await model.approve(row.id) } }
                            }
                        }
                    }
                }
            }
            .padding(FieldGuideTokens.Space.lg)
            .frame(maxWidth: FieldGuideTokens.readingWidth, alignment: .leading)
            .frame(maxWidth: .infinity)
        }
        .fieldGuideScreen()
        .navigationTitle("Items in photo")
        #if os(iOS)
            .navigationBarTitleDisplayMode(.inline)
        #endif
        .task {
            if model.phase == .detecting, model.rows.isEmpty { await model.detect() }
        }
    }
}

private struct DetectedItemRow: View {
    let row: LocationDetectionModel.Row
    let approve: () -> Void

    private var item: DetectedItem { row.item }
    private var title: String { item.matchedProduct?.name ?? item.name }

    var body: some View {
        VStack(alignment: .leading, spacing: FieldGuideTokens.Space.sm) {
            HStack(alignment: .firstTextBaseline) {
                Text(title)
                    .font(.fieldGuideBody)
                    .foregroundStyle(FieldGuideTokens.graphite)
                Spacer(minLength: FieldGuideTokens.Space.sm)
                action
            }
            Text(detail)
                .font(.fieldGuideLabel)
                .foregroundStyle(FieldGuideTokens.graphiteSecondary)
            if !item.evidence.isEmpty {
                Text(item.evidence)
                    .font(.fieldGuideLabel)
                    .foregroundStyle(FieldGuideTokens.graphiteSecondary)
            }
            if case .failed(let message) = row.state {
                Text(message)
                    .font(.fieldGuideLabel)
                    .foregroundStyle(FieldGuideTokens.destructive)
                    .fixedSize(horizontal: false, vertical: true)
            }
        }
        .padding(FieldGuideTokens.Space.md)
    }

    private var detail: String {
        let match = item.matchedProduct == nil ? "New product" : "Existing product"
        let quantity = "\(item.estimatedQuantity.formatted()) \(item.unit)"
        return [match, quantity, "\(item.confidence.rawValue) confidence"].joined(separator: " · ")
    }

    @ViewBuilder
    private var action: some View {
        switch row.state {
        case .pending, .failed:
            Button(row.state == .pending ? "Add" : "Retry", action: approve)
                .buttonStyle(.bordered)
                .accessibilityLabel("Add \(title) to inventory")
        case .approving:
            LoadingIndicator(label: "Adding").controlSize(.small)
        case .approved(let created):
            Label(created ? "Added, new product" : "Added", systemImage: "checkmark.circle")
                .font(.fieldGuideLabel)
                .foregroundStyle(FieldGuideTokens.interaction)
        }
    }
}

#Preview(traits: .modifier(SignedInPreview())) {
    let model = PreviewFixtures.signedInModel()
    NavigationStack {
        LocationDetectionView(
            model: LocationDetectionModel(
                client: model.client, locationID: LocationCode("LOC-2345"),
                locationTitle: "Sample Shelf", imageID: ImageCode("IMG-2345")))
    }
}
