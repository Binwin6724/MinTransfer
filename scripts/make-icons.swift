// Renders the MinTransfer app icon with AppKit.
//   swift scripts/make-icons.swift build
import AppKit

let out = CommandLine.arguments.count > 1 ? CommandLine.arguments[1] : "build"

func save(_ img: NSImage, _ path: String, _ px: Int) {
  let rep = NSBitmapImageRep(bitmapDataPlanes: nil, pixelsWide: px, pixelsHigh: px, bitsPerSample: 8,
                             samplesPerPixel: 4, hasAlpha: true, isPlanar: false, colorSpaceName: .deviceRGB,
                             bytesPerRow: 0, bitsPerPixel: 0)!
  rep.size = NSSize(width: px, height: px)
  NSGraphicsContext.saveGraphicsState()
  NSGraphicsContext.current = NSGraphicsContext(bitmapImageRep: rep)
  img.draw(in: NSRect(x: 0, y: 0, width: px, height: px))
  NSGraphicsContext.restoreGraphicsState()
  try! rep.representation(using: .png, properties: [:])!.write(to: URL(fileURLWithPath: path))
}

func appIcon(_ s: CGFloat) -> NSImage {
  NSImage(size: NSSize(width: s, height: s), flipped: false) { _ in
    let inset = s * 0.1
    let rect = NSRect(x: inset, y: inset, width: s - 2 * inset, height: s - 2 * inset)
    let bg = NSBezierPath(roundedRect: rect, xRadius: s * 0.2, yRadius: s * 0.2)
    NSGraphicsContext.current?.saveGraphicsState()
    let shadow = NSShadow()
    shadow.shadowBlurRadius = s * 0.03
    shadow.shadowOffset = NSSize(width: 0, height: -s * 0.012)
    shadow.shadowColor = NSColor.black.withAlphaComponent(0.35)
    shadow.set()
    NSGradient(colors: [NSColor(red: 0.06, green: 0.09, blue: 0.16, alpha: 1), NSColor(red: 0.07, green: 0.14, blue: 0.22, alpha: 1)])!.draw(in: bg, angle: -60)
    NSGraphicsContext.current?.restoreGraphicsState()
    bg.addClip()
    NSGradient(colors: [NSColor(red: 0.18, green: 0.5, blue: 1, alpha: 0.45), NSColor.clear])!
      .draw(fromCenter: NSPoint(x: s * 0.35, y: s * 0.65), radius: 0, toCenter: NSPoint(x: s * 0.35, y: s * 0.65), radius: s * 0.5, options: [])
    NSGradient(colors: [NSColor(red: 0.08, green: 0.83, blue: 0.63, alpha: 0.35), NSColor.clear])!
      .draw(fromCenter: NSPoint(x: s * 0.7, y: s * 0.3), radius: 0, toCenter: NSPoint(x: s * 0.7, y: s * 0.3), radius: s * 0.45, options: [])
    let grad = NSGradient(colors: [NSColor(red: 0.18, green: 0.5, blue: 1, alpha: 1), NSColor(red: 0.08, green: 0.83, blue: 0.63, alpha: 1)])!
    // Phone
    let phone = NSRect(x: s * 0.27, y: s * 0.24, width: s * 0.27, height: s * 0.48)
    let phonePath = NSBezierPath(roundedRect: phone, xRadius: s * 0.05, yRadius: s * 0.05)
    phonePath.lineWidth = s * 0.028
    NSColor.white.withAlphaComponent(0.92).setStroke()
    phonePath.stroke()
    let speaker = NSBezierPath(roundedRect: NSRect(x: phone.midX - s * 0.035, y: phone.maxY - s * 0.06, width: s * 0.07, height: s * 0.016), xRadius: s * 0.008, yRadius: s * 0.008)
    NSColor.white.withAlphaComponent(0.92).setFill()
    speaker.fill()
    // Arrows (transfer)
    func arrow(y: CGFloat, right: Bool) {
      let x0 = s * 0.5, x1 = s * 0.76
      let p = NSBezierPath()
      p.lineWidth = s * 0.05
      p.lineCapStyle = .round
      p.lineJoinStyle = .round
      let head = s * 0.06
      if right {
        p.move(to: NSPoint(x: x0, y: y)); p.line(to: NSPoint(x: x1, y: y))
        p.move(to: NSPoint(x: x1 - head, y: y + head)); p.line(to: NSPoint(x: x1, y: y)); p.line(to: NSPoint(x: x1 - head, y: y - head))
      } else {
        p.move(to: NSPoint(x: x1, y: y)); p.line(to: NSPoint(x: x0, y: y))
        p.move(to: NSPoint(x: x0 + head, y: y + head)); p.line(to: NSPoint(x: x0, y: y)); p.line(to: NSPoint(x: x0 + head, y: y - head))
      }
      NSGraphicsContext.current?.saveGraphicsState()
      let stroked = p.copy() as! NSBezierPath
      let cg = stroked.cgPath.copy(strokingWithWidth: s * 0.05, lineCap: .round, lineJoin: .round, miterLimit: 10)
      let ctx = NSGraphicsContext.current!.cgContext
      ctx.addPath(cg)
      ctx.clip()
      grad.draw(in: NSRect(x: x0 - head, y: y - head * 1.5, width: x1 - x0 + head * 2, height: head * 3), angle: 0)
      NSGraphicsContext.current?.restoreGraphicsState()
    }
    arrow(y: s * 0.56, right: true)
    arrow(y: s * 0.40, right: false)
    return true
  }
}

save(appIcon(1024), "\(out)/icon.png", 1024)
print("✓ icon written to \(out)/icon.png")
