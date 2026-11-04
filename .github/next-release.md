<!--
下一个版本的更新说明：上一个版本（基准版本）以来、用户能感觉到的改动。发布时写进 Release 页面和软件的更新提示。
每个 PR 都要维护：加入这次的条目；删掉或改写和它冲突的旧条目（例如这次改掉、撤销了以前加的功能）。
只改了后台逻辑的，也写一条简短的说明，例如「优化了一些后台逻辑」（已经有这样一条时不用重复加）。
发布新版本后的第一个 PR：清空下面的条目，把基准版本改成刚发布的版本，再加这次的条目。格式见 scripts/release-notes.js 开头的说明。
-->
基准版本: v0.5.1

- zh-CN: 「查看下一轮将发送的内容」里空的消息显示 0 token
  zh-TW: 「查看下一輪將傳送的內容」裡空的訊息顯示 0 token
  en: Empty messages in "View what the next request will send" now show 0 tokens
  ja: 「次に送信する内容を見る」で空のメッセージは 0 トークンと表示します
- zh-CN: 回复被中断（安全拦截、网络中断或手动停止）时，记忆长度下方注明没收到的输出或全部用量，不再显示不准的数字
  zh-TW: 回覆被中斷（安全攔截、網路中斷或手動停止）時，記憶長度下方註明沒收到的輸出或全部用量，不再顯示不準的數字
  en: When a reply is interrupted (safety stop, network problem or stopped by you), the note under the memory length says which usage was not reported instead of showing an inaccurate number
  ja: 返信が中断されたとき（安全上の停止、ネットワーク、手動での停止）、記憶の長さの下に受け取れなかった出力または使用量を明記し、不正確な数字は表示しません
- zh-CN: 发送后一个字回复都没有（请求出错、被拦截或停止）时，刚发的消息退回输入框，改一改再发送就是重试；编辑过的消息没得到回复时，原因常驻显示在这个版本的消息下方
  zh-TW: 傳送後一個字回覆都沒有（請求出錯、被攔截或停止）時，剛傳送的訊息退回輸入框，改一改再傳送就是重試；編輯過的訊息沒得到回覆時，原因常駐顯示在這個版本的訊息下方
  en: If sending gets no reply at all (the request failed, was blocked or was stopped), the message goes back into the input box so you can edit it and send again; when an edited message gets no reply, the reason stays shown below that version of the message
  ja: 送信しても返信がまったくなかったとき（リクエストのエラー、ブロック、停止）は、送ったメッセージが入力欄に戻るので、直してもう一度送信すれば再試行できます。編集したメッセージに返信がなかったときは、その版のメッセージの下に理由を表示したままにします
