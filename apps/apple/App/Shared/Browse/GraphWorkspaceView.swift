import CubbyKit
import SwiftUI

@Observable final class GraphWorkspaceSession {
    let clientID: ObjectIdentifier
    let explorer: EntityGraphExplorer
    let camera = GraphCamera()
    init(client: CubbyClient) {
        clientID = ObjectIdentifier(client)
        explorer = EntityGraphExplorer(client: client)
    }
}

@Observable final class GraphCamera {
    var scale: CGFloat = 1
    var pan: CGSize = .zero
    var frames: [String: EntityGraphFrame] = [:]
    var reveal = 0
    var rearrange = 0
    func reset() { scale = 1; pan = .zero; frames = [:]; rearrange += 1 }
}

struct GraphWorkspaceView: View {
    var initialRoot: EntityRef?
    @Environment(AppModel.self) private var appModel
    @State private var session: GraphWorkspaceSession?
    @State private var pickingRoot = false
    @State private var appliedInitialRoot = false

    var body: some View {
        Group {
            if let session {
                GraphExplorerPane(model: session.explorer, camera: session.camera, embedded: false)
                    .overlay {
                        if session.explorer.graph == nil, !session.explorer.loading,
                            session.explorer.errors.isEmpty
                        {
                            ContentUnavailableView {
                                Label(
                                    "Choose a starting record",
                                    systemImage: "point.3.connected.trianglepath.dotted")
                            } description: {
                                Text("Expand connections to build a map across your household.")
                            } actions: {
                                Button("Find a record") { pickingRoot = true }
                            }
                        }
                    }
            } else {
                LoadingIndicator.screen(label: "Loading graph")
            }
        }
        .navigationTitle("Graph")
        .toolbar { Button("Starting record", systemImage: "magnifyingglass") { pickingRoot = true } }
        .sheet(isPresented: $pickingRoot) {
            GraphStartingRecordPicker { reference in
                pickingRoot = false
                session?.camera.reset()
                Task { await session?.explorer.start(at: reference) }
            }
            .nativeSheet(.picker)
        }
        .task {
            if appModel.navigator.graphWorkspace?.clientID != ObjectIdentifier(appModel.client) {
                appModel.navigator.graphWorkspace = GraphWorkspaceSession(client: appModel.client)
            }
            session = appModel.navigator.graphWorkspace
            if !appliedInitialRoot, let initialRoot, session?.explorer.graph?.root != initialRoot {
                appliedInitialRoot = true
                session?.camera.reset()
                await session?.explorer.start(at: initialRoot)
            }
        }
    }
}

struct EmbeddedGraphExplorer: View {
    let graph: EntityGraph
    @Environment(AppModel.self) private var appModel
    @State private var explorer: EntityGraphExplorer?
    @State private var camera = GraphCamera()
    var body: some View {
        Group {
            if let explorer {
                GraphExplorerPane(model: explorer, camera: camera, embedded: true)
            } else {
                LoadingIndicator(label: "Loading graph")
            }
        }
        .task {
            if explorer == nil {
                explorer = EntityGraphExplorer(client: appModel.client, initialGraph: graph)
            }
        }
    }
}

private struct GraphStartingRecordPicker: View {
    let select: (EntityRef) -> Void
    @Environment(AppModel.self) private var appModel
    @Environment(\.dismiss) private var dismiss
    @State private var query = ""
    @State private var hits: [SearchHit] = []
    @State private var loading = false
    @State private var error: String?

    var body: some View {
        NavigationStack {
            List {
                if loading { LoadingIndicator(label: "Finding records") }
                if let error { Text(error).foregroundStyle(.secondary) }
                ForEach(hits) { hit in
                    if let key = hit.key {
                        Button {
                            select(.init(entity: key, id: hit.id))
                        } label: {
                            VStack(alignment: .leading) {
                                Text(hit.title).foregroundStyle(.primary)
                                Text(EntityCatalog[key].singular).font(.caption).foregroundStyle(.secondary)
                            }
                        }
                    }
                }
                if !loading, !query.isEmpty, hits.isEmpty, error == nil {
                    Text("No records found.").foregroundStyle(.secondary)
                }
            }
            .navigationTitle("Starting record")
            .searchable(text: $query, prompt: "Find any record")
            .toolbar { ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() } } }
            .task(id: query) {
                hits = []; error = nil
                guard !query.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else {
                    loading = false; return
                }
                loading = true
                do {
                    try await Task.sleep(for: .milliseconds(200))
                    let result = try await appModel.client.search(
                        String(query.prefix(SearchHit.maxQueryLength)), limit: 20)
                    try Task.checkCancellation()
                    hits = result.filter { hit in
                        guard let key = hit.key else { return false }
                        return EntityCatalog[key].shortcodePrefix != nil
                    }
                    loading = false
                } catch is CancellationError {
                    // The replacement search owns loading and result state.
                } catch {
                    guard !Task.isCancelled else { return }
                    self.error = error.localizedDescription; loading = false
                    Diagnostics.report(error, context: "graph.search")
                }
            }
        }
    }
}

private struct GraphExplorerPane: View {
    let model: EntityGraphExplorer
    let camera: GraphCamera
    let embedded: Bool
    @Environment(AppModel.self) private var appModel
    @Environment(\.openURL) private var openURL
    @Environment(\.horizontalSizeClass) private var sizeClass
    @State private var inspecting = false
    @State private var query = ""
    @State private var showList = false

    private var wide: Bool {
        #if os(macOS)
            true
        #else
            sizeClass == .regular
        #endif
    }
    private var selected: EntityGraphNode? { model.graph?.nodes.first { $0.reference == model.selectedNode } }

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            controls
            if model.loading { LoadingIndicator(label: "Loading relationships") }
            if model.atCapacity {
                Text(
                    "Map capacity reached: 500 records or 1,000 connections. Start a new map from a selected record to continue."
                ).font(.callout).foregroundStyle(.secondary)
            }
            if let graph = model.visibleGraph {
                Text(
                    "\(graph.nodes.count) visible · \(model.graph?.nodes.count ?? 0) loaded · \(graph.edges.count) connections"
                )
                .font(.caption).foregroundStyle(.secondary)
                HStack(alignment: .top, spacing: 12) {
                    ZStack {
                        NativeGraphCanvas(
                            graph: graph, selected: model.selectedNode, selectedEdgeID: model.selectedEdgeID,
                            camera: camera
                        ) { node in
                            model.select(node.reference); inspecting = true
                        } onSelectEdge: { id in
                            model.selectedEdgeID = id; inspecting = true
                        }
                        .opacity(showList || !query.isEmpty ? 0 : 1)
                        .allowsHitTesting(!showList && query.isEmpty)
                        .accessibilityHidden(showList || !query.isEmpty)
                        if showList || !query.isEmpty {
                            List(
                                graph.nodes.filter {
                                    query.isEmpty
                                        || "\($0.label) \($0.reference.id)".localizedCaseInsensitiveContains(
                                            query)
                                }
                            ) { node in
                                Button {
                                    model.select(node.reference); camera.reveal += 1; query = "";
                                    showList = false; inspecting = true
                                } label: {
                                    Text(node.label).foregroundStyle(.primary)
                                }
                            }
                        }
                    }
                    .frame(minHeight: embedded ? 440 : 300)
                    if wide { inspector.frame(width: 280) }
                }
            }
            ForEach(model.errors.keys.sorted(), id: \.self) { key in
                if model.graph == nil, let root = model.selectedNode {
                    VStack(alignment: .leading) {
                        Text(model.errors[key] ?? "Relationships could not load.").foregroundStyle(.secondary)
                        Button("Retry relationships") { Task { await model.start(at: root) } }
                    }
                }
            }
            if !model.loading, let graph = model.graph, graph.nodes.isEmpty {
                Text("This record is unavailable or has been deleted. Choose another starting record.")
                    .foregroundStyle(.secondary)
            }
        }
        .padding(embedded ? 0 : 16)
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
        .sheet(isPresented: Binding(get: { inspecting && !wide }, set: { inspecting = $0 })) {
            NavigationStack {
                inspector.padding().navigationTitle("Graph inspector")
                    .toolbar {
                        ToolbarItem(placement: .confirmationAction) { Button("Done") { inspecting = false } }
                    }
            }
            .nativeSheet(.adjustment)
        }
        .onChange(of: model.errors) { _, errors in
            for (key, message) in errors {
                Diagnostics.report(GraphDisplayError(message: message), context: "graph.\(key)")
            }
        }
        #if os(iOS)
            .controlSize(.large)
        #endif
    }

    private var controls: some View {
        ViewThatFits(in: .horizontal) {
            HStack {
                historyButtons; TextField("Find in this map", text: $query).textFieldStyle(.roundedBorder);
                viewButtons
            }
            VStack {
                HStack {
                    historyButtons; Spacer(); viewButtons
                }; TextField("Find in this map", text: $query).textFieldStyle(.roundedBorder)
            }
        }
    }
    private var historyButtons: some View {
        HStack {
            Button("Previous record", systemImage: "chevron.left") {
                model.moveHistory(by: -1); camera.reveal += 1
            }
            .disabled(model.historyIndex == 0)
            Button("Next record", systemImage: "chevron.right") {
                model.moveHistory(by: 1); camera.reveal += 1
            }
            .disabled(model.historyIndex >= model.history.count - 1)
        }.labelStyle(.iconOnly).buttonStyle(.bordered)
    }
    private var viewButtons: some View {
        HStack {
            Button(
                showList ? "Show graph" : "Show record list",
                systemImage: showList ? "point.3.connected.trianglepath.dotted" : "list.bullet"
            ) { showList.toggle() }
            if !wide { Button("Inspect selection", systemImage: "info.circle") { inspecting = true } }
            if embedded, let root = model.graph?.root {
                Button("Open graph", systemImage: "arrow.up.left.and.arrow.down.right") {
                    appModel.navigator.openGraph(root: root)
                }
            }
        }.labelStyle(.iconOnly).buttonStyle(.bordered)
    }
    private var inspector: some View {
        VStack(alignment: .leading, spacing: 12) {
            if let node = selected {
                inspectorHeader(node)
                Divider()
                ScrollView {
                    VStack(alignment: .leading, spacing: 12) {
                        if let edge = model.graph?.edges.first(where: { $0.id == model.selectedEdgeID }) {
                            VStack(alignment: .leading, spacing: 6) {
                                Text(edge.label).font(.headline)
                                Text("Source: \(edge.sourceKey)").font(.caption)
                                ForEach(edge.provenance, id: \.self) {
                                    Text($0).font(.caption).foregroundStyle(.secondary)
                                }
                            }
                            Divider()
                        }
                        VStack(spacing: 0) {
                            ForEach(
                                model.graph?.branches.filter {
                                    $0.root == node.reference && $0.totalCount > 0
                                } ?? []
                            ) {
                                branch in
                                branchRow(branch)
                                Divider()
                            }
                        }
                        if let path = model.visibleGraph?.paths.first(where: {
                            $0.destination == node.reference
                        }),
                            !path.edgeIds.isEmpty
                        {
                            Text("Path from starting record").font(.subheadline.weight(.medium))
                            ForEach(path.edgeIds, id: \.self) { id in
                                if let edge = model.graph?.edges.first(where: { $0.id == id }) {
                                    Button {
                                        model.selectedEdgeID = id
                                    } label: {
                                        VStack(alignment: .leading) {
                                            Text(edge.label)
                                            Text("\(edge.source.id) → \(edge.target.id)").font(.caption)
                                        }
                                    }
                                }
                            }
                        }
                    }
                    .frame(maxWidth: .infinity, alignment: .leading)
                }
                .id("\(node.id):\(model.selectedEdgeID ?? "")")
            } else {
                Text("Select a record to inspect its connections.").foregroundStyle(.secondary)
            }
        }
        .buttonStyle(.bordered)
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    private func inspectorHeader(_ node: EntityGraphNode) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack(spacing: 6) {
                DomainMark(node.reference.entity)
                Text("\(EntityCatalog[node.reference.entity].singular) · \(node.reference.id)")
                    .font(.caption).foregroundStyle(.secondary)
            }
            Text(node.label).font(.headline).textSelection(.enabled)
            HStack {
                Button("Open record") {
                    inspecting = false
                    if node.reference.entity.nativeActions.contains(.get) {
                        appModel.navigator.openRecord(
                            .init(key: node.reference.entity, id: node.reference.id))
                    } else {
                        openURL(
                            appModel.webURL(
                                for: node.reference.entity, id: node.reference.id))
                    }
                }
                Menu("Record actions", systemImage: "ellipsis") {
                    Button("Start new map here") {
                        camera.reset(); Task { await model.start(at: node.reference) }
                    }
                }
                .labelStyle(.iconOnly).fixedSize()
            }
            if !model.expanded.contains(node.reference) {
                Button(model.busy.contains(node.id) ? "Loading connections…" : "Expand connections") {
                    Task { await model.expand(node.reference) }
                }
                .disabled(model.busy.contains(node.id) || model.atCapacity)
            }
            if let message = model.errors[node.id] {
                Text(message).font(.callout).foregroundStyle(.secondary)
            }
        }
    }

    private func branchRow(_ branch: EntityGraphBranch) -> some View {
        let shown = model.shownCount(for: branch)
        let busy = model.busy.contains(branch.id)
        let unavailable = busy || (model.atCapacity && shown >= branch.items.count)
        return VStack(alignment: .leading, spacing: 4) {
            HStack(spacing: 8) {
                Button {
                    if shown > 0 { model.collapse(branch) } else { Task { await model.showMore(branch) } }
                } label: {
                    HStack(spacing: 8) {
                        Image(systemName: shown > 0 ? "chevron.down" : "chevron.right")
                            .font(.caption.weight(.semibold)).foregroundStyle(.secondary).frame(width: 10)
                        Text(branch.label).font(.subheadline.weight(.medium)).foregroundStyle(.primary)
                        Spacer(minLength: 4)
                        Text(shown > 0 ? "\(shown) / \(branch.totalCount)" : "\(branch.totalCount)")
                            .font(.caption).monospacedDigit().foregroundStyle(.secondary)
                    }
                    .frame(minHeight: 40).contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .disabled(shown == 0 && unavailable)
                .accessibilityLabel("\(shown > 0 ? "Collapse" : "Expand") \(branch.label)")
                .accessibilityValue("\(shown) of \(branch.totalCount) shown")
                if shown > 0, shown < branch.totalCount {
                    Button("Show more \(branch.label)", systemImage: "plus") {
                        Task { await model.showMore(branch) }
                    }
                    .labelStyle(.iconOnly).disabled(unavailable)
                    .help("Show \(min(EntityGraphExplorer.pageSize, branch.totalCount - shown)) more")
                }
                if busy { ProgressView().controlSize(.small) }
            }
            if let message = model.errors[branch.id] {
                Text(message).font(.callout).foregroundStyle(.secondary)
            }
        }
        .padding(.vertical, 2)
    }
}

private struct GraphDisplayError: LocalizedError {
    let message: String
    var errorDescription: String? { message }
}

#Preview("Graph workspace", traits: .modifier(SignedInPreview())) { NavigationStack { GraphWorkspaceView() } }
