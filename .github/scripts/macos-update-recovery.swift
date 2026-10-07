// screenpipe — AI that knows everything you've seen, said, or heard
// https://screenpipe.com

import Cocoa
import Security
import UniformTypeIdentifiers

// This companion is deliberately a separate app: Finder may send Reopen only
// to the old Screenpipe process when its bundle was replaced at the same path.
// It never terminates that process. The selected app owns authenticated handoff.
private let validationFlags = SecCSFlags(rawValue: kSecCSStrictValidate | kSecCSCheckNestedCode)

private func checked(_ status: OSStatus, _ operation: String) throws {
    if status != errSecSuccess {
        let message = SecCopyErrorMessageString(status, nil) as String? ?? "Unknown signing error"
        throw NSError(domain: "ScreenpipeUpdateRecovery", code: Int(status),
                      userInfo: [NSLocalizedDescriptionKey: "\(operation): \(message) (\(status))"])
    }
}

private func verifiedCode(_ url: URL, requirement: SecRequirement? = nil) throws -> SecStaticCode {
    var code: SecStaticCode?
    try checked(SecStaticCodeCreateWithPath(url as CFURL, [], &code), "Read app signature")
    guard let code else { throw CocoaError(.fileReadCorruptFile) }
    try checked(SecStaticCodeCheckValidity(code, validationFlags, requirement), "Verify app signature")
    return code
}

private func signingInfo(_ code: SecStaticCode) throws -> [String: Any] {
    var info: CFDictionary?
    try checked(SecCodeCopySigningInformation(code, SecCSFlags(rawValue: kSecCSSigningInformation), &info),
                "Read signed app identity")
    return info as? [String: Any] ?? [:]
}

final class RecoveryDelegate: NSObject, NSApplicationDelegate {
    private var target = "not_selected"
    private var targetHash = "unknown"
    private var targetVersion = "unknown"
    private var source = "unknown"
    private var stage = "recovery_validation"

    // One bounded receipt, replaced atomically. Support collection prioritizes
    // update-recovery.log alongside update-install.log, even after log rotation.
    private func record(_ outcome: String, _ detail: String) {
        let environment = ProcessInfo.processInfo.environment
        let root = environment["SCREENPIPE_DATA_DIR"].flatMap { $0.isEmpty ? nil : URL(fileURLWithPath: $0) }
            ?? FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent(".screenpipe")
        let line = "\(ISO8601DateFormatter().string(from: Date())) manual_recovery: stage=\(stage); source=\(source); target=\(target); target_version=\(targetVersion); target_hash=\(targetHash); outcome=\(outcome); cause=\(detail)\n"
        do {
            try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true,
                                                   attributes: [.posixPermissions: 0o700])
            let receipt = root.appendingPathComponent("update-recovery.log")
            // Atomic replacement cannot follow an existing receipt symlink.
            try Data(line.prefix(4096).utf8).write(to: receipt, options: .atomic)
            try FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: receipt.path)
        } catch {
            NSLog("Screenpipe recovery diagnostic could not be saved: %@", error.localizedDescription)
        }
    }

    private func fail(_ error: Error) {
        record("selected_copy_not_started", error.localizedDescription)
        let alert = NSAlert()
        alert.messageText = "Couldn’t open this Screenpipe copy"
        alert.informativeText = error.localizedDescription
        alert.addButton(withTitle: "OK")
        alert.runModal()
        NSApp.terminate(nil)
    }

    func applicationDidFinishLaunching(_ notification: Notification) {
        NSApp.setActivationPolicy(.accessory)
        NSApp.activate(ignoringOtherApps: true)
        do {
            let own = try verifiedCode(Bundle.main.bundleURL)
            let ownInfo = try signingInfo(own)
            let sourceID = ownInfo[kSecCodeInfoIdentifier as String] as? String ?? "unknown"
            let sourceHash = (ownInfo[kSecCodeInfoUnique as String] as? Data)?.map { String(format: "%02x", $0) }.joined() ?? "unknown"
            source = "\(sourceID),version=\(Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") ?? "unknown"),hash=\(sourceHash)"
            // This requirement is sealed into the companion when it is built
            // from the signed app. It retains the app's edition and publisher.
            guard let requirementText = Bundle.main.object(forInfoDictionaryKey: "ScreenpipeTargetRequirement") as? String else {
                throw CocoaError(.fileReadCorruptFile)
            }
            var requirement: SecRequirement?
            try checked(SecRequirementCreateWithString(requirementText as CFString, [], &requirement),
                        "Read expected Screenpipe signing identity")
            guard let requirement else { throw CocoaError(.fileReadCorruptFile) }

            let panel = NSOpenPanel()
            panel.title = "Open updated Screenpipe"
            panel.message = "Quit Screenpipe first, then choose the updated app. It will open from its current location."
            panel.prompt = "Open update"
            panel.allowedContentTypes = [.applicationBundle]
            panel.canChooseDirectories = false
            panel.allowsMultipleSelection = false
            panel.treatsFilePackagesAsDirectories = false
            let downloadDirectory = Bundle.main.bundleURL.deletingLastPathComponent()
            let bundleName = Bundle.main.object(forInfoDictionaryKey: "ScreenpipeTargetBundleName") as? String ?? "screenpipe.app"
            let bundledApp = downloadDirectory.appendingPathComponent(bundleName)
            panel.directoryURL = FileManager.default.fileExists(atPath: bundledApp.path)
                ? downloadDirectory : URL(fileURLWithPath: "/Applications")
            guard panel.runModal() == .OK, let selected = panel.url else {
                record("cancelled", "user_cancelled")
                NSApp.terminate(nil)
                return
            }
            let url = selected.resolvingSymlinksInPath()
            target = url.path
            let info = try signingInfo(verifiedCode(url, requirement: requirement))
            let signedPlist = info[kSecCodeInfoPList as String] as? [String: Any]
            targetVersion = signedPlist?["CFBundleShortVersionString"] as? String ?? "unknown"
            guard let protocolVersion = signedPlist?["ScreenpipeManualHandoffProtocol"] as? Int,
                  protocolVersion == Bundle.main.object(forInfoDictionaryKey: "ScreenpipeManualHandoffProtocol") as? Int else {
                throw NSError(domain: "ScreenpipeUpdateRecovery", code: 1, userInfo: [
                    NSLocalizedDescriptionKey: "This is an older Screenpipe copy. Choose the updated app included with this download."
                ])
            }
            guard let hash = info[kSecCodeInfoUnique as String] as? Data else {
                throw CocoaError(.fileReadCorruptFile)
            }
            targetHash = hash.map { String(format: "%02x", $0) }.joined()
            let configuration = NSWorkspace.OpenConfiguration()
            configuration.createsNewApplicationInstance = true
            configuration.activates = true
            // The selected process rechecks this hash before any ownership
            // transfer, closing replacement races after the chooser verified it.
            configuration.environment = ["SCREENPIPE_MANUAL_HANDOFF_BUILD": targetHash]
            if let dataDirectory = ProcessInfo.processInfo.environment["SCREENPIPE_DATA_DIR"], !dataDirectory.isEmpty {
                configuration.environment["SCREENPIPE_DATA_DIR"] = dataDirectory
            }
            stage = "recovery_launch"
            record("launch_requested", "none")
            NSWorkspace.shared.openApplication(at: url, configuration: configuration) { app, error in
                DispatchQueue.main.async {
                    if let error { self.fail(error); return }
                    self.record("process_started", "pid=\(app?.processIdentifier ?? 0); authenticated_handoff_pending")
                    NSApp.terminate(nil)
                }
            }
        } catch { fail(error) }
    }
}

let application = NSApplication.shared
let delegate = RecoveryDelegate()
application.delegate = delegate
application.run()
