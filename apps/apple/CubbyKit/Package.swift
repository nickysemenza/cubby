// swift-tools-version: 6.4
import PackageDescription

let package = Package(
    name: "CubbyKit",
    platforms: [
        .iOS(.v27),
        .macOS(.v27),
    ],
    products: [
        .library(name: "CubbyKit", targets: ["CubbyKit"]),
        .executable(name: "cubby", targets: ["cubby"]),
    ],
    dependencies: [
        .package(url: "https://github.com/apple/swift-http-types", from: "1.8.0"),
        .package(url: "https://github.com/apple/swift-argument-parser", from: "1.8.2"),
        .package(url: "https://github.com/apple/swift-async-algorithms", from: "1.1.7"),
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
        // Shared codecs and branded identifiers used by the plain generated native models.
        .target(name: "CubbyAPISupport"),
        // `pnpm generate` emits Models/*.gen.swift. Keep them in their own module so
        // handwritten CubbyKit edits do not recompile these model declarations.
        .target(
            name: "CubbyAPI",
            dependencies: [
                "CubbyAPISupport"
            ],
            // The provenance note beside the generated inputs is documentation, not a resource.
            exclude: ["README.md"],
            // Line tables only: nothing here is ever stepped through, and full debug info for
            // the generated client is what makes LLDB stall on launch (see apps/apple/AGENTS.md's
            // "Debugging on device"). `unsafeFlags` is safe because CubbyKit is only ever
            // consumed as a local path dependency, never as a versioned remote package.
            // Forward to the frontend so the driver's later default -g cannot override this.
            swiftSettings: [.unsafeFlags(["-Xfrontend", "-gline-tables-only"])]
        ),
        .target(
            name: "CubbyKit",
            dependencies: [
                "CubbyAPI",
                "CubbyAPISupport",
                "CubbyFFI",
                .product(name: "HTTPTypes", package: "swift-http-types"),
                .product(name: "AsyncAlgorithms", package: "swift-async-algorithms"),
                .product(name: "GRDB", package: "GRDB.swift"),
            ],
            // `EntityCatalog`'s descriptors and the native coverage record, written by
            // `pnpm generate` (gitignored) and decoded by the descriptor types in
            // Generated/EntityDescriptors.swift and Manifest/NativeCoverage.swift.
            resources: [
                .copy("Generated/entity-kernel.json"),
                .copy("Generated/entity-manifest.json"),
                .copy("Generated/native-coverage.json"),
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
