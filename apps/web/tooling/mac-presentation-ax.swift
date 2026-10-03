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
  guard AXUIElementCopyAttributeValue(element, key as CFString, &value) == .success else {
    return nil
  }
  return value
}

func elements(_ value: CFTypeRef?) -> [AXUIElement] {
  guard let value else { return [] }
  if CFGetTypeID(value) == AXUIElementGetTypeID() {
    return [unsafeBitCast(value, to: AXUIElement.self)]
  }
  return value as? [AXUIElement] ?? []
}

func descendants(_ element: AXUIElement, matching predicate: (AXUIElement) -> Bool) -> [AXUIElement]
{
  var visited: [AXUIElement] = []
  var result: [AXUIElement] = []
  func visit(_ current: AXUIElement, depth: Int) {
    guard !visited.contains(where: { CFEqual($0, current) }) else { return }
    guard depth < 32, visited.count < 4096 else { fatalError("Owned AX traversal limit exceeded") }
    visited.append(current)
    if predicate(current) { result.append(current) }
    for key in [kAXChildrenAttribute, "AXContents", kAXVisibleChildrenAttribute] {
      for child in elements(attribute(current, key)) { visit(child, depth: depth + 1) }
    }
  }
  visit(element, depth: 0)
  return result
}

if arguments[1] == "snapshot" {
  let popovers = descendants(AXUIElementCreateApplication(pid)) {
    attribute($0, kAXRoleAttribute) as? String == "AXPopover"
  }
  var nodes: [[String: Any]] = []
  for popover in popovers {
    for element in descendants(popover, matching: { _ in true }) {
      guard nodes.count < 512 else { fatalError("Owned popover snapshot limit exceeded") }
      var node: [String: Any] = ["index": nodes.count, "bundleId": "com.nickysemenza.cubby.e2e"]
      for (name, key) in [
        ("role", kAXRoleAttribute), ("subrole", kAXSubroleAttribute),
        ("identifier", kAXIdentifierAttribute), ("value", kAXValueAttribute),
      ] {
        if let value = attribute(element, key) as? String { node[name] = value }
      }
      node["label"] =
        attribute(element, kAXTitleAttribute) as? String
        ?? attribute(element, kAXDescriptionAttribute) as? String
        ?? attribute(element, kAXValueAttribute) as? String
      if let enabled = attribute(element, kAXEnabledAttribute) as? Bool {
        node["enabled"] = enabled
      }
      if let position = attribute(element, kAXPositionAttribute),
        let size = attribute(element, kAXSizeAttribute),
        CFGetTypeID(position) == AXValueGetTypeID(), CFGetTypeID(size) == AXValueGetTypeID()
      {
        var point = CGPoint.zero
        var dimensions = CGSize.zero
        if AXValueGetValue(unsafeBitCast(position, to: AXValue.self), .cgPoint, &point),
          AXValueGetValue(unsafeBitCast(size, to: AXValue.self), .cgSize, &dimensions),
          [point.x, point.y, dimensions.width, dimensions.height].allSatisfy({ $0.isFinite })
        {
          node["rect"] = [
            "x": point.x, "y": point.y,
            "width": dimensions.width, "height": dimensions.height,
          ]
        }
      }
      nodes.append(node)
    }
  }
  let data = try JSONSerialization.data(withJSONObject: nodes, options: [.sortedKeys])
  print(String(data: data, encoding: .utf8)!)
  exit(0)
}

let containers = descendants(AXUIElementCreateApplication(pid)) {
  attribute($0, kAXIdentifierAttribute) as? String == arguments[4]
}
guard containers.count == 1 else {
  fatalError("Expected one owned AX container; found \(containers.count)")
}
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
  var actionNames: CFArray?
  _ = AXUIElementCopyActionNames(buttons[0], &actionNames)
  let actions = actionNames as? [String] ?? []
  let action = actions.contains(kAXPressAction) ? kAXPressAction : kAXShowMenuAction
  status = AXUIElementPerformAction(buttons[0], action as CFString)
case "fill":
  guard attribute(containers[0], kAXRoleAttribute) as? String == kAXTextFieldRole,
    attribute(containers[0], kAXEnabledAttribute) as? Bool != false
  else { fatalError("Expected one enabled owned AX text field") }
  status = AXUIElementSetAttributeValue(
    containers[0], kAXValueAttribute as CFString, arguments[5] as CFString)
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
if arguments[1] == "press", status == .attributeUnsupported || status == .actionUnsupported {
  print("Owned AX button does not support press or menu input")
  exit(2)
}
guard status == .success else { fatalError("Presentation AX action failed: \(status.rawValue)") }
print("\(arguments[1]) succeeded in owned container \(arguments[4])")
