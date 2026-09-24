import CryptoKit
import CubbyKit
import Foundation
import Observation
import SwiftUI

@MainActor @Observable
final class LocationPhotoPassModel {
    enum Phase: Equatable { case loading, ready, failed(String) }

    private struct SavedPass: Codable {
        let ids: [String]
        let cursor: Int
        let completed: Int
        let skipped: Int
        let scannedStop: String?
    }

    private(set) var phase: Phase = .loading
    private(set) var tree: LocationTree?
    private(set) var stops: [LocationCode] = []
    private(set) var cursor = 0
    private(set) var completed = 0
    private(set) var skipped = 0
    var scanCode = ""
    var scanError: String?
    var scannedStop: LocationCode?

    private let client: CubbyClient
    private let scope: LocationCode?
    private let storageKey: String

    init(client: CubbyClient, scope: LocationCode?, host: String, credential: String) {
        self.client = client
        self.scope = scope
        let digest = SHA256.hash(data: Data(credential.utf8)).map { String(format: "%02x", $0) }.joined()
        storageKey = "cubby.photo-pass.v1.\(host).\(digest).\(scope?.rawValue ?? "house")"
    }

    var current: LocationTreeNode? {
        guard let tree else { return nil }
        if let scannedStop { return tree[scannedStop] }
        guard stops.indices.contains(cursor) else { return nil }
        return tree[stops[cursor]]
    }

    var remaining: Int { max(0, stops.count - cursor) }

    func load(restart: Bool = false) async {
        phase = .loading
        do {
            let fresh = try await client.locationTree()
            tree = fresh
            let saved =
                restart
                ? nil
                : UserDefaults.standard.data(forKey: storageKey)
                    .flatMap { try? JSONDecoder().decode(SavedPass.self, from: $0) }
            if let saved {
                let finished = saved.ids.prefix(saved.cursor)
                    .map { LocationCode($0) }.filter { fresh[$0] != nil }
                let pending = saved.ids.dropFirst(saved.cursor)
                    .map { LocationCode($0) }.filter { fresh[$0] != nil }
                stops = finished + pending
                cursor = finished.count
                completed = saved.completed
                skipped = saved.skipped
                scannedStop = saved.scannedStop.map { LocationCode($0) }.flatMap {
                    fresh[$0] == nil ? nil : $0
                }
            } else {
                let roots = scope.flatMap { fresh[$0] }.map { [$0] } ?? fresh.roots
                var queue: [LocationCode] = []
                func visit(_ node: LocationTreeNode) {
                    if !node.images.contains(where: {
                        $0.status == .uploaded && $0.contentType.hasPrefix("image/")
                    }) {
                        queue.append(node.id)
                    }
                    for child in node.childNodes { visit(child) }
                }
                roots.forEach(visit)
                stops = queue
                cursor = 0
                completed = 0
                skipped = 0
                save()
            }
            phase = .ready
        } catch {
            phase = .failed((error as? CubbyAPIError)?.detail?.message ?? String(describing: error))
        }
    }

    func scan(_ raw: String) {
        let value = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        guard let label = CubbyLabel(value), label.key == .location,
            let tree, tree[LocationCode(label.code)] != nil
        else {
            scanError = "Scan a location label in this house."
            return
        }
        scannedStop = LocationCode(label.code)
        scanCode = ""
        scanError = nil
        save()
    }

    func advance(photoAdded: Bool) {
        if scannedStop != nil {
            if photoAdded { completed += 1 }
            self.scannedStop = nil
            save()
            return
        }
        guard cursor < stops.count else { return }
        cursor += 1
        if photoAdded { completed += 1 } else { skipped += 1 }
        save()
    }

    func restart() async {
        UserDefaults.standard.removeObject(forKey: storageKey)
        scannedStop = nil
        await load(restart: true)
    }

    private func save() {
        guard
            let data = try? JSONEncoder().encode(
                SavedPass(
                    ids: stops.map(\.rawValue), cursor: cursor, completed: completed,
                    skipped: skipped, scannedStop: scannedStop?.rawValue))
        else { return }
        UserDefaults.standard.set(data, forKey: storageKey)
    }
}

struct LocationPhotoPassView: View {
    let scope: LocationCode?
    @Environment(AppModel.self) private var appModel
    @State private var pass: LocationPhotoPassModel?
    @State private var capture: PhotoCaptureModel?

    private var credentialKey: String {
        switch appModel.credential {
        case .some(.bearer(let token)), .some(.apiKey(let token)): token
        case nil: "signed-out"
        }
    }

    private var taskKey: String {
        let digest = SHA256.hash(data: Data(credentialKey.utf8))
            .map { String(format: "%02x", $0) }.joined()
        return "\(appModel.host).\(digest).\(scope?.rawValue ?? "house")"
    }

    var body: some View {
        Group {
            if let pass {
                content(pass)
            } else {
                LoadingIndicator.screen(label: "Loading photo pass")
            }
        }
        .porcelainScreen()
        .navigationTitle("Location photo pass")
        .task(id: taskKey) {
            let pass = LocationPhotoPassModel(
                client: appModel.client, scope: scope, host: appModel.host, credential: credentialKey)
            self.pass = pass
            await pass.load()
        }
        .sheet(item: $capture) { capture in
            AddPhotoSheet(capture: capture) { _ in pass?.advance(photoAdded: true) }
        }
    }

    @ViewBuilder
    private func content(_ pass: LocationPhotoPassModel) -> some View {
        switch pass.phase {
        case .loading:
            LoadingIndicator.screen(label: "Loading photo pass")
        case .failed(let message):
            ContentUnavailableView {
                Label("Couldn't load locations", systemImage: "exclamationmark.triangle")
            } description: {
                Text(message)
            } actions: {
                Button("Retry") { Task { await pass.load() } }
            }
        case .ready:
            ScrollView {
                VStack(alignment: .leading, spacing: PorcelainTokens.Space.lg) {
                    Text(
                        "\(pass.remaining) stops left · \(pass.completed) photographed · \(pass.skipped) skipped"
                    )
                    .font(.porcelainData)
                    HStack {
                        TextField(
                            "Scan a location label",
                            text: Binding(
                                get: { pass.scanCode }, set: { pass.scanCode = $0 })
                        )
                        .textInputAutocapitalization(.characters)
                        .onSubmit { pass.scan(pass.scanCode) }
                        Button("Go") { pass.scan(pass.scanCode) }
                    }
                    #if os(iOS)
                        ScannerSlot(onRead: { pass.scan($0) }, annotate: { _ in nil })
                            .frame(height: 180)
                    #endif
                    if let scanError = pass.scanError {
                        Text(scanError).foregroundStyle(PorcelainTokens.destructive)
                    }
                    if let stop = pass.current {
                        Panel {
                            Eyebrow(pass.scannedStop == nil ? "Next stop" : "Scanned stop")
                            Text(stop.name).font(.porcelainTitle)
                            if let tree = pass.tree {
                                Text(tree.breadcrumb(of: stop.id).map(\.name).joined(separator: " / "))
                                    .font(.porcelainLabel)
                                    .foregroundStyle(PorcelainTokens.graphiteSecondary)
                            }
                            Text(stop.id.rawValue).font(.porcelainCode)
                            NavigationLink(value: Route.entityDetail(.location, id: stop.id.rawValue)) {
                                Label("Open location", systemImage: "arrow.up.right.square")
                            }
                        }
                        Button("Take photo", systemImage: "camera") {
                            capture = PhotoCaptureModel(
                                client: appModel.client, entity: .location,
                                entityID: stop.id.rawValue, entityTitle: stop.name,
                                featurePrints: appModel.featurePrints)
                        }
                        .buttonStyle(.borderedProminent)
                        Button("Skip this stop") { pass.advance(photoAdded: false) }
                    } else {
                        Panel { Text("Photo pass complete").font(.porcelainTitle) }
                    }
                    Button("Start this pass over") { Task { await pass.restart() } }
                        .foregroundStyle(PorcelainTokens.graphiteSecondary)
                }
                .padding(PorcelainTokens.Space.lg)
                .frame(maxWidth: PorcelainTokens.readingWidth, alignment: .leading)
                .frame(maxWidth: .infinity)
            }
        }
    }
}

#Preview(traits: .modifier(SignedInPreview())) {
    NavigationStack { LocationPhotoPassView(scope: nil) }
}
