//
//  PushNotificationService.swift
//  MrTumi
//
//  Registers APNs tokens and handles push notifications with backend.
//

import Foundation

class PushNotificationService {
    static let shared = PushNotificationService()
    private init() {}

    func registerDeviceToken(token: String, platform: String = "ios", topic: String = "customer_offers") {
        guard let url = URL(string: "https://mrtumi.com/api/device/register-token") else { return }

        var request = URLRequest(url: url)
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")

        let payload: [String: Any] = [
            "token": token,
            "platform": platform,
            "appType": "customer",
            "topic": topic
        ]

        do {
            request.httpBody = try JSONSerialization.data(withJSONObject: payload)
            URLSession.shared.dataTask(with: request) { data, response, error in
                if let error = error {
                    print("[MrTumi Push] Token registration failed: \(error.localizedDescription)")
                    return
                }
                if let httpResponse = response as? HTTPURLResponse, httpResponse.statusCode == 200 {
                    print("[MrTumi Push] Device token successfully registered with backend.")
                }
            }.resume()
        } catch {
            print("[MrTumi Push] Serialization error: \(error.localizedDescription)")
        }
    }
}
