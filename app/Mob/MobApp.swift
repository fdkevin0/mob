import SwiftUI

@main
struct MobApp: App {
    var body: some Scene {
        WindowGroup {
            DeliberationScreen()
        }
        #if os(macOS)
        .defaultSize(width: 720, height: 800)
        #endif
    }
}
