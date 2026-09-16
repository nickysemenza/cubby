import CubbyKit
import SwiftUI

struct NativeGraphCanvas: View {
    let graph: EntityGraph
    let selected: EntityRef?
    let selectedEdgeID: String?
    let camera: GraphCamera
    let onSelect: (EntityGraphNode) -> Void
    var onSelectEdge: (String) -> Void = { _ in }
    @Environment(\.dynamicTypeSize) private var dynamicTypeSize
    @ScaledMetric(relativeTo: .body) private var cardHeight: CGFloat = 112
    @State private var viewport: CGSize = .zero
    @State private var error: String?
    @GestureState private var drag: CGSize = .zero
    @GestureState private var magnification: CGFloat = 1

    private struct LayoutInput: Hashable {
        let graph: EntityGraph
        let sizes: [String: EntityGraphNodeSize]
        let rearrange: Int
    }
    private var cardWidth: CGFloat { dynamicTypeSize.isAccessibilitySize ? 236 : 196 }
    private var layoutInput: LayoutInput {
        .init(
            graph: graph,
            sizes: Dictionary(
                uniqueKeysWithValues: graph.nodes.map {
                    ($0.id, EntityGraphNodeSize(width: Double(cardWidth), height: Double(cardHeight)))
                }), rearrange: camera.rearrange)
    }
    private var scale: CGFloat { min(2.5, max(0.03, camera.scale * magnification)) }
    private var offset: CGSize {
        CGSize(width: camera.pan.width + drag.width, height: camera.pan.height + drag.height)
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            ViewThatFits(in: .horizontal) {
                HStack {
                    zoomButtons; arrangeButtons
                }
                VStack(alignment: .leading) {
                    zoomButtons; arrangeButtons
                }
            }
            GeometryReader { proxy in
                ZStack {
                    Canvas { context, size in
                        drawEdges(context: &context, size: size)
                        if scale < 0.35 { drawOverviewNodes(context: &context, size: size) }
                    }
                    .onTapGesture { point in
                        if !selectOverviewNode(at: point) { selectEdge(at: point) }
                    }
                    let visible = visibleFrame(size: proxy.size)
                    if scale >= 0.35 {
                        ForEach(graph.nodes) { node in
                            if let frame = camera.frames[node.id], frame.intersects(visible) {
                                nodeCard(node)
                                    .position(
                                        screenPoint(
                                            x: frame.x + frame.width / 2, y: frame.y + frame.height / 2,
                                            size: proxy.size))
                            }
                        }
                    }
                    #if os(macOS)
                        VStack {
                            Spacer();
                            HStack {
                                Spacer(); overview(size: proxy.size)
                            }
                        }.padding(12)
                    #endif
                }
                .frame(width: proxy.size.width, height: proxy.size.height)
                .background(PorcelainTokens.inset)
                .contentShape(Rectangle())
                .clipped()
                .clipShape(RoundedRectangle(cornerRadius: 8))
                .gesture(
                    DragGesture(minimumDistance: 6).updating($drag) { value, state, _ in
                        state = value.translation
                    }
                    .onEnded {
                        camera.pan.width += $0.translation.width; camera.pan.height += $0.translation.height
                    }
                )
                .simultaneousGesture(
                    MagnifyGesture().updating($magnification) { value, state, _ in state = value.magnification
                    }
                    .onEnded { camera.scale = min(2.5, max(0.03, camera.scale * $0.magnification)) }
                )
                .onAppear { viewport = proxy.size }
                .onChange(of: proxy.size) { _, size in viewport = size }
                .accessibilityRepresentation {
                    VStack {
                        Text("Relationship graph")
                        ForEach(graph.nodes) { node in Button(node.label) { onSelect(node) } }
                    }
                }
            }
            if let error { Text(error).font(.caption).foregroundStyle(.secondary) }
        }
        .task(id: layoutInput) {
            do {
                let initial = camera.frames.isEmpty
                let result = try await EntityGraphMapLayout.place(
                    graph: graph, measuredSizes: layoutInput.sizes, previous: camera.frames)
                try Task.checkCancellation()
                camera.frames = result
                if initial { centerSelection() }
                error = nil
            } catch is CancellationError {
                // A newer topology or size owns the layout result.
            } catch {
                self.error = "Graph layout could not load. Use the record list or Reorganize to retry."
                Diagnostics.report(error, context: "graph.layout")
            }
        }
        .onChange(of: camera.reveal) { _, _ in centerSelection() }
        .onChange(of: dynamicTypeSize) { _, _ in
            camera.frames = [:]; camera.rearrange += 1
        }
        #if os(iOS)
            .controlSize(.large)
        #endif
    }

    private var zoomButtons: some View {
        HStack {
            Button("Zoom out", systemImage: "minus.magnifyingglass") {
                camera.scale = max(0.03, camera.scale / 1.25)
            }
            Button("Zoom in", systemImage: "plus.magnifyingglass") {
                camera.scale = min(2.5, camera.scale * 1.25)
            }
            Button("Fit graph", systemImage: "arrow.up.left.and.arrow.down.right") { fit() }
            Button("Center selection", systemImage: "scope") { centerSelection() }
        }.labelStyle(.iconOnly).buttonStyle(.bordered)
    }
    private var arrangeButtons: some View {
        HStack {
            Button("Reorganize") {
                camera.frames = [:]; camera.rearrange += 1
            }
            if scale < 0.85 {
                Button("Read labels") {
                    camera.scale = 1; centerSelection()
                }
            }
            Button("\(Int(camera.scale * 100))%") {
                camera.scale = 1; centerSelection()
            }
            .font(.caption).monospacedDigit().foregroundStyle(.secondary)
            .help("Actual size (100%)")
        }.buttonStyle(.bordered)
    }

    @ViewBuilder private func nodeCard(_ node: EntityGraphNode) -> some View {
        if scale >= 0.85 {
            RelationshipGraphNode(
                node: node, isRoot: node.reference == graph.root,
                isSelected: node.reference == selected,
                isOnPath: false, cardWidth: cardWidth, cardHeight: cardHeight,
                select: { onSelect(node) }
            )
            .scaleEffect(scale)
            .help(node.label)
        } else {
            // Compact cards keep screen-space text; scaling the full card makes labels illegible.
            Button {
                onSelect(node)
            } label: {
                Text(node.label)
                    .font(.caption.weight(.medium))
                    .foregroundStyle(PorcelainTokens.graphite)
                    .lineLimit(2)
                    .multilineTextAlignment(.leading)
                    .padding(.horizontal, 8)
                    .padding(.vertical, 4)
                    .frame(width: cardWidth * scale, height: cardHeight * scale, alignment: .leading)
                    .background(PorcelainTokens.surface)
                    .clipShape(RoundedRectangle(cornerRadius: 4))
                    .overlay(alignment: .leading) {
                        RoundedRectangle(cornerRadius: 1)
                            .fill(node.reference.entity.domain.color)
                            .frame(width: 2).padding(.vertical, 6).padding(.leading, 1)
                    }
                    .overlay {
                        RoundedRectangle(cornerRadius: 4)
                            .strokeBorder(
                                node.reference == selected
                                    ? PorcelainTokens.cobalt : PorcelainTokens.hairline,
                                lineWidth: node.reference == selected ? 2 : 1)
                    }
            }
            .buttonStyle(.plain)
            .help("\(node.label) · \(EntityCatalog[node.reference.entity].singular)")
            .accessibilityLabel("\(node.label), \(EntityCatalog[node.reference.entity].singular)")
            .accessibilityHint("Selects this record and highlights its path")
        }
    }

    private func visibleFrame(size: CGSize) -> EntityGraphFrame {
        .init(
            x: Double((-size.width / 2 - offset.width) / scale) - 200,
            y: Double((-size.height / 2 - offset.height) / scale) - 200,
            width: Double(size.width / scale) + 400, height: Double(size.height / scale) + 400)
    }
    private func screenPoint(x: Double, y: Double, size: CGSize) -> CGPoint {
        CGPoint(
            x: CGFloat(x) * scale + offset.width + size.width / 2,
            y: CGFloat(y) * scale + offset.height + size.height / 2)
    }
    private func centerSelection() {
        guard let frame = camera.frames[(selected ?? graph.root).stableKey] else { return }
        camera.pan = CGSize(
            width: -CGFloat(frame.x + frame.width / 2) * camera.scale,
            height: -CGFloat(frame.y + frame.height / 2) * camera.scale)
    }
    private var bounds: EntityGraphFrame? {
        let frames = graph.nodes.compactMap { camera.frames[$0.id] }
        guard let minX = frames.map(\.x).min(), let minY = frames.map(\.y).min(),
            let maxX = frames.map({ $0.x + $0.width }).max(),
            let maxY = frames.map({ $0.y + $0.height }).max()
        else { return nil }
        return .init(x: minX, y: minY, width: maxX - minX, height: maxY - minY)
    }
    private func fit() {
        guard let bounds else { return }
        camera.scale = min(
            1,
            max(
                0.03,
                min(
                    (viewport.width - 48) / CGFloat(max(1, bounds.width)),
                    (viewport.height - 48) / CGFloat(max(1, bounds.height)))))
        camera.pan = CGSize(
            width: -CGFloat(bounds.x + bounds.width / 2) * camera.scale,
            height: -CGFloat(bounds.y + bounds.height / 2) * camera.scale)
    }
    private func endpoints(_ edge: EntityGraphEdge, size: CGSize) -> (CGPoint, CGPoint)? {
        guard let a = camera.frames[edge.source.stableKey], let b = camera.frames[edge.target.stableKey]
        else { return nil }
        let ax = a.x + a.width / 2, ay = a.y + a.height / 2
        let bx = b.x + b.width / 2, by = b.y + b.height / 2
        let angle = atan2(by - ay, bx - ax)
        func inset(_ rect: EntityGraphFrame) -> Double {
            min(
                rect.width / (2 * max(abs(cos(angle)), 0.001)),
                rect.height / (2 * max(abs(sin(angle)), 0.001))) + 4
        }
        return (
            screenPoint(x: ax + inset(a) * cos(angle), y: ay + inset(a) * sin(angle), size: size),
            screenPoint(x: bx - inset(b) * cos(angle), y: by - inset(b) * sin(angle), size: size)
        )
    }
    private func drawEdges(context: inout GraphicsContext, size: CGSize) {
        let pathIDs = Set(graph.paths.first { $0.destination == selected }?.edgeIds ?? [])
        for edge in graph.edges {
            guard let (a, b) = endpoints(edge, size: size) else { continue }
            if max(a.x, b.x) < 0 || min(a.x, b.x) > size.width || max(a.y, b.y) < 0
                || min(a.y, b.y) > size.height
            {
                continue
            }
            let active = selectedEdgeID == edge.id || pathIDs.contains(edge.id)
            let incident = selected != graph.root && (edge.source == selected || edge.target == selected)
            let color =
                active
                ? PorcelainTokens.cobalt
                : incident
                    ? PorcelainTokens.cobalt.opacity(0.45)
                    : PorcelainTokens.graphiteSecondary.opacity(0.25)
            var path = Path(); path.move(to: a); path.addLine(to: b)
            context.stroke(path, with: .color(color), lineWidth: active ? 1.5 : 1)
            let angle = atan2(b.y - a.y, b.x - a.x)
            var arrow = Path(); arrow.move(to: b)
            arrow.addLine(to: CGPoint(x: b.x - 6 * cos(angle - 0.4), y: b.y - 6 * sin(angle - 0.4)))
            arrow.addLine(to: CGPoint(x: b.x - 6 * cos(angle + 0.4), y: b.y - 6 * sin(angle + 0.4)));
            arrow.closeSubpath()
            context.fill(arrow, with: .color(color))
        }
    }
    private func drawOverviewNodes(context: inout GraphicsContext, size: CGSize) {
        let visible = visibleFrame(size: size)
        for node in graph.nodes {
            guard let frame = camera.frames[node.id], frame.intersects(visible) else { continue }
            let origin = screenPoint(x: frame.x, y: frame.y, size: size)
            let rect = CGRect(
                origin: origin, size: CGSize(width: frame.width * scale, height: frame.height * scale))
            context.fill(
                Path(roundedRect: rect, cornerRadius: 3),
                with: .color(
                    node.reference == selected
                        ? PorcelainTokens.cobalt : node.reference.entity.domain.color.opacity(0.45)))
        }
    }
    private func selectOverviewNode(at point: CGPoint) -> Bool {
        guard scale < 0.35 else { return false }
        let x = Double((point.x - viewport.width / 2 - offset.width) / scale)
        let y = Double((point.y - viewport.height / 2 - offset.height) / scale)
        if let node = graph.nodes.first(where: {
            guard let frame = camera.frames[$0.id] else { return false }
            return x >= frame.x && x <= frame.x + frame.width && y >= frame.y && y <= frame.y + frame.height
        }) {
            onSelect(node); return true
        }
        return false
    }
    private func selectEdge(at point: CGPoint) {
        var nearest: (String, CGFloat)?
        for edge in graph.edges {
            guard let (a, b) = endpoints(edge, size: viewport) else { continue }
            let dx = b.x - a.x, dy = b.y - a.y
            let t = min(1, max(0, ((point.x - a.x) * dx + (point.y - a.y) * dy) / max(1, dx * dx + dy * dy)))
            let distance = hypot(point.x - a.x - t * dx, point.y - a.y - t * dy)
            if distance < 12, distance < (nearest?.1 ?? .infinity) { nearest = (edge.id, distance) }
        }
        if let nearest { onSelectEdge(nearest.0) }
    }
    private func overview(size: CGSize) -> some View {
        Canvas { context, miniSize in
            guard let bounds else { return }
            let ratio = min(
                miniSize.width / CGFloat(max(bounds.width, 1)),
                miniSize.height / CGFloat(max(bounds.height, 1)))
            for node in graph.nodes {
                if let frame = camera.frames[node.id] {
                    let rect = CGRect(
                        x: CGFloat(frame.x - bounds.x) * ratio, y: CGFloat(frame.y - bounds.y) * ratio,
                        width: CGFloat(frame.width) * ratio, height: CGFloat(frame.height) * ratio)
                    context.fill(
                        Path(rect),
                        with: .color(
                            node.reference == selected ? PorcelainTokens.cobalt : PorcelainTokens.hairline))
                }
            }
            let visible = visibleFrame(size: size)
            let viewportRect = CGRect(
                x: CGFloat(visible.x + 200 - bounds.x) * ratio,
                y: CGFloat(visible.y + 200 - bounds.y) * ratio,
                width: CGFloat(visible.width - 400) * ratio, height: CGFloat(visible.height - 400) * ratio)
            context.stroke(Path(viewportRect), with: .color(PorcelainTokens.cobalt), lineWidth: 1)
        }
        .frame(width: 140, height: 90).background(PorcelainTokens.surface).clipShape(
            RoundedRectangle(cornerRadius: 6)
        )
        .onTapGesture { point in
            guard let bounds else { return }
            let ratio = min(140 / CGFloat(max(bounds.width, 1)), 90 / CGFloat(max(bounds.height, 1)))
            camera.pan = CGSize(
                width: -(point.x / ratio + CGFloat(bounds.x)) * camera.scale,
                height: -(point.y / ratio + CGFloat(bounds.y)) * camera.scale)
        }
        .accessibilityHidden(true)
    }
}

#Preview("Graph Canvas", traits: .modifier(SignedInPreview())) { GraphWorkspaceView() }
