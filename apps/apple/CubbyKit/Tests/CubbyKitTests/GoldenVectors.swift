import Foundation

/// Loads a cross-language vector file from `packages/shared/golden-vectors/`. The web, Rust and
/// Swift suites read the same files, so a rule that exists on more than one platform cannot drift
/// silently (see the `_doc` field in each file). Located relative to this source file because
/// CubbyKit is only ever tested from a checkout.
enum GoldenVectors {
    static func data(named name: String) throws -> Data {
        // <root>/apps/apple/CubbyKit/Tests/CubbyKitTests/GoldenVectors.swift
        var url = URL(fileURLWithPath: #filePath)
        for _ in 0..<6 { url.deleteLastPathComponent() }
        return try Data(
            contentsOf: url.appending(path: "packages/shared/golden-vectors/\(name).json"))
    }

    static func decode<T: Decodable>(_ type: T.Type, named name: String) throws -> T {
        try JSONDecoder().decode(T.self, from: data(named: name))
    }
}
