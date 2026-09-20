import CubbyKit
import SwiftUI

/// Images use image.detail; they do not have the generic resources.image.get route.
struct ImageEntityDetailView: View {
    enum Tab: String, CaseIterable { case photo = "Photo", diagnostics = "Diagnostics" }

    let id: ImageCode
    @Environment(AppModel.self) private var appModel
    @Environment(\.developerOverlays) private var developerOverlays
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
                case .photo:
                    PhotoTab(detail: detail, appModel: appModel)
                    if developerOverlays {
                        Section("Developer overlays") {
                            DevOverlayText(ImageDiagnostics.compareCaption(diagnostics))
                        }
                    }
                case .diagnostics:
                    if let url = detail.imageURL {
                        Section("Image being compared") {
                            DiagnosticPhotoPreview(
                                photo: .init(
                                    id: id.rawValue, filename: detail.filename, source: .remote(url)),
                                caption:
                                    "Cubby display rendition. Server and device fingerprints describe the bytes listed below."
                            )
                        }
                    }
                    ImageDiagnosticsCompareView(model: diagnostics)
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
            ToolbarItem { ShareLink(item: appModel.webURL(for: id.rawValue)) }
            if developerOverlays {
                ToolbarItem {
                    CopyDiagnosticsButton {
                        ImageDetailDiagnostics(
                            id: id.rawValue, serverSha256: diagnostics.server?.identity.sha256,
                            deviceSha256: diagnostics.device?.identity.sha256,
                            serverPerceptualHash: diagnostics.server?.identity.perceptualHash,
                            devicePerceptualHash: diagnostics.device?.identity.perceptualHash)
                    }
                }
            }
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
                photo: PhotoAttachment(
                    id: detail.id.rawValue, filename: detail.filename, source: .remote(url)),
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

/// Developer overlays layer 5: server vs. device sha256/pHash, read from whichever
/// `ImageDiagnosticsCompareModel` results are already loaded (the Diagnostics tab having been
/// visited this session) — never triggers a device analysis just for this caption.
private enum ImageDiagnostics {
    static func compareCaption(_ model: ImageDiagnosticsCompareModel) -> String {
        guard model.server != nil || model.device != nil else { return "device: not run" }
        let server = model.server?.identity.sha256.prefix(12) ?? "—"
        let device = model.device?.identity.sha256.prefix(12) ?? "—"
        let serverHash = model.server?.identity.perceptualHash ?? "—"
        let deviceHash = model.device?.identity.perceptualHash ?? "—"
        return
            "sha256 server \(server) · device \(device) — pHash server \(serverHash) · device \(deviceHash)"
    }
}

/// Layer 7's "Copy diagnostics" payload for the Photo tab.
private struct ImageDetailDiagnostics: Encodable {
    let id: String
    let serverSha256: String?
    let deviceSha256: String?
    let serverPerceptualHash: String?
    let devicePerceptualHash: String?
}

#Preview(traits: .modifier(SignedInPreview())) {
    NavigationStack { ImageEntityDetailView(id: ImageCode("IMG-2345")) }
}

#Preview("Developer overlays on", traits: .modifier(SignedInPreview())) {
    NavigationStack { ImageEntityDetailView(id: ImageCode("IMG-2345")) }
        .environment(\.developerOverlays, true)
}
