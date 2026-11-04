<!--
下一个版本的更新说明：上一个版本（基准版本）以来、用户能感觉到的改动。发布时写进 Release 页面和软件的更新提示。
每个 PR 都要维护：加入这次的条目；删掉或改写和它冲突的旧条目（例如这次改掉、撤销了以前加的功能）。
发布新版本后的第一个 PR：清空下面的条目，把基准版本改成刚发布的版本。格式见 scripts/release-notes.js 开头的说明。
-->
基准版本: v0.5.0

- zh-CN: 更新提示只显示最新版本的更新内容；跳过了中间的版本时，提示到 GitHub Release 页面查看其他版本的说明
  zh-TW: 更新提示只顯示最新版本的更新內容；跳過了中間的版本時，提示到 GitHub Release 頁面查看其他版本的說明
  en: The update window shows what's new in the latest version only; if versions in between were skipped, it points to the GitHub Releases page for their notes
  ja: 更新の通知には最新バージョンの変更内容だけを表示します。途中のバージョンを飛ばした場合は、それらの変更内容を GitHub の Release ページで確認するよう案内します
- zh-CN: token 估算的提示改为「下一次请求约 N 输入 token」，下面显示这个对话上一次请求的输入 token 估值、接口报告的实际输入和输出 token，以及估算的偏差；「查看下一轮将发送的内容」顶部写成「各块相加 + 加值 = 总数」
  zh-TW: token 估算的提示改為「下一次請求約 N 輸入 token」，下面顯示這個對話上一次請求的輸入 token 估值、介面回報的實際輸入和輸出 token，以及估算的偏差；「查看下一輪將傳送的內容」頂部寫成「各塊相加 + 加值 = 總數」
  en: The token estimate now reads "Next request ≈ N input tokens", followed by the conversation's last request: its estimated input tokens, the actual input and output tokens reported by the API, and how far off the estimate was. The total in "View what the next request will send" is shown as "sum of the parts + added amount = total"
  ja: トークンの見積もりは「次のリクエスト 約 N 入力トークン」と表示し、その下にこの会話の前回のリクエストの入力トークン見積もり、API が報告した実際の入力・出力トークン、見積もりの誤差を表示します。「次に送信する内容を見る」の合計は「各部分の合計 + 加算分 = 合計」の形で表示します
