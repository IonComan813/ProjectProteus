<!--
下一个版本的更新说明：上一个版本（基准版本）以来、用户能感觉到的改动。发布时写进 Release 页面和软件的更新提示。
每个 PR 都要维护：加入这次的条目；删掉或改写和它冲突的旧条目（例如这次改掉、撤销了以前加的功能）。
只改了后台逻辑的，建议也写一条简短的说明，例如「优化了一些后台逻辑」（已经有这样一条时不用重复加）。
发布新版本后的第一个 PR：清空下面的条目，把基准版本改成刚发布的版本。格式见 scripts/release-notes.js 开头的说明。
-->
基准版本: v0.6.0

- zh-CN: 获取模型列表时不再列出图片、视频、语音、音乐、3D 生成以及嵌入、审核等不是对话用的模型（仍然可以手动输入模型名）
  zh-TW: 取得模型清單時不再列出圖片、影片、語音、音樂、3D 生成以及嵌入、審核等不是對話用的模型（仍然可以手動輸入模型名稱）
  en: Fetched model lists no longer include models that aren't for chat, such as image, video, speech, music and 3D generation, embedding and moderation models (you can still type a model name)
  ja: モデル一覧の取得で、画像・動画・音声・音楽・3D 生成や埋め込み・モデレーションなど、チャット用ではないモデルを表示しないようにしました（モデル名は手入力できます）
- zh-CN: 修复了点「获取列表」后自动展开的模型列表点别处无法收起的问题，以及以 nano 等字样开头的模型排在列表最前面的问题
  zh-TW: 修復了點「取得清單」後自動展開的模型清單點別處無法收起的問題，以及以 nano 等字樣開頭的模型排在清單最前面的問題
  en: Fixed the model list that opens after "Fetch list" not closing when clicking elsewhere, and models whose names start with words like "nano" being sorted to the top
  ja: 「一覧を取得」の後に自動で開くモデル一覧がほかの場所をクリックしても閉じない問題と、nano などで始まる名前のモデルが一覧の先頭に並ぶ問題を修正しました
