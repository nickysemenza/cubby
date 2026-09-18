import CubbyKit
import SwiftUI

/// Images use image.detail; they do not have the generic resources.image.get route.
struct ImageEntityDetailView: View {
    enum Tab: String, CaseIterable { case photo = "Photo", diagnostics = "Diagnostics" }

    let id: ImageCode
    @Environment(AppModel.self) private var appModel
    @State private var detail: ImageWithEntity?
    @State private var error: String?
    @State private var tab: Tab = .photo
    @State private var diagnostics = ImageDiagnosticsCompareModel()

    var body: some View {
        List {
            if let detail {
                Picker("View", selection: $tab) {
                    ForEach(Tab.allCases, id: \.self) { Text($0.rawValue).tag($0) }
                }
                .pickerStyle(.segmented)
                .listRowSeparator(.hidden)
                switch tab {
                case .photo: PhotoTab(detail: detail, appModel: appModel)
                case .diagnostics: ImageDiagnosticsCompareView(model: diagnostics)
                }
            } else if let error {
                Text(error).foregroundStyle(PorcelainTokens.destructive)
                Button("Retry") { Task { await load() } }
            } else {
                ProgressView("Loading image…")
            }
        }
        .navigationTitle(detail?.filename ?? "Image")
        #if os(iOS)
            .navigationBarTitleDisplayMode(.inline)
        #endif
        .navigationDestination(for: Route.self) { route in
            RouteDestinationView(route: route)
        }
        .toolbar {
            ShareLink(item: appModel.webURL(for: id.rawValue))
        }
        .task(id: "\(appModel.host):\(id.rawValue)") { await load() }
        .onChange(of: tab) { _, newValue in
            guard newValue == .diagnostics, let detail else { return }
            diagnostics.run(id: id, detail: detail, client: appModel.client)
        }
        .onDisappear { diagnostics.cancel() }
    }

    private func load() async {
        error = nil
        do { detail = try await appModel.client.imageDetail(id) } catch {
            self.error = error.localizedDescription
            Diagnostics.report(error, context: "photos.imageDetail")
        }
    }
}

private struct PhotoTab: View {
    let detail: ImageWithEntity
    let appModel: AppModel

    var body: some View {
        if let url = detail.imageURL {
            PhotoAttachmentImage(
                photo: PhotoAttachment(id: detail.id.rawValue, filename: detail.filename, source: .remote(url)),
                renderedWidth: nil
            ).frame(maxHeight: 420)
        }
        LabeledContent("Image", value: detail.id.rawValue)
        Section("Used in") {
            if detail.associations.isEmpty {
                Text("No current associations").foregroundStyle(.secondary)
            }
            ForEach(detail.associations) { association in
                if let key = association.key {
                    NavigationLink(value: Route.entityDetail(key, id: association.entityId)) {
                        VStack(alignment: .leading) {
                            Label(association.entityName, systemImage: entitySymbol(for: key))
                            Text(association.role.rawValue).font(.caption).foregroundStyle(.secondary)
                        }
                    }
                } else {
                    Link(association.entityName, destination: appModel.webURL(for: association.entityId))
                }
            }
        }
    }
}

#Preview(traits: .modifier(SignedInPreview())) {
    NavigationStack { ImageEntityDetailView(id: ImageCode("IMG-2345")) }
}
