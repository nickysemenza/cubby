import Foundation

/// Loads a captured fixture from `Tests/CubbyKitTests/Fixtures/` by filename (including
/// extension), via `Bundle.module`. Fixtures never contain real household data — see CLAUDE.md.
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

    /// Decodes with ISO-8601 dates, matching what the OpenAPI runtime configures for the real
    /// client. A bare `JSONDecoder` would expect epoch seconds and reject every `createdAt`.
    static func decode<T: Decodable>(_ type: T.Type, from filename: String) throws -> T {
        let decoder = JSONDecoder()
        decoder.dateDecodingStrategy = .iso8601
        return try decoder.decode(T.self, from: data(named: filename))
    }
}
