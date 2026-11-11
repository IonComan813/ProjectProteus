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
- zh-CN: 获取到的模型列表不再保存到下次打开（服务商的模型会更新），每次打开软件后重新获取；上次选的模型名仍然保留。还没获取时点模型框的 ▾ 会提示获取列表
  zh-TW: 取得的模型清單不再保存到下次開啟（服務商的模型會更新），每次開啟軟體後重新取得；上次選的模型名稱仍然保留。還沒取得時點模型框的 ▾ 會提示取得清單
  en: Fetched model lists are no longer kept after closing the app (providers update their models), so fetch the list again after reopening; the model you chose is kept. Before fetching, ▾ in the model box reminds you to fetch the list
  ja: 取得したモデル一覧は次回の起動まで保存しなくなりました（サービス側でモデルが更新されるため）。起動後にもう一度取得してください。前回選んだモデル名はそのまま残ります。取得前にモデル欄の ▾ を押すと一覧の取得を促します
- zh-CN: 获取过模型列表后，「获取列表」按钮变成「完整列表」，打开大窗口查看全部模型和服务商提供的费用、状态、标签，可以按名称或费用排序，按名称和标签筛选（逗号隔开多个条件，!文字 表示不包含，例如「gemini, !flash」），也可以在这里重新获取
  zh-TW: 取得過模型清單後，「取得清單」按鈕變成「完整清單」，開啟大視窗查看全部模型和服務商提供的費用、狀態、標籤，可以按名稱或費用排序，按名稱和標籤篩選（逗號隔開多個條件，!文字 表示不包含，例如「gemini, !flash」），也可以在這裡重新取得
  en: After fetching a model list, the "Fetch list" button becomes "Full list": a large window showing all models with the prices, status and tags the provider gives, which can be sorted by name or price and filtered by name and tag (commas separate conditions, !text means "doesn't contain", e.g. "gemini, !flash"), and where the list can be fetched again
  ja: モデル一覧を取得した後は「一覧を取得」ボタンが「すべて表示」になり、大きなウィンドウですべてのモデルとサービスが提供する料金・状態・タグを確認できます。名前や料金で並べ替え、名前とタグで絞り込み（カンマで条件を区切り、!文字列 で「含まない」。例：「gemini, !flash」）ができ、ここから再取得もできます
- zh-CN: 修复了在窗口里按住鼠标选中文字、到窗口外才松开时窗口被关闭的问题
  zh-TW: 修復了在視窗裡按住滑鼠選取文字、到視窗外才放開時視窗被關閉的問題
  en: Fixed windows closing when you select text inside them and release the mouse outside
  ja: ウィンドウ内で文字を選択し、ウィンドウの外でマウスを離すとウィンドウが閉じてしまう問題を修正しました
- zh-CN: 「添加服务商」窗口里的模型改为可以输入的下拉框，可以输入一段文字筛选获取到的模型
  zh-TW: 「新增服務商」視窗裡的模型改為可以輸入的下拉框，可以輸入一段文字篩選取得的模型
  en: The model box in the "Add a provider" window now lets you type part of a name to filter the fetched models
  ja: 「サービスを追加」ウィンドウのモデル欄で、文字を入力して取得したモデルを絞り込めるようにしました
- zh-CN: 模型列表里 Claude 的 fable 视为最强的一档，排在 opus 后面
  zh-TW: 模型清單裡 Claude 的 fable 視為最強的一檔，排在 opus 後面
  en: In model lists, Claude's fable models are treated as the top tier and sorted after opus
  ja: モデル一覧で Claude の fable を最上位とみなし、opus の後に並べるようにしました
