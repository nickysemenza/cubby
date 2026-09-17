import Foundation

/// Git identity stamped into the built app by `embed-build-metadata.sh`.
struct AppBuildMetadata: Equatable {
    static let current = load()

    let branch: String
    let commit: String
    let subject: String

    var commitURL: URL? {
        guard commit != Self.unavailable else { return nil }
        return URL(string: "https://github.com/nickysemenza/cubby/commit/\(commit)")
    }

    init(dictionary: [String: Any]?) {
        branch = Self.value(for: "branch", in: dictionary)
        commit = Self.value(for: "commit", in: dictionary)
        subject = Self.value(for: "subject", in: dictionary)
    }

    private static let unavailable = "Unavailable"

    static func load(bundle: Bundle = .main) -> AppBuildMetadata {
        guard let url = bundle.url(forResource: "BuildMetadata", withExtension: "plist"),
            let data = try? Data(contentsOf: url),
            let dictionary = try? PropertyListSerialization.propertyList(from: data, format: nil)
                as? [String: Any]
        else {
            return AppBuildMetadata(dictionary: nil)
        }
        return AppBuildMetadata(dictionary: dictionary)
    }

    private static func value(for key: String, in dictionary: [String: Any]?) -> String {
        guard let value = dictionary?[key] as? String else { return unavailable }
        let trimmed = value.trimmingCharacters(in: .whitespacesAndNewlines)
        return trimmed.isEmpty ? unavailable : trimmed
    }
}
