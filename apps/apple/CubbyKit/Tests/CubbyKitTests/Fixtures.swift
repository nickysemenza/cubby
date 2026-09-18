import Foundation

/// Loads a captured fixture from `Tests/CubbyKitTests/Fixtures/` by filename (including
/// extension), via `Bundle.module`. Fixtures never contain real household data — see AGENTS.md.
enum Fixtures {
    static func data(named filename: String) throws -> Data {
        let name = (filename as NSString).deletingPathExtension
        let ext = (filename as NSString).pathExtension
        guard
            let url = Bundle.module.url(
                forResource: name,
                withExtension: ext,
                subdirectory: "Fixtures"
            )
        else {
            fatalError("Missing fixture: \(filename)")
        }
        return try Data(contentsOf: url)
    }

    /// Decodes dates exactly as the generated client does (`Configuration.cubby`), so a fixture
    /// that passes here also decodes in production. The product fixture deliberately mixes
    /// fractional and plain timestamps.
    static func decode<T: Decodable>(_ type: T.Type, from filename: String) throws -> T {
        try JSONDecoder.cubby().decode(T.self, from: data(named: filename))
    }
}
