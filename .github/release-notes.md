Proteus 原生应用，下载后即可使用，不需要另外安装浏览器：Windows / macOS / Linux 版自带 Chromium 浏览器内核，安卓版使用系统自带的 WebView。

## 下载

| 文件 | 适用于 |
|---|---|
| `Proteus-Setup-版本号-win-x64.exe` | Windows 10 / 11（64 位）安装程序，会创建桌面和开始菜单快捷方式 |
| `Proteus-版本号-win-x64.zip` | Windows 免安装版：解压后双击 `Proteus.exe` |
| `Proteus-版本号-mac-arm64.dmg` | macOS，Apple 芯片（M1 及更新） |
| `Proteus-版本号-mac-x64.dmg` | macOS，Intel 芯片 |
| `Proteus-版本号-linux-x86_64.AppImage` | Linux（64 位）：加上可执行权限后直接运行 |
| `Proteus-版本号-android.apk` | 安卓 7.0 及以上：下载后点击安装（需要允许“安装未知来源应用”） |

> 原生应用没有经过付费的代码签名，安卓版也不是从应用商店下载的，第一次安装或打开时可能会看到提示：
>
> - **Windows** 第一次运行可能提示「Windows 已保护你的电脑」，点「**更多信息**」→「**仍要运行**」即可。
> - **macOS** 第一次打开可能提示「无法验证开发者」，在「系统设置」→「隐私与安全性」底部点「**仍要打开**」即可。
> - **安卓** 安装时可能提示「出于安全考虑，已禁止安装未知来源的应用」（各品牌手机的说法略有不同），按提示允许浏览器（或文件管理器）「安装未知应用」，再回来点安装即可。

## 原生应用与网页版的区别

- Windows / macOS / Linux 的原生应用**没有跨域限制**，不允许浏览器直接访问的中转站也能使用（安卓版和网页版一样有这个限制）
- 原生应用的数据和浏览器分开保存。网页版的数据不会自动出现在原生应用里，可以在网页版中做「完整备份（全部对话）」，再在原生应用中读取

更新内容见 [提交记录](https://github.com/IonComan813/ProjectProteus/commits/main)，使用说明见 [README](https://github.com/IonComan813/ProjectProteus/blob/main/README.zh-CN.md)。

---

基于 AGPL v3 开源。使用者需自备 API Key，开发者不为使用者在本软件中的输入和输出承担法律责任。
