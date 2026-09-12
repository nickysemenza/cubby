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
        .package(url: "https://github.com/apple/swift-openapi-runtime", from: "1.8.0"),
        .package(url: "https://github.com/apple/swift-openapi-urlsession", from: "1.1.0"),
        .package(url: "https://github.com/apple/swift-argument-parser", from: "1.5.0"),
    ],
    targets: [
        // Rust FFI: the xcframework is produced by apps/apple/scripts/build-rust.sh (gitignored);
        // the Swift shim in Sources/CubbyFFI is committed. Build order in apps/apple/README.md.
        .binaryTarget(
            name: "CubbyFFIBinary",
            path: "Frameworks/CubbyFFI.xcframework"
        ),
        .target(
            name: "CubbyFFI",
            dependencies: ["CubbyFFIBinary"]
        ),
        .target(
            name: "CubbyKit",
            dependencies: [
                "CubbyFFI",
                .product(name: "OpenAPIRuntime", package: "swift-openapi-runtime"),
                .product(name: "OpenAPIURLSession", package: "swift-openapi-urlsession"),
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
