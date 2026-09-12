import ArgumentParser
import CubbyKit
import Foundation

#if canImport(Darwin)
import Darwin
#elseif canImport(Glibc)
import Glibc
#endif

/// A CLI-local error with a plain-text message, printed as-is (no "HTTP ..." framing).
struct CLIError: Error, CustomStringConvertible {
    let description: String

    static func message(_ text: String) -> CLIError {
        CLIError(description: text)
    }
}

/// Shared plumbing for every subcommand's `run()`: uniform error formatting, JSON pretty-printing,
/// and the two stdin prompts `auth login` needs.
enum CLI {
    /// Runs `body`, translating `CubbyAPIError` and `AuthError` into the one-line stderr format
    /// the CLI promises ("HTTP <status> <code>: <message>") and exit code 1. Any other error
    /// (a bad `--json-body`, for instance) is left for ArgumentParser's default reporting.
    static func run(_ body: () async throws -> Void) async throws {
        do {
            try await body()
        } catch let error as CubbyAPIError {
            let code = error.detail?.code ?? "HTTP_ERROR"
            let message = error.detail?.message ?? "Request failed"
            printError("HTTP \(error.status) \(code): \(message)")
            throw ExitCode.failure
        } catch let error as AuthError {
            if case .http(let status, let body) = error {
                printError("HTTP \(status): \(body)")
            } else {
                printError(error.message)
            }
            throw ExitCode.failure
        } catch let error as CLIError {
            printError(error.description)
            throw ExitCode.failure
        }
    }

    static func printError(_ message: String) {
        FileHandle.standardError.write(Data((message + "\n").utf8))
    }

    static func prettyJSON(_ value: JSONValue) throws -> String {
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.prettyPrinted, .sortedKeys, .withoutEscapingSlashes]
        return String(decoding: try encoder.encode(value), as: UTF8.self)
    }

    /// Prompts on stdout and reads one line from stdin. Used for `auth login`'s email prompt,
    /// which (unlike the password) should echo.
    static func readLine(prompt: String) throws -> String {
        print(prompt, terminator: "")
        guard
            let line = Swift.readLine(strippingNewline: true)?.trimmingCharacters(in: .whitespaces),
            !line.isEmpty
        else {
            throw CLIError.message("No input provided for: \(prompt)")
        }
        return line
    }

    /// Reads a password via `getpass(3)`, which disables terminal echo itself — never read a
    /// password with a plain `readLine()`.
    static func readPassword(prompt: String) throws -> String {
        guard let cString = getpass(prompt) else {
            throw CLIError.message("Could not read password.")
        }
        return String(cString: cString)
    }
}
