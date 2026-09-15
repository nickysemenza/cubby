import Foundation

public struct EntityGraphFrame: Sendable, Hashable {
    public let x: Double
    public let y: Double
    public let width: Double
    public let height: Double

    public init(x: Double, y: Double, width: Double, height: Double) {
        self.x = x; self.y = y; self.width = width; self.height = height
    }

    public func intersects(_ other: EntityGraphFrame, gap: Double = 0) -> Bool {
        x < other.x + other.width + gap && x + width + gap > other.x && y < other.y + other.height + gap
            && y + height + gap > other.y
    }
}

/// Compact, incremental card placement. Selection and viewport state never enter this input.
public enum EntityGraphMapLayout {
    private struct Cell: Hashable { let x: Int; let y: Int }
    @concurrent public static func place(
        graph: EntityGraph,
        measuredSizes: [String: EntityGraphNodeSize],
        previous: [String: EntityGraphFrame]
    ) async throws -> [String: EntityGraphFrame] {
        var positions = previous
        var anchors: [String: String] = [:]
        for branch in graph.branches {
            for item in branch.items where anchors[item.stableKey] == nil {
                anchors[item.stableKey] = branch.root.stableKey
            }
        }
        let defaultSize = EntityGraphNodeSize(width: 196, height: 100)
        let cellWidth = max(defaultSize.width, measuredSizes.values.map(\.width).max() ?? 0) + 32
        let cellHeight = max(defaultSize.height, measuredSizes.values.map(\.height).max() ?? 0) + 32
        var buckets: [Cell: [EntityGraphFrame]] = [:]
        func cells(_ rect: EntityGraphFrame) -> [Cell] {
            var result: [Cell] = []
            for y in Int(floor(rect.y / cellHeight))..<Int(ceil((rect.y + rect.height + 24) / cellHeight)) {
                for x in Int(floor(rect.x / cellWidth))..<Int(ceil((rect.x + rect.width + 24) / cellWidth)) {
                    result.append(Cell(x: x, y: y))
                }
            }
            return result
        }
        for rect in positions.values {
            for cell in cells(rect) { buckets[cell, default: []].append(rect) }
        }
        for node in graph.nodes {
            try Task.checkCancellation()
            if positions[node.id] != nil { continue }
            let size = measuredSizes[node.id] ?? defaultSize
            let parent = anchors[node.id].flatMap { positions[$0] }
            let originX = parent.map { $0.x + cellWidth } ?? 0
            let originY = parent?.y ?? 0
            var radius = 0
            while positions[node.id] == nil {
                try Task.checkCancellation()
                search: for y in -radius...radius {
                    for x in -radius...radius where max(abs(x), abs(y)) == radius {
                        let candidate = EntityGraphFrame(
                            x: originX + Double(x) * cellWidth,
                            y: originY + Double(y) * cellHeight,
                            width: size.width, height: size.height)
                        let occupied = cells(candidate)
                        if occupied.contains(where: { cell in
                            buckets[cell, default: []].contains { candidate.intersects($0, gap: 24) }
                        }) {
                            continue
                        }
                        positions[node.id] = candidate
                        for cell in occupied { buckets[cell, default: []].append(candidate) }
                        break search
                    }
                }
                radius += 1
            }
        }
        return positions
    }
}
