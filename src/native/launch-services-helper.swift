import AppKit
import CoreServices
import Foundation

struct NativeAppInfo: Codable {
  let bundleId: String?
  let displayName: String
  let appPath: String
  let iconDataUrl: String?
}

struct NativeOpenWithResponse: Codable {
  let defaultApp: NativeAppInfo?
  let apps: [NativeAppInfo]
}

func appInfo(for url: URL) -> NativeAppInfo? {
  let path = url.path
  let bundle = Bundle(url: url)
  let bundleId = bundle?.bundleIdentifier
  let info = bundle?.localizedInfoDictionary ?? bundle?.infoDictionary
  let displayName =
    info?["CFBundleDisplayName"] as? String
    ?? info?["CFBundleName"] as? String
    ?? FileManager.default.displayName(atPath: path).replacingOccurrences(of: ".app", with: "")
  return NativeAppInfo(
    bundleId: bundleId,
    displayName: normalizeDisplayName(displayName, appPath: path),
    appPath: path,
    iconDataUrl: iconDataUrl(forAppAt: path)
  )
}

func normalizeDisplayName(_ name: String, appPath: String) -> String {
  let trimmed = name.trimmingCharacters(in: .whitespacesAndNewlines)
  if trimmed.lowercased() == "wpsoffice" {
    return "WPS Office"
  }
  if trimmed.isEmpty {
    return URL(fileURLWithPath: appPath).deletingPathExtension().lastPathComponent
  }
  return trimmed
}

func iconDataUrl(forAppAt path: String) -> String? {
  let image = NSWorkspace.shared.icon(forFile: path)
  let size = NSSize(width: 64, height: 64)
  guard let bitmap = NSBitmapImageRep(
    bitmapDataPlanes: nil,
    pixelsWide: Int(size.width),
    pixelsHigh: Int(size.height),
    bitsPerSample: 8,
    samplesPerPixel: 4,
    hasAlpha: true,
    isPlanar: false,
    colorSpaceName: .deviceRGB,
    bytesPerRow: 0,
    bitsPerPixel: 0
  ) else {
    return nil
  }
  bitmap.size = size
  NSGraphicsContext.saveGraphicsState()
  NSGraphicsContext.current = NSGraphicsContext(bitmapImageRep: bitmap)
  image.draw(in: NSRect(origin: .zero, size: size), from: .zero, operation: .sourceOver, fraction: 1)
  NSGraphicsContext.restoreGraphicsState()
  guard let pngData = bitmap.representation(using: .png, properties: [:])
  else {
    return nil
  }
  return "data:image/png;base64,\(pngData.base64EncodedString())"
}

func defaultApplication(for fileUrl: URL) -> URL? {
  if #available(macOS 10.15, *) {
    return NSWorkspace.shared.urlForApplication(toOpen: fileUrl)
  }
  var error: Unmanaged<CFError>?
  guard let appUrl = LSCopyDefaultApplicationURLForURL(fileUrl as CFURL, .all, &error)?.takeRetainedValue() else {
    return nil
  }
  return appUrl as URL
}

func applications(for fileUrl: URL) -> [URL] {
  guard let appUrls = LSCopyApplicationURLsForURL(fileUrl as CFURL, .all)?.takeRetainedValue() as? [URL] else {
    return []
  }
  return appUrls
}

func uniqueApps(_ apps: [NativeAppInfo]) -> [NativeAppInfo] {
  var seen = Set<String>()
  var result: [NativeAppInfo] = []
  for app in apps {
    let key = app.bundleId ?? app.appPath
    if seen.contains(key) {
      continue
    }
    seen.insert(key)
    result.append(app)
  }
  return result
}

func writeJson<T: Encodable>(_ value: T) {
  let encoder = JSONEncoder()
  encoder.outputFormatting = [.withoutEscapingSlashes]
  guard let data = try? encoder.encode(value), let json = String(data: data, encoding: .utf8) else {
    FileHandle.standardOutput.write(Data("{}".utf8))
    return
  }
  FileHandle.standardOutput.write(Data(json.utf8))
}

let args = CommandLine.arguments
guard args.count >= 2 else {
  writeJson(NativeOpenWithResponse(defaultApp: nil, apps: []))
  exit(0)
}

let fileUrl = URL(fileURLWithPath: args[1])
let defaultApp = defaultApplication(for: fileUrl).flatMap(appInfo)
let allApps = uniqueApps(applications(for: fileUrl).compactMap(appInfo))
writeJson(NativeOpenWithResponse(defaultApp: defaultApp, apps: allApps))
