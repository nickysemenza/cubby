import CubbyKit
import SwiftUI

/// Images use image.detail; they do not have the generic resources.image.get route.
struct ImageEntityDetailView: View {
    let id: ImageCode
    @Environment(AppModel.self) private var appModel
    @State private var detail: CubbyImageDetail?
    @State private var error: String?

    var body: some View {
        List {
            if let detail {
                PhotoAttachmentImage(
                    photo: PhotoAttachment(
                        id: detail.id.rawValue, filename: detail.filename,
                        source: .remote(detail.url)), renderedWidth: nil
                ).frame(maxHeight: 420)
                LabeledContent("Image", value: detail.id.rawValue)
                Section("Used in") {
                    if detail.associations.isEmpty {
                        Text("No current associations").foregroundStyle(.secondary)
                    }
                    ForEach(detail.associations) { association in
                        if let key = EntityKey(rawValue: association.entityType) {
                            NavigationLink(value: Route.entityDetail(key, id: association.entityID)) {
                                VStack(alignment: .leading) {
                                    Label(association.name, systemImage: entitySymbol(for: key))
                                    Text(association.role).font(.caption).foregroundStyle(.secondary)
                                }
                            }
                        } else {
                            Link(association.name, destination: appModel.webURL(for: association.entityID))
                        }
                    }
                }
            } else if let error {
                Text(error).foregroundStyle(PorcelainTokens.destructive)
                Button("Retry") { Task { await load() } }
            } else {
                ProgressView("Loading image…")
            }
        }
        .navigationTitle(detail?.filename ?? "Image")
        .navigationDestination(for: Route.self) { route in
            RouteDestinationView(route: route)
        }
        .toolbar {
            ShareLink(item: appModel.webURL(for: id.rawValue))
        }
        .task(id: "\(appModel.host):\(id.rawValue)") { await load() }
    }

    private func load() async {
        error = nil
        do { detail = try await appModel.client.imageDetail(id) } catch {
            self.error = error.localizedDescription
            Diagnostics.report(error, context: "photos.imageDetail")
        }
    }
}

#Preview(traits: .modifier(SignedInPreview())) {
    NavigationStack { ImageEntityDetailView(id: ImageCode("IMG-2345")) }
}
