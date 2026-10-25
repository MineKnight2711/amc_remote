// SwiftDesk privileged input helper (macOS).
//
// A tiny root LaunchDaemon that posts keystrokes for SwiftDesk. At the login window and lock screen,
// a sandboxed GUI app's synthesized keys are dropped by Secure Event Input, but a root daemon posting
// from the HID system event source reaches them — the same approach RustDesk's `service` binary uses.
//
// SwiftDesk connects to a local Unix socket and sends newline-delimited JSON:
//   {"t":"k","vk":8,"down":true,"flags":0}   key by macOS virtual-key code, CGEventFlags raw value
//   {"t":"u","s":"â"}                         type a Unicode string (down+up)
//   {"t":"ping"}                              no-op keepalive
//
// Build + install:  sudo bash scripts/mac-input-helper.sh install
// This process does nothing but inject the keys SwiftDesk sends; it opens no network sockets.

import Foundation
import CoreGraphics
import Darwin

let SOCKET_PATH = "/var/run/com.swiftdesk.inputhelper.sock"

func logLine(_ s: String) {
    FileHandle.standardError.write(Data(("[swiftdesk-input-helper] " + s + "\n").utf8))
}

// One source for the whole process; HID system state is what reaches the secure login window.
let eventSource = CGEventSource(stateID: .hidSystemState)

func postKey(vk: CGKeyCode, down: Bool, flags: UInt64) {
    guard let ev = CGEvent(keyboardEventSource: eventSource, virtualKey: vk, keyDown: down) else { return }
    ev.flags = CGEventFlags(rawValue: flags)
    ev.post(tap: .cghidEventTap)
}

func postText(_ text: String) {
    var utf16 = Array(text.utf16)
    if utf16.isEmpty { return }
    for down in [true, false] {
        guard let ev = CGEvent(keyboardEventSource: eventSource, virtualKey: 0, keyDown: down) else { continue }
        utf16.withUnsafeBufferPointer { buf in
            ev.keyboardSetUnicodeString(stringLength: buf.count, unicodeString: buf.baseAddress)
        }
        ev.post(tap: .cghidEventTap)
    }
}

func handleCommand(_ obj: [String: Any]) {
    guard let t = obj["t"] as? String else { return }
    switch t {
    case "k":
        guard let vk = obj["vk"] as? Int, let down = obj["down"] as? Bool else { return }
        let flags = (obj["flags"] as? NSNumber)?.uint64Value ?? 0
        postKey(vk: CGKeyCode(truncatingIfNeeded: vk), down: down, flags: flags)
    case "u":
        if let s = obj["s"] as? String { postText(s) }
    case "ping":
        break
    default:
        break
    }
}

func serveConnection(_ clientFd: Int32) {
    var buffer = Data()
    let chunkSize = 4096
    var chunk = [UInt8](repeating: 0, count: chunkSize)
    while true {
        let n = read(clientFd, &chunk, chunkSize)
        if n <= 0 { break }
        buffer.append(contentsOf: chunk[0..<n])
        // Process complete newline-delimited JSON lines
        while let nl = buffer.firstIndex(of: 0x0A) {
            let line = buffer.subdata(in: buffer.startIndex..<nl)
            buffer.removeSubrange(buffer.startIndex...nl)
            if line.isEmpty { continue }
            if let obj = (try? JSONSerialization.jsonObject(with: line)) as? [String: Any] {
                handleCommand(obj)
            }
        }
        if buffer.count > 1_000_000 { buffer.removeAll() } // runaway guard
    }
    close(clientFd)
}

func run() {
    unlink(SOCKET_PATH)
    let fd = socket(AF_UNIX, SOCK_STREAM, 0)
    if fd < 0 { logLine("socket() failed"); exit(1) }

    var addr = sockaddr_un()
    addr.sun_family = sa_family_t(AF_UNIX)
    _ = SOCKET_PATH.withCString { cstr in
        withUnsafeMutableBytes(of: &addr.sun_path) { raw in
            let dst = raw.bindMemory(to: CChar.self)
            let len = min(strlen(cstr), dst.count - 1)
            memcpy(dst.baseAddress!, cstr, len)
            dst[len] = 0
        }
    }
    let size = socklen_t(MemoryLayout<sockaddr_un>.size)
    let bound = withUnsafePointer(to: &addr) { ptr in
        ptr.withMemoryRebound(to: sockaddr.self, capacity: 1) { bind(fd, $0, size) }
    }
    if bound < 0 { logLine("bind() failed on \(SOCKET_PATH)"); exit(1) }
    // 0666 so both the root login-window SwiftDesk and the logged-in user's SwiftDesk (at the lock
    // screen) can connect. Local socket on a personal remote-controlled Mac; it only injects input.
    chmod(SOCKET_PATH, 0o666)
    if listen(fd, 4) < 0 { logLine("listen() failed"); exit(1) }
    logLine("listening on \(SOCKET_PATH)")

    while true {
        let clientFd = accept(fd, nil, nil)
        if clientFd < 0 { continue }
        logLine("client connected")
        serveConnection(clientFd) // one SwiftDesk instance at a time; serial is fine
        logLine("client disconnected")
    }
}

run()
