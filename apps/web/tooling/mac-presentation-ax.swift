import AppKit
import ApplicationServices
import Foundation

let arguments = CommandLine.arguments
guard arguments.count == 6, let pid = pid_t(arguments[2]),
    let app = NSRunningApplication(processIdentifier: pid),
    app.bundleIdentifier == "com.nickysemenza.cubby.e2e",
    app.bundleURL?.path == arguments[3],
    NSWorkspace.shared.frontmostApplication?.processIdentifier == pid
else { fatalError("Presentation action requires the foreground isolated fixture") }

func attribute(_ element: AXUIElement, _ key: String) -> CFTypeRef? {
    var value: CFTypeRef?
    guard AXUIElementCopyAttributeValue(element, key as CFString, &value) == .success else { return nil }
    return value
}

func descendants(_ element: AXUIElement, matching predicate: (AXUIElement) -> Bool) -> [AXUIElement] {
    var result = predicate(element) ? [element] : []
    for child in attribute(element, kAXChildrenAttribute) as? [AXUIElement] ?? [] {
        result += descendants(child, matching: predicate)
    }
    return result
}

let containers = descendants(AXUIElementCreateApplication(pid)) {
    attribute($0, kAXIdentifierAttribute) as? String == arguments[4]
}
guard containers.count == 1 else { fatalError("Expected one owned AX container; found \(containers.count)") }
let status: AXError
switch arguments[1] {
case "press":
    let buttons = descendants(containers[0]) {
        attribute($0, kAXIdentifierAttribute) as? String == arguments[5]
            && attribute($0, kAXRoleAttribute) as? String == kAXButtonRole
            && attribute($0, kAXEnabledAttribute) as? Bool != false
    }
    guard buttons.count == 1 else {
        fatalError("Expected one enabled scoped AX button; found \(buttons.count)")
    }
    status = AXUIElementPerformAction(buttons[0], kAXPressAction as CFString)
case "scroll":
    let bars = descendants(containers[0]) {
        attribute($0, kAXRoleAttribute) as? String == kAXScrollBarRole
            && attribute($0, kAXOrientationAttribute) as? String == kAXVerticalOrientationValue
    }
    guard bars.count == 1, let amount = Double(arguments[5]), abs(amount) <= 1,
        let current = attribute(bars[0], kAXValueAttribute) as? NSNumber
    else { fatalError("Expected one owned vertical AX scroll bar and bounded amount") }
    status = AXUIElementSetAttributeValue(
        bars[0], kAXValueAttribute as CFString,
        NSNumber(value: min(1, max(0, current.doubleValue + amount)))
    )
default: fatalError("Unsupported presentation AX action")
}
guard status == .success else { fatalError("Presentation AX action failed: \(status.rawValue)") }
print("\(arguments[1]) succeeded in owned container \(arguments[4])")
