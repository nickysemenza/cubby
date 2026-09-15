import Foundation

public struct EntityGraphNodeSize: Sendable, Hashable {
    public let width: Double
    public let height: Double

    public init(width: Double, height: Double) {
        self.width = width
        self.height = height
    }
}

public struct EntityGraphPoint: Sendable, Hashable {
    public let x: Double
    public let y: Double

    public init(x: Double, y: Double) {
        self.x = x
        self.y = y
    }
}

public struct EntityGraphLayoutResult: Sendable, Hashable {
    public let centers: [String: EntityGraphPoint]
    public let width: Double
    public let height: Double

    public init(centers: [String: EntityGraphPoint], width: Double, height: Double) {
        self.centers = centers
        self.width = width
        self.height = height
    }
}

/// A deterministic left-to-right layered layout. Actual node measurements decide both layer
/// spacing and vertical packing, so Dynamic Type never overlaps graph records.
public enum EntityGraphLayout {
    public static func arrange(
        graph: EntityGraph,
        measuredSizes: [String: EntityGraphNodeSize],
        defaultSize: EntityGraphNodeSize = .init(width: 168, height: 72),
        horizontalGap: Double = 72,
        verticalGap: Double = 24,
        padding: Double = 32
    ) -> EntityGraphLayoutResult {
        let nodesByReference = Dictionary(
            graph.nodes.map { ($0.reference, $0) }, uniquingKeysWith: { first, _ in first })
        guard !nodesByReference.isEmpty else {
            return EntityGraphLayoutResult(centers: [:], width: 0, height: 0)
        }

        var neighbors: [EntityReference: Set<EntityReference>] = [:]
        for edge in graph.edges {
            neighbors[edge.source, default: []].insert(edge.target)
            neighbors[edge.target, default: []].insert(edge.source)
        }
        var layerByReference: [EntityReference: Int] = [graph.root: 0]
        var queue = [graph.root]
        var cursor = 0
        while cursor < queue.count {
            let reference = queue[cursor]
            cursor += 1
            let nextLayer = (layerByReference[reference] ?? 0) + 1
            for neighbor in (neighbors[reference] ?? []).sorted(by: stableReferenceOrder) {
                if layerByReference[neighbor] == nil {
                    layerByReference[neighbor] = nextLayer
                    queue.append(neighbor)
                }
            }
        }
        let fallbackLayer = (layerByReference.values.max() ?? 0) + 1
        for reference in nodesByReference.keys where layerByReference[reference] == nil {
            layerByReference[reference] = fallbackLayer
        }

        let grouped = Dictionary(grouping: nodesByReference.values) {
            layerByReference[$0.reference] ?? fallbackLayer
        }
        let layerNumbers = grouped.keys.sorted()
        var layerWidths: [Int: Double] = [:]
        var layerHeights: [Int: Double] = [:]
        for layer in layerNumbers {
            let ordered = orderedNodes(grouped[layer] ?? [], neighbors: neighbors)
            layerWidths[layer] = ordered.map { size(for: $0, measuredSizes, defaultSize).width }.max() ?? 0
            layerHeights[layer] =
                ordered.reduce(0) {
                    $0 + size(for: $1, measuredSizes, defaultSize).height
                } + verticalGap * Double(max(0, ordered.count - 1))
        }
        let contentHeight = layerHeights.values.max() ?? 0
        var x = padding
        var centers: [String: EntityGraphPoint] = [:]
        for layer in layerNumbers {
            let width = layerWidths[layer] ?? 0
            let ordered = orderedNodes(grouped[layer] ?? [], neighbors: neighbors)
            var y = padding + (contentHeight - (layerHeights[layer] ?? 0)) / 2
            for node in ordered {
                let nodeSize = size(for: node, measuredSizes, defaultSize)
                centers[node.id] = EntityGraphPoint(
                    x: x + width / 2,
                    y: y + nodeSize.height / 2
                )
                y += nodeSize.height + verticalGap
            }
            x += width + horizontalGap
        }
        let contentWidth = max(0, x - horizontalGap)
        return EntityGraphLayoutResult(
            centers: centers,
            width: contentWidth + padding,
            height: contentHeight + padding * 2
        )
    }

    private static func size(
        for node: EntityGraphNode,
        _ measuredSizes: [String: EntityGraphNodeSize],
        _ defaultSize: EntityGraphNodeSize
    ) -> EntityGraphNodeSize {
        measuredSizes[node.id] ?? defaultSize
    }

    private static func orderedNodes(
        _ nodes: [EntityGraphNode],
        neighbors: [EntityReference: Set<EntityReference>]
    ) -> [EntityGraphNode] {
        nodes.sorted { left, right in
            let leftNeighbor = (neighbors[left.reference] ?? []).map(\.stableKey).min() ?? ""
            let rightNeighbor = (neighbors[right.reference] ?? []).map(\.stableKey).min() ?? ""
            if leftNeighbor != rightNeighbor { return leftNeighbor < rightNeighbor }
            let labelOrder = left.label.localizedStandardCompare(right.label)
            if labelOrder != .orderedSame { return labelOrder == .orderedAscending }
            return left.id < right.id
        }
    }

    private static func stableReferenceOrder(_ left: EntityReference, _ right: EntityReference) -> Bool {
        left.stableKey < right.stableKey
    }
}
