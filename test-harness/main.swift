import Cocoa

final class HarnessDelegate: NSObject, NSApplicationDelegate, NSTextFieldDelegate {
    private var window: NSWindow!
    private var status: NSTextField!
    private var input: NSTextField!
    private var selectionField: NSTextField!
    private var slider: NSSlider!
    private var scrollView: NSScrollView!
    private var keyMonitor: Any?
    private let harnessName: String

    override init() {
        self.harnessName = Bundle.main.object(forInfoDictionaryKey: "CFBundleDisplayName") as? String ?? "CUA Harness"
        super.init()
    }

    func applicationDidFinishLaunching(_ notification: Notification) {
        let frame = NSRect(x: 0, y: 0, width: 640, height: 620)
        window = NSWindow(
            contentRect: frame,
            styleMask: [.titled, .closable, .miniaturizable, .resizable],
            backing: .buffered,
            defer: false
        )
        window.title = harnessName
        window.center()

        let root = NSStackView()
        root.orientation = .vertical
        root.alignment = .leading
        root.spacing = 12
        root.edgeInsets = NSEdgeInsets(top: 20, left: 20, bottom: 20, right: 20)
        root.translatesAutoresizingMaskIntoConstraints = false

        status = label("RESET", identifier: "status")
        status.font = NSFont.monospacedSystemFont(ofSize: 16, weight: .bold)
        status.setAccessibilityLabel("Harness status")
        root.addArrangedSubview(status)

        let clickButton = NSButton(title: "Click Target", target: self, action: #selector(clickTarget))
        clickButton.identifier = NSUserInterfaceItemIdentifier("click-target")
        clickButton.setAccessibilityLabel("Click target")
        root.addArrangedSubview(clickButton)

        let secondary = NSButton(title: "Secondary Target", target: self, action: #selector(secondaryPrimary))
        secondary.identifier = NSUserInterfaceItemIdentifier("secondary-target")
        secondary.setAccessibilityLabel("Secondary target")
        let menu = NSMenu(title: "Secondary Actions")
        menu.addItem(withTitle: "Mark Secondary", action: #selector(markSecondary), keyEquivalent: "")
        menu.items.first?.target = self
        secondary.menu = menu
        root.addArrangedSubview(secondary)

        input = NSTextField(string: "")
        input.placeholderString = "Type here"
        input.identifier = NSUserInterfaceItemIdentifier("type-field")
        input.setAccessibilityLabel("Type field")
        input.delegate = self
        input.widthAnchor.constraint(equalToConstant: 560).isActive = true
        root.addArrangedSubview(input)

        selectionField = NSTextField(string: "alpha select-me omega")
        selectionField.identifier = NSUserInterfaceItemIdentifier("selection-field")
        selectionField.setAccessibilityLabel("Selection field")
        selectionField.delegate = self
        selectionField.widthAnchor.constraint(equalToConstant: 560).isActive = true
        root.addArrangedSubview(selectionField)

        slider = NSSlider(value: 0, minValue: 0, maxValue: 100, target: self, action: #selector(sliderChanged))
        slider.identifier = NSUserInterfaceItemIdentifier("drag-slider")
        slider.setAccessibilityLabel("Drag slider")
        slider.widthAnchor.constraint(equalToConstant: 560).isActive = true
        root.addArrangedSubview(slider)

        let document = NSStackView()
        document.orientation = .vertical
        document.alignment = .leading
        document.spacing = 8
        for i in 1...60 {
            let row = label(String(format: "Scroll row %02d", i), identifier: "scroll-row-\(i)")
            document.addArrangedSubview(row)
        }
        document.frame = NSRect(x: 0, y: 0, width: 540, height: 1440)

        scrollView = NSScrollView()
        scrollView.identifier = NSUserInterfaceItemIdentifier("scroll-region")
        scrollView.setAccessibilityLabel("Scroll region")
        scrollView.hasVerticalScroller = true
        scrollView.borderType = .bezelBorder
        scrollView.documentView = document
        scrollView.widthAnchor.constraint(equalToConstant: 560).isActive = true
        scrollView.heightAnchor.constraint(equalToConstant: 220).isActive = true
        root.addArrangedSubview(scrollView)

        let reset = NSButton(title: "Reset Harness", target: self, action: #selector(resetHarness))
        reset.identifier = NSUserInterfaceItemIdentifier("reset-harness")
        reset.setAccessibilityLabel("Reset harness")
        root.addArrangedSubview(reset)

        window.contentView = NSView()
        window.contentView?.addSubview(root)
        NSLayoutConstraint.activate([
            root.leadingAnchor.constraint(equalTo: window.contentView!.leadingAnchor),
            root.trailingAnchor.constraint(equalTo: window.contentView!.trailingAnchor),
            root.topAnchor.constraint(equalTo: window.contentView!.topAnchor),
            root.bottomAnchor.constraint(lessThanOrEqualTo: window.contentView!.bottomAnchor),
        ])
        keyMonitor = NSEvent.addLocalMonitorForEvents(matching: .keyDown) { [weak self] event in
            let key = event.charactersIgnoringModifiers?.isEmpty == false
                ? event.charactersIgnoringModifiers!
                : "code-\(event.keyCode)"
            self?.setStatus("KEY_\(key)")
            return event
        }

        window.makeKeyAndOrderFront(nil)
        NSApp.activate(ignoringOtherApps: true)
        DispatchQueue.main.async { [weak self] in self?.scrollToTop() }
    }

    private func label(_ text: String, identifier: String) -> NSTextField {
        let field = NSTextField(labelWithString: text)
        field.identifier = NSUserInterfaceItemIdentifier(identifier)
        return field
    }

    private func setStatus(_ text: String) {
        status.stringValue = text
    }

    @objc private func clickTarget() { setStatus("CLICKED") }
    @objc private func secondaryPrimary() { setStatus("SECONDARY_PRIMARY") }
    @objc private func markSecondary() { setStatus("SECONDARY_ACTION") }
    @objc private func sliderChanged() { setStatus("SLIDER_\(Int(slider.doubleValue.rounded()))") }

    func controlTextDidChange(_ obj: Notification) {
        guard let field = obj.object as? NSTextField else { return }
        if field === input { setStatus("TYPED_\(field.stringValue)") }
        if field === selectionField { setStatus("VALUE_\(field.stringValue)") }
    }

    private func scrollToTop() {
        guard let document = scrollView.documentView else { return }
        let y = max(0, document.bounds.height - scrollView.contentView.bounds.height)
        scrollView.contentView.scroll(to: NSPoint(x: 0, y: y))
        scrollView.reflectScrolledClipView(scrollView.contentView)
    }

    @objc private func resetHarness() {
        input.stringValue = ""
        selectionField.stringValue = "alpha select-me omega"
        slider.doubleValue = 0
        scrollToTop()
        setStatus("RESET")
    }
}

let app = NSApplication.shared
let delegate = HarnessDelegate()
app.delegate = delegate
app.setActivationPolicy(.regular)
app.run()
