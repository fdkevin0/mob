import Foundation
import Network
import os

/// Default `CommandRunner`: spawns a child process and captures its stdout.
///
/// This is the production driver behind `ContainerBackendSupervisor`; tests inject
/// a fake `CommandRunner` instead, so this concrete type is never exercised in the
/// deterministic test suite.
public struct ProcessCommandRunner: CommandRunner {
    public init() {}

    public func run(_ executable: String, _ arguments: [String]) async throws -> (Int32, String) {
        try await withCheckedThrowingContinuation { continuation in
            let process = Process()
            process.executableURL = URL(fileURLWithPath: executable)
            process.arguments = arguments

            let pipe = Pipe()
            process.standardOutput = pipe
            process.standardError = pipe

            // Read the pipe before waiting so a large output can't deadlock the
            // child against a full pipe buffer.
            process.terminationHandler = { proc in
                let data = pipe.fileHandleForReading.readDataToEndOfFile()
                let output = String(decoding: data, as: UTF8.self)
                continuation.resume(returning: (proc.terminationStatus, output))
            }

            do {
                try process.run()
            } catch {
                continuation.resume(throwing: error)
            }
        }
    }
}

/// Default `ReachabilityProbe`: opens a TCP connection and reports whether it
/// reaches the `ready` state, used to health-check the backend's gRPC port.
///
/// Like `ProcessCommandRunner`, this is the production probe; supervisor tests
/// inject a fake to stay deterministic and offline.
public struct TCPReachabilityProbe: ReachabilityProbe {
    private let timeout: Duration

    public init(timeout: Duration = .seconds(2)) {
        self.timeout = timeout
    }

    public func isReachable(host: String, port: Int) async -> Bool {
        guard let nwPort = NWEndpoint.Port(rawValue: UInt16(port)) else { return false }
        let endpoint = NWEndpoint.hostPort(host: NWEndpoint.Host(host), port: nwPort)
        let connection = NWConnection(to: endpoint, using: .tcp)

        return await withTaskGroup(of: Bool.self) { group in
            group.addTask {
                await withCheckedContinuation { (continuation: CheckedContinuation<Bool, Never>) in
                    // `resumed` guards the single-shot continuation against the
                    // state handler firing more than once.
                    let resumed = OSAllocatedUnfairLock(initialState: false)
                    let finish: @Sendable (Bool) -> Void = { reachable in
                        let alreadyResumed = resumed.withLock { done -> Bool in
                            if done { return true }
                            done = true
                            return false
                        }
                        guard !alreadyResumed else { return }
                        connection.cancel()
                        continuation.resume(returning: reachable)
                    }
                    connection.stateUpdateHandler = { state in
                        switch state {
                        case .ready:
                            finish(true)
                        case .failed, .cancelled:
                            finish(false)
                        default:
                            break
                        }
                    }
                    connection.start(queue: .global())
                }
            }
            group.addTask { [timeout] in
                try? await Task.sleep(for: timeout)
                return false
            }

            // First result wins (either readiness/failure or the timeout).
            let result = await group.next() ?? false
            group.cancelAll()
            connection.cancel()
            return result
        }
    }
}
