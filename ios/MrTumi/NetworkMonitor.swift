//
//  NetworkMonitor.swift
//  MrTumi
//
//  Monitors real-time network connectivity and triggers auto-reconnects.
//

import Foundation
import Network

class NetworkMonitor: ObservableObject {
    private let monitor = NWPathMonitor()
    private let queue = DispatchQueue(label: "NetworkMonitor")

    @Published var isConnected: Bool = true
    var onConnected: (() -> Void)?

    init() {
        monitor.pathUpdateHandler = { [weak self] path in
            DispatchQueue.main.async {
                let connected = (path.status == .satisfied)
                let wasDisconnected = !(self?.isConnected ?? true)
                self?.isConnected = connected

                // Auto reload as soon as network is restored
                if connected && wasDisconnected {
                    self?.onConnected?()
                }
            }
        }
        monitor.start(queue: queue)
    }

    deinit {
        monitor.cancel()
    }
}
