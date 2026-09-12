import CubbyKit
import SwiftUI

/// One entity's detail screen. Owns a `GenericEntityDetailModel` created per host, mirroring
/// `EntityListView`/`CaptureView`.
struct EntityDetailView: View {
    let key: EntityKey
    let id: String

    @Environment(AppModel.self) private var appModel
    @State private var model: GenericEntityDetailModel?

    private var descriptor: EntityDescriptor { EntityCatalog[key] }

    var body: some View {
        content
            .navigationTitle(model?.row?.title ?? descriptor.singular)
            .task(id: appModel.host) { await setup() }
    }

    @ViewBuilder
    private var content: some View {
        if let model {
            switch model.phase {
            case .idle, .loading:
                ProgressView()
            case .unavailable(let message):
                ContentUnavailableView(message, systemImage: entitySymbol(for: key))
            case .failed(let message):
                ContentUnavailableView(
                    "Couldn't load \(descriptor.singular)",
                    systemImage: "exclamationmark.triangle",
                    description: Text(message)
                )
            case .loaded:
                if let row = model.row {
                    EntityDetailContent(descriptor: descriptor, row: row)
                } else {
                    ContentUnavailableView("Not found", systemImage: "questionmark.folder")
                }
            }
        } else {
            ProgressView()
        }
    }

    private func setup() async {
        let model = await GenericEntityDetailModel(descriptor: descriptor, client: appModel.client.raw)
        self.model = model
        await model.load(id: id)
    }
}

/// Plain-data detail rendering, shared by the real screen and `#Preview`s so neither needs a
/// network round trip to render.
struct EntityDetailContent: View {
    let descriptor: EntityDescriptor
    let row: EntityRow

    @State private var showingRaw = false

    var body: some View {
        Form {
            Section {
                VStack(spacing: PorcelainTokens.spacing) {
                    if let url = row.imageURL {
                        AsyncImage(url: url) { phase in
                            if case .success(let image) = phase {
                                image.resizable().scaledToFit()
                            } else {
                                cover
                            }
                        }
                        .frame(maxHeight: 240)
                        .clipShape(RoundedRectangle(cornerRadius: PorcelainTokens.radiusMedium))
                    }
                    Text(row.title).font(.title3.bold())
                    if let subtitle = row.subtitle {
                        Text(subtitle).foregroundStyle(PorcelainTokens.graphiteSecondary)
                    }
                }
                .frame(maxWidth: .infinity)
            }
            .listRowBackground(Color.clear)

            Section("Details") {
                ForEach(fields, id: \.key) { field in
                    if let value = displayValue(for: field) {
                        LabeledContent(field.label, value: value)
                    }
                }
            }

            Section {
                DisclosureGroup("Raw", isExpanded: $showingRaw) {
                    Text(prettyJSON(row.raw))
                        .font(.system(.footnote, design: .monospaced))
                        .textSelection(.enabled)
                }
            }
        }
    }

    private var cover: some View {
        RoundedRectangle(cornerRadius: PorcelainTokens.radiusMedium)
            .fill(PorcelainTokens.inset)
            .overlay(Image(systemName: "photo").foregroundStyle(PorcelainTokens.graphiteSecondary))
            .frame(height: 240)
    }

    private var fields: [FieldDescriptor] {
        descriptor.fields
            .filter(\.showInDetail)
            .sorted { ($0.detailOrder ?? Int.max) < ($1.detailOrder ?? Int.max) }
    }

    /// Formats `row.raw[field.key]` per `field.kind`. Returns `nil` (skip the row) for a missing
    /// key or a JSON `null`.
    private func displayValue(for field: FieldDescriptor) -> String? {
        guard let value = row.raw[field.key] else { return nil }
        switch value {
        case .null:
            return nil
        case .string(let string):
            if field.kind == .date || field.kind == .timestamp {
                return formattedDate(string) ?? string
            }
            return string
        case .number(let number):
            return number.formatted()
        case .bool(let bool):
            return bool ? "Yes" : "No"
        case .array(let items):
            if items.allSatisfy({ $0.stringValue != nil }) {
                return items.compactMap(\.stringValue).joined(separator: ", ")
            }
            return "\(items.count) item\(items.count == 1 ? "" : "s")"
        case .object:
            return "{…}"
        }
    }

    private func formattedDate(_ string: String) -> String? {
        let withFraction = ISO8601DateFormatter()
        withFraction.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        if let date = withFraction.date(from: string) {
            return date.formatted(date: .abbreviated, time: .shortened)
        }
        let plain = ISO8601DateFormatter()
        plain.formatOptions = [.withInternetDateTime]
        if let date = plain.date(from: string) {
            return date.formatted(date: .abbreviated, time: .shortened)
        }
        return nil
    }

    private func prettyJSON(_ value: JSONValue) -> String {
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.prettyPrinted, .sortedKeys]
        guard let data = try? encoder.encode(value), let string = String(data: data, encoding: .utf8) else {
            return "{}"
        }
        return string
    }
}

#Preview {
    NavigationStack {
        EntityDetailContent(descriptor: EntityCatalog[.product], row: PreviewFixtures.sampleDetailRow)
    }
}
