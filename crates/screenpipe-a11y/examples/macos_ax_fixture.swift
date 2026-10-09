// screenpipe — AI that knows everything you've seen, said, or heard
// https://screenpipe.com
// Static AX provider for the live_child_batch_parity Rust evaluation.
// Run with `swift crates/screenpipe-a11y/examples/macos_ax_fixture.swift`, then
// pass its PID as SCREENPIPE_AX_BENCH_PID to that ignored test. Stop with Ctrl-C.
// No visible windows, app activation, user content, or changes to other apps.

import AppKit

let app = NSApplication.shared
app.setActivationPolicy(.prohibited)
let root = NSAccessibilityElement()
root.setAccessibilityRole(.window)
root.setAccessibilityLabel("Screenpipe AX fixture")
root.setAccessibilityFrame(NSRect(x: 0, y: 0, width: 1000, height: 1000))
root.setAccessibilityParent(app)
var children: [NSAccessibilityElement] = []
for index in 0..<1000 {
    let node = NSAccessibilityElement()
    node.setAccessibilityRole(index % 2 == 0 ? .staticText : .button)
    node.setAccessibilityLabel("Fixture row \(index)")
    node.setAccessibilityValue("Fixture value \(index)")
    node.setAccessibilityIdentifier("fixture-\(index)")
    node.setAccessibilityFrame(NSRect(x: 10, y: index * 20, width: 100, height: 15))
    node.setAccessibilityParent(root)
    children.append(node)
}
root.setAccessibilityChildren(children)
app.setAccessibilityChildren([root])
app.setAccessibilityWindows([root])
print("fixture_pid=\(getpid())")
fflush(stdout)
app.run()
