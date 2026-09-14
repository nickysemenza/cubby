import Foundation

public struct ImageHashRepair: Sendable, Hashable {
    public let id: ImageCode
    public let url: URL
    public init(id: ImageCode, url: URL) { self.id = id; self.url = url }
}

public struct ImageHashIndexDocument: Sendable {
    public let algorithmRevision: Int
    public let items: [ImageHashEntry]
    public let repair: [ImageHashRepair]
    public init(algorithmRevision: Int, items: [ImageHashEntry], repair: [ImageHashRepair]) {
        self.algorithmRevision = algorithmRevision; self.items = items; self.repair = repair
    }
}

public struct ImageHashUpdate: Sendable, Hashable {
    public let id: ImageCode
    public let perceptualHash: PerceptualHash64
    public init(id: ImageCode, perceptualHash: PerceptualHash64) {
        self.id = id; self.perceptualHash = perceptualHash
    }
}

public struct ImageHashWriteResult: Sendable {
    public let items: [ImageHashUpdate]
    public let unavailable: [ImageCode]
    public init(items: [ImageHashUpdate], unavailable: [ImageCode]) {
        self.items = items; self.unavailable = unavailable
    }
}

public struct CubbyImageDetail: Identifiable, Sendable {
    public struct Association: Identifiable, Sendable {
        public var id: String { "\(entityType):\(entityID):\(role)" }
        public let entityType: String
        public let entityID: String
        public let name: String
        public let role: String
        public init(entityType: String, entityID: String, name: String, role: String) {
            self.entityType = entityType; self.entityID = entityID; self.name = name; self.role = role
        }
    }
    public let id: ImageCode
    public let url: URL
    public let filename: String
    public let associations: [Association]
    public init(id: ImageCode, url: URL, filename: String, associations: [Association]) {
        self.id = id; self.url = url; self.filename = filename; self.associations = associations
    }
}
