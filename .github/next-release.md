<!--
下一个版本的更新说明：上一个版本（基准版本）以来、用户能感觉到的改动。发布时写进 Release 页面和软件的更新提示。
每个 PR 都要维护：加入这次的条目；删掉或改写和它冲突的旧条目（例如这次改掉、撤销了以前加的功能）。
只改了后台逻辑的，建议也写一条简短的说明，例如「优化了一些后台逻辑」（已经有这样一条时不用重复加）。
发布新版本后的第一个 PR：清空下面的条目，把基准版本改成刚发布的版本。格式见 scripts/release-notes.js 开头的说明。
-->
基准版本: v0.5.5

- zh-CN: 电脑上的艺术图可以横屏展示：铺满整个窗口作背景，聊天区居中、半透明，右侧设置区默认收起，按 F2（可以更改）收起或显示；上传时选择竖屏或横屏，比例和窗口相差不多时可以自动调整窗口大小，图片不会被拉伸
  zh-TW: 電腦上的藝術圖可以橫式展示：鋪滿整個視窗作背景，聊天區置中、半透明，右側設定區預設收起，按 F2（可以更改）收起或顯示；上傳時選擇直式或橫式，比例和視窗相差不多時可以自動調整視窗大小，圖片不會被拉伸
  en: On computers, artwork can be shown in landscape: it fills the whole window as the background with the chat centered and semi-transparent, and the settings panel starts hidden (press F2, which you can change, to show or hide it). Choose portrait or landscape when uploading; when the proportions are close, the window can be resized to fit, and images are never stretched
  ja: パソコンではアートを横表示にできるようになりました。ウィンドウ全体に背景として表示し、チャットは中央に半透明で表示、右の設定欄は最初は隠れていて F2（変更可能）で表示・非表示を切り替えます。アップロード時に縦表示か横表示を選び、比率が近い場合はウィンドウのサイズを自動調整できます。画像が引き伸ばされることはありません
- zh-CN: 获取到的模型列表按名称排序，同一系列里旧的、小的模型在前，数字按大小比较
  zh-TW: 取得的模型清單按名稱排序，同一系列裡舊的、小的模型在前，數字按大小比較
  en: Fetched model lists are sorted by name, with older and smaller models first within a series and numbers compared by value
  ja: 取得したモデル一覧を名前順に並べ、同じシリーズでは古いモデル・小さいモデルが先に来るようにし、数字は大きさで比べるようにしました
- zh-CN: GitHub 同步只能选择自己账号下的私有仓库；以前选的仓库是公开的时会提示
  zh-TW: GitHub 同步只能選擇自己帳號下的私人儲存庫；以前選的儲存庫是公開的時會提示
  en: GitHub sync now only offers private repositories on your own account, and warns if the repository chosen earlier is public
  ja: GitHub 同期では自分のアカウントの非公開リポジトリだけを選べるようになり、以前選んだリポジトリが公開されている場合は注意が表示されます
- zh-CN: 「记住 API Key」的说明里提醒：Vertex 的服务账号文件如果不主动删除会继续保存在本机
  zh-TW: 「記住 API Key」的說明裡提醒：Vertex 的服務帳戶檔案如果不主動刪除會繼續保存在本機
  en: The "Remember API keys" note now points out that the Vertex service account file stays on the device unless you delete it
  ja: 「API キーを記憶」の説明に、Vertex のサービスアカウントファイルは自分で削除しない限り端末に残ることを追記しました
