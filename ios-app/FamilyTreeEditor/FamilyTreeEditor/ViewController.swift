import UIKit
import WebKit
import LocalAuthentication

/// 族谱编写 iOS 壳主页面：全屏 WKWebView 加载 bundle 内 WebApp/（网页内核副本），
/// 并实现与安卓 MainActivity.NativeBridge 等价的四方法桥（契约见 app/ui.js）：
///   biometricStatus() 同步状态串 / biometricAuth() 异步回调 __ftBioResult(ok, code)
///   saveJson(json) 系统分享存文件 / copyText(text) 剪贴板
final class ViewController: UIViewController, WKScriptMessageHandler, WKNavigationDelegate {

    private var webView: WKWebView!

    // 顶部安全区垫的是与网页顶栏同色的绿带，状态栏文字/图标用白色
    override var preferredStatusBarStyle: UIStatusBarStyle { .lightContent }

    override func viewDidLoad() {
        super.viewDidLoad()
        // 底色与网页纸面 #f7f4ec 一致：WebView 只占安全区（见下方约束），
        // 底部小横条区露出这层纸色，与页面背景连成一片
        view.backgroundColor = UIColor(red: 0.97, green: 0.96, blue: 0.93, alpha: 1.0)

        // 1) 页面加载前先算好生物识别状态：垫片的 biometricStatus() 是同步读，
        //    必须赶在内核 ui.js 的 detectBio() 之前备好，故以 WKUserScript 在文档开始处注入常量。
        let status = Self.biometricStatus()

        // 2) 组装 WebView 配置：状态常量脚本 + NativeBridge 垫片 + 消息通道
        let userContent = WKUserContentController()
        userContent.add(self, name: "ftBridge")
        userContent.addUserScript(WKUserScript(
            source: "window.__ftBioStatus = '\(status)';",
            injectionTime: .atDocumentStart, forMainFrameOnly: true))
        if let shimURL = Bundle.main.url(forResource: "BridgeShim", withExtension: "js"),
           let shim = try? String(contentsOf: shimURL, encoding: .utf8) {
            userContent.addUserScript(WKUserScript(
                source: shim, injectionTime: .atDocumentStart, forMainFrameOnly: true))
        }
        let config = WKWebViewConfiguration()
        config.userContentController = userContent

        webView = WKWebView(frame: .zero, configuration: config)
        webView.navigationDelegate = self
        webView.translatesAutoresizingMaskIntoConstraints = false

        // 安全区适配：WebView 只占安全区，避免网页顶栏被状态栏/灵动岛压住；
        // 顶部安全区另垫一条与网页顶栏同色（#1a5436）的绿带，状态栏浮在绿带上观感连续。
        let topStrip = UIView()
        topStrip.backgroundColor = UIColor(red: 0.10, green: 0.33, blue: 0.21, alpha: 1.0)
        topStrip.translatesAutoresizingMaskIntoConstraints = false
        view.addSubview(topStrip)
        view.addSubview(webView)
        NSLayoutConstraint.activate([
            topStrip.topAnchor.constraint(equalTo: view.topAnchor),
            topStrip.leadingAnchor.constraint(equalTo: view.leadingAnchor),
            topStrip.trailingAnchor.constraint(equalTo: view.trailingAnchor),
            topStrip.bottomAnchor.constraint(equalTo: view.safeAreaLayoutGuide.topAnchor),
            webView.topAnchor.constraint(equalTo: view.safeAreaLayoutGuide.topAnchor),
            webView.bottomAnchor.constraint(equalTo: view.safeAreaLayoutGuide.bottomAnchor),
            webView.leadingAnchor.constraint(equalTo: view.leadingAnchor),
            webView.trailingAnchor.constraint(equalTo: view.trailingAnchor),
        ])

        // 3) 加载打包进 bundle 的网页内核（WebApp 为文件夹引用，整目录拷贝）
        if let indexURL = Bundle.main.url(forResource: "index", withExtension: "html", subdirectory: "WebApp") {
            webView.loadFileURL(indexURL, allowingReadAccessTo: indexURL.deletingLastPathComponent())
        }
    }

    // MARK: - 生物识别状态（词表与安卓 BiometricHelper 严格对齐）

    static func biometricStatus() -> String {
        let context = LAContext()
        var nsError: NSError?
        if context.canEvaluatePolicy(.deviceOwnerAuthenticationWithBiometrics, error: &nsError) {
            return "ok"
        }
        guard let nsError = nsError,
              let code = LAError.Code(rawValue: nsError.code) else { return "unavailable" }
        switch code {
        case .biometryNotEnrolled:
            return "none_enrolled"
        case .biometryNotAvailable:
            // biometryType 为 none 表示根本没有面容/指纹硬件；否则是暂时不可用
            return context.biometryType == .none ? "no_hardware" : "unavailable"
        default:
            return "unavailable"
        }
        // 注：本壳最低 iOS 14，不会出现安卓的 unsupported_os 分支
    }

    // MARK: - WKScriptMessageHandler（垫片转发过来的四个动作）

    func userContentController(_ userContentController: WKUserContentController,
                               didReceive message: WKScriptMessage) {
        guard message.name == "ftBridge",
              let body = message.body as? [String: Any],
              let action = body["action"] as? String else { return }
        switch action {
        case "biometricAuth":
            biometricAuth()
        case "saveJson":
            if let json = body["json"] as? String { saveJson(json) }
        case "copyText":
            if let text = body["text"] as? String { copyText(text) }
        default:
            break
        }
    }

    /// 弹系统面容/指纹验证，结果按安卓同一约定回调 window.__ftBioResult(ok, code)。
    private func biometricAuth() {
        let context = LAContext()
        context.localizedCancelTitle = "取消"
        context.evaluatePolicy(.deviceOwnerAuthenticationWithBiometrics,
                               localizedReason: "验证身份以解锁族谱编写") { ok, error in
            let code: String
            if ok {
                code = "ok"
            } else if let laError = error as? LAError {
                switch laError.code {
                case .userCancel, .systemCancel, .appCancel:
                    code = "cancelled"
                case .authenticationFailed:
                    code = "failed"
                case .biometryNotEnrolled:
                    code = "none_enrolled"
                case .biometryNotAvailable:
                    code = "no_hardware"
                default:
                    code = "unavailable"
                }
            } else {
                code = "unavailable"
            }
            DispatchQueue.main.async { [weak self] in
                self?.webView.evaluateJavaScript(
                    "window.__ftBioResult && window.__ftBioResult(\(ok), '\(code)')")
            }
        }
    }

    /// 写临时文件 family-data.json 后弹系统分享面板，让用户存到「文件」或发走。
    private func saveJson(_ json: String) {
        let url = FileManager.default.temporaryDirectory.appendingPathComponent("family-data.json")
        do {
            try json.write(to: url, atomically: true, encoding: .utf8)
        } catch {
            return
        }
        let sheet = UIActivityViewController(activityItems: [url], applicationActivities: nil)
        if let pop = sheet.popoverPresentationController {
            pop.sourceView = webView
            pop.sourceRect = CGRect(x: webView.bounds.midX, y: webView.bounds.midY, width: 0, height: 0)
            pop.permittedArrowDirections = []
        }
        present(sheet, animated: true)
    }

    private func copyText(_ text: String) {
        UIPasteboard.general.string = text
        showToast("JSON 已复制到剪贴板")
    }

    /// 底部轻提示（与安卓 Toast 同文案；内核 doCopy 也会再 toast 一次，与安卓行为一致）。
    private func showToast(_ text: String) {
        let label = UILabel()
        label.text = text
        label.font = .systemFont(ofSize: 14)
        label.textColor = .white
        label.backgroundColor = UIColor.black.withAlphaComponent(0.75)
        label.textAlignment = .center
        label.layer.cornerRadius = 8
        label.clipsToBounds = true
        label.alpha = 0
        label.translatesAutoresizingMaskIntoConstraints = false
        view.addSubview(label)
        NSLayoutConstraint.activate([
            label.centerXAnchor.constraint(equalTo: view.centerXAnchor),
            label.bottomAnchor.constraint(equalTo: view.safeAreaLayoutGuide.bottomAnchor, constant: -48),
            label.leadingAnchor.constraint(greaterThanOrEqualTo: view.leadingAnchor, constant: 48),
            label.trailingAnchor.constraint(lessThanOrEqualTo: view.trailingAnchor, constant: -48),
            label.heightAnchor.constraint(equalToConstant: 38),
        ])
        UIView.animate(withDuration: 0.25, animations: { label.alpha = 1 }) { _ in
            UIView.animate(withDuration: 0.3, delay: 1.4, options: []) {
                label.alpha = 0
            } completion: { _ in
                label.removeFromSuperview()
            }
        }
    }

    // MARK: - WKNavigationDelegate：本地文件放行，站外链接交系统浏览器

    func webView(_ webView: WKWebView,
                 decidePolicyFor navigationAction: WKNavigationAction,
                 decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
        if navigationAction.navigationType == .linkActivated,
           let url = navigationAction.request.url, !url.isFileURL {
            UIApplication.shared.open(url)
            decisionHandler(.cancel)
            return
        }
        decisionHandler(.allow)
    }
}
