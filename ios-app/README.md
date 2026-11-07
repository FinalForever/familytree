# 族谱编写 · iOS 未签名 IPA 构建源

这里是「族谱编写」编辑器 App 的 iOS 壳源码（Swift + WKWebView），与 GitHub Actions
工作流 `.github/workflows/ios-ipa.yml` 配套：推送 `ios-*` 或 `app-v*` 标签（或手动
workflow_dispatch）后，免费 macOS 机器自动构建出**未签名 IPA**
`FamilyTreeEditor-unsigned.ipa`，挂到对应 Release 并保留为 Actions 产物。

- 工程：`FamilyTreeEditor/FamilyTreeEditor.xcodeproj`（target/scheme：`FamilyTreeEditor`）
- Bundle ID：`com.familytree.editor`（与 Android 版一致），应用名「族谱编写」，最低 iOS 14
- 免签名：工程构建设置已关签名（`CODE_SIGNING_ALLOWED=NO`），产物**不能直接安装**，
  拿到 IPA 后请自行签名侧载（如用 AltStore/SideStore/爱思助手或自有开发者证书重签）。

## 目录与同步纪律

- `FamilyTreeEditor/FamilyTreeEditor/`：壳源码（AppDelegate/ViewController/BridgeShim.js/
  Info.plist/Assets）+ `WebApp/`——网页内核的副本。
- 网页内核的**源头在编辑器工程**（familytree-editor 的 `app/`，与本仓 gh-pages 演示站
  同源）。每次发版：先改内核源头，再把 `app/` 整目录覆盖同步到这里的 `WebApp/`
  （与演示站发版同步同一规矩，含演示站 sw.js 缓存名升级）。
- `WebApp/` 只许含白家示例数据；真实族谱数据永不进包、永不进仓库。

## 桥接

壳在文档开始处注入与 Android 壳同名的 `window.NativeBridge`（见 BridgeShim.js），
网页内核零改动：生物识别状态/验证（LAContext 面容/指纹）、导出 JSON（系统分享存文件）、
复制 JSON（剪贴板），契约细节见源码注释。
