// swift-tools-version: 6.2
import PackageDescription

let package = Package(
    name: "CubbyKit",
    platforms: [
        .iOS(.v26),
        .macOS(.v26),
    ],
    products: [
        .library(name: "CubbyKit", targets: ["CubbyKit"]),
        .executable(name: "cubby", targets: ["cubby"]),
    ],
    dependencies: [
        .package(url: "https://github.com/apple/swift-openapi-generator", exact: "1.13.1"),
        .package(url: "https://github.com/apple/swift-openapi-runtime", from: "1.12.1"),
        .package(url: "https://github.com/apple/swift-openapi-urlsession", from: "1.3.1"),
        .package(url: "https://github.com/apple/swift-argument-parser", from: "1.8.2"),
        .package(url: "https://github.com/apple/swift-async-algorithms", from: "1.1.5"),
        .package(url: "https://github.com/groue/GRDB.swift", from: "7.11.1"),
    ],
    targets: [
        // Rust FFI: the xcframework and the Swift shim in Sources/CubbyFFI are both produced by
        // apps/apple/scripts/build-rust.sh (gitignored). Build order in apps/apple/README.md.
        .binaryTarget(
            name: "CubbyFFIBinary",
            path: "Frameworks/CubbyFFI.xcframework"
        ),
        .target(
            name: "CubbyFFI",
            dependencies: ["CubbyFFIBinary"]
        ),
        // The hand-written types the generated client is configured to use instead of its own
        // (`typeOverrides` in Sources/CubbyAPI/openapi-generator-config.yaml): branded shortcodes
        // and PlainDate. Kept apart from CubbyKit so CubbyAPI can depend on it.
        .target(name: "CubbyAPISupport"),
        // swift-openapi-generator's build plugin generates the typed client from the
        // `openapi.json` and `openapi-generator-config.yaml` that `pnpm generate` writes into
        // Sources/CubbyAPI (both gitignored). Isolated from the hand-written code so an edit to
        // CubbyKit does not recompile ~58k generated lines. Generated symbols are
        // `accessModifier: public`, named outside CubbyAPI only through the generated aliases in
        // CubbyKit/Generated/APITypes.swift.
        .target(
            name: "CubbyAPI",
            dependencies: [
                "CubbyAPISupport",
                .product(name: "OpenAPIRuntime", package: "swift-openapi-runtime"),
            ],
            // The provenance note beside the generated inputs is documentation, not a resource.
            exclude: ["README.md"],
            // Line tables only: nothing here is ever stepped through, and full debug info for
            // ~58k generated lines is what makes LLDB stall on launch (see apps/apple/AGENTS.md's
            // "Debugging on device"). `unsafeFlags` is safe because CubbyKit is only ever
            // consumed as a local path dependency, never as a versioned remote package.
            // -suppress-warnings: the generator spells `package import struct Foundation.URL`
            // for every file, and the compiler warns that no package-level declaration needs
            // it; generated code is regenerated, never fixed by hand, so its warnings are noise.
            swiftSettings: [.unsafeFlags(["-gline-tables-only", "-suppress-warnings"])],
            plugins: [.plugin(name: "OpenAPIGenerator", package: "swift-openapi-generator")]
        ),
        .target(
            name: "CubbyKit",
            dependencies: [
                "CubbyAPI",
                "CubbyAPISupport",
                "CubbyFFI",
                .product(name: "OpenAPIRuntime", package: "swift-openapi-runtime"),
                .product(name: "OpenAPIURLSession", package: "swift-openapi-urlsession"),
                .product(name: "AsyncAlgorithms", package: "swift-async-algorithms"),
                .product(name: "GRDB", package: "GRDB.swift"),
            ]
        ),
        .executableTarget(
            name: "cubby",
            dependencies: [
                "CubbyKit",
                .product(name: "ArgumentParser", package: "swift-argument-parser"),
            ]
        ),
        .testTarget(
            name: "CubbyKitTests",
            dependencies: ["CubbyKit"],
            resources: [.copy("Fixtures")]
        ),
    ],
    swiftLanguageModes: [.v6]
)
