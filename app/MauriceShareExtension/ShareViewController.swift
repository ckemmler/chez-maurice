import UIKit

/// "Maurice" in the share sheet: hands the page to the app and opens it.
///
/// Nothing is asked here. The conversation is the app's — its composer, its
/// Maurice, its dictation — so the sheet only carries the page across: into the
/// app group's inbox, then `maurice://share`, where a new conversation opens
/// with the article as a card above the field.
class ShareViewController: UIViewController {
    private let titleLabel = UILabel()
    private let infoLabel = UILabel()
    private let spinner = UIActivityIndicatorView(style: .medium)
    private let doneButton = UIButton(type: .system)

    override func viewDidLoad() {
        super.viewDidLoad()
        view.backgroundColor = .systemBackground
        setupUI()
        guard let items = extensionContext?.inputItems as? [NSExtensionItem] else {
            return show(NSLocalizedString("share.nothing", comment: ""))
        }
        SharedPageLoader.load(from: items) { [weak self] page in
            self?.hand(page)
        }
    }

    private func setupUI() {
        let stack = UIStackView(arrangedSubviews: [titleLabel, infoLabel, spinner, doneButton])
        stack.axis = .vertical
        stack.spacing = 12
        stack.alignment = .leading
        stack.translatesAutoresizingMaskIntoConstraints = false
        view.addSubview(stack)
        NSLayoutConstraint.activate([
            stack.topAnchor.constraint(equalTo: view.safeAreaLayoutGuide.topAnchor, constant: 24),
            stack.leadingAnchor.constraint(equalTo: view.leadingAnchor, constant: 20),
            stack.trailingAnchor.constraint(equalTo: view.trailingAnchor, constant: -20),
        ])

        titleLabel.text = "Maurice"
        titleLabel.font = .boldSystemFont(ofSize: 20)
        infoLabel.text = NSLocalizedString("share.opening", comment: "")
        infoLabel.font = .systemFont(ofSize: 15)
        infoLabel.textColor = .secondaryLabel
        infoLabel.numberOfLines = 0
        spinner.startAnimating()
        doneButton.setTitle("OK", for: .normal)
        doneButton.configuration = .filled()
        doneButton.isHidden = true
        doneButton.addTarget(self, action: #selector(close), for: .touchUpInside)
    }

    private func hand(_ page: SharedPage?) {
        guard let page else { return show(NSLocalizedString("share.nothing", comment: "")) }
        if !page.title.isEmpty { infoLabel.text = page.title }
        do {
            try ShareInbox.put(page)
        } catch {
            return show(NSLocalizedString("share.failed", comment: ""))
        }
        guard openApp(ShareInbox.openURL) else {
            // The page is in the inbox all the same: the app takes it the next
            // time it comes to the front.
            return show(NSLocalizedString("share.open_maurice", comment: ""))
        }
        // Leave once the app is on its way; the sheet has nothing left to say.
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.3) { [weak self] in self?.close() }
    }

    private func show(_ message: String) {
        spinner.stopAnimating()
        infoLabel.text = message
        doneButton.isHidden = false
    }

    @objc private func close() {
        extensionContext?.completeRequest(returningItems: nil)
    }

    /// Open the containing app.
    ///
    /// `extensionContext.open` does nothing from a share extension, and
    /// `UIApplication.open` is marked unavailable to extensions — but the
    /// application object is on the responder chain all the same. Its method is
    /// called through its implementation, since the compiler will not let the
    /// call be written.
    private func openApp(_ url: URL) -> Bool {
        var responder: UIResponder? = self
        while let current = responder {
            if let app = current as? UIApplication {
                let selector = NSSelectorFromString("openURL:options:completionHandler:")
                guard app.responds(to: selector) else { return false }
                typealias Open = @convention(c) (AnyObject, Selector, NSURL, NSDictionary, AnyObject?) -> Void
                let open = unsafeBitCast(app.method(for: selector), to: Open.self)
                open(app, selector, url as NSURL, NSDictionary(), nil)
                return true
            }
            responder = current.next
        }
        return false
    }
}
