; Windows 安装程序（electron-builder 的 NSIS）的自定义设置，打包时自动引入（在各个页面之前）。
;
; 安装程序第一页显示 AGPL v3 协议（package.json 里 nsis.license），只作说明、不要求同意：
; 按 AGPL v3 第 9 条，接收和运行本软件不需要接受协议；修改或分发（传播）本软件即表示接受协议。
; 所以把「我接受」按钮换成「下一步」，底部的说明也换掉（原来是「如果接受协议，请点击我接受……」）。
; 这几个设置只有协议页读取。
;
; 说明按安装程序的界面语言显示。安装程序的语言限定为软件支持的四种（package.json 里 nsis.installerLanguages），
; 每种都要有一句：electron-builder 默认把编译警告当成错误，缺了哪种语言就打包失败。
; 语言编号：1033 英语，2052 简体中文，1028 繁体中文，1041 日语。
; 打包卸载程序时也会引入这个文件（卸载程序没有协议页），所以只在安装程序里设置。
!ifndef BUILD_UNINSTALLER
  LangString proteusLicenseNote 1033 "Running this software doesn't require accepting this license; modifying or distributing it means you accept it."
  LangString proteusLicenseNote 2052 "运行本软件不需要接受本协议；修改或分发本软件即表示接受本协议。"
  LangString proteusLicenseNote 1028 "執行本軟體不需要接受本授權條款；修改或散布本軟體即表示接受本授權條款。"
  LangString proteusLicenseNote 1041 "このソフトウェアの実行にライセンスへの同意は不要です。改変または配布すると、ライセンスに同意したものとみなされます。"
  !define MUI_LICENSEPAGE_BUTTON "$(^NextBtn)"
  !define MUI_LICENSEPAGE_TEXT_BOTTOM "$(proteusLicenseNote)"
!endif
