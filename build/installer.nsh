; Windows 安装程序（electron-builder 的 NSIS）的自定义设置，打包时自动引入（在各个页面之前）。
;
; 安装程序第一页显示 AGPL v3 协议（package.json 里 nsis.license），只作说明、不要求同意：
; 按 AGPL v3 第 9 条，接收和运行本软件不需要接受协议；修改或分发（传播）本软件即表示接受协议。
; 所以把「我接受」按钮换成「下一步」，底部的说明也换掉（原来是「如果接受协议，请点击我接受……」）。
; 这几个设置只有协议页读取。安装程序的界面语言跟随系统，这里的说明中英文各一行。
; 打包卸载程序时也会引入这个文件（卸载程序没有协议页），所以只在安装程序里设置。
!ifndef BUILD_UNINSTALLER
  !define MUI_LICENSEPAGE_BUTTON "$(^NextBtn)"
  !define MUI_LICENSEPAGE_TEXT_BOTTOM "运行本软件不需要接受本协议；修改或分发本软件即表示接受本协议。$\r$\nRunning this software needs no acceptance; modifying or distributing it means you accept."
!endif
