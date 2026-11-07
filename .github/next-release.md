<!--
下一个版本的更新说明：上一个版本（基准版本）以来、用户能感觉到的改动。发布时写进 Release 页面和软件的更新提示。
每个 PR 都要维护：加入这次的条目；删掉或改写和它冲突的旧条目（例如这次改掉、撤销了以前加的功能）。
只改了后台逻辑的，建议也写一条简短的说明，例如「优化了一些后台逻辑」（已经有这样一条时不用重复加）。
发布新版本后的第一个 PR：清空下面的条目，把基准版本改成刚发布的版本。格式见 scripts/release-notes.js 开头的说明。
-->
基准版本: v0.5.2

- zh-CN: 服务商可以添加任意多个：服务商列表最后的「＋ 添加服务商…」打开一个窗口，填名称、兼容模式、接口地址和 API Key，可以先获取模型列表测试并选一个模型；保存后它出现在列表里，之后在「模型与接口」里改它的设置会自动保存，也可以删除。以前的「其他 OpenAI / Anthropic 兼容格式」里填过的设置自动变成添加的服务商
  zh-TW: 服務商可以新增任意多個：服務商清單最後的「＋ 新增服務商…」開啟一個視窗，填名稱、相容模式、介面位址和 API Key，可以先取得模型清單測試並選一個模型；儲存後它出現在清單裡，之後在「模型與介面」裡改它的設定會自動儲存，也可以刪除。以前的「其他 OpenAI / Anthropic 相容格式」裡填過的設定自動變成新增的服務商
  en: You can add as many providers as you like: "＋ Add a provider…" at the end of the provider list opens a window for the name, compatibility mode, API address and API key, where you can get the model list to test it and pick a model; once saved it appears in the list, later changes under "Model & API" are saved automatically, and you can delete it. Settings you had under "Other OpenAI / Anthropic-compatible" become added providers automatically
  ja: サービスをいくつでも追加できます。サービス一覧の最後の「＋ サービスを追加…」で開くウィンドウに名前、互換モード、API アドレス、API キーを入力し、モデル一覧を取得して確認・選択できます。保存すると一覧に表示され、あとで「モデルと API」で変更した設定は自動で保存され、削除もできます。以前の「その他の OpenAI / Anthropic 互換形式」の設定は自動的に追加したサービスになります
- zh-CN: 助理模式下右侧不再显示用不到的世界观、NPC角色、用户人设和重点指令；还没上传艺术图时左栏显示一张插画
  zh-TW: 助理模式下右側不再顯示用不到的世界觀、NPC角色、使用者角色設定和重點指令；還沒上傳藝術圖時左欄顯示一張插畫
  en: In assistant mode the unused world, NPC characters, user's character and key instructions are no longer shown on the right; until you upload artwork, the left pane shows an illustration
  ja: アシスタントモードでは、使わない世界観、NPCキャラクター、ユーザーキャラクター、重点指令を右側に表示しなくなりました。アートをまだアップロードしていないときは左側にイラストを表示します
- zh-CN: 电脑上的「全部对话」窗口：点一下只选中，再点一次或双击才打开，方便选中多个对话
  zh-TW: 電腦上的「全部對話」視窗：點一下只選取，再點一次或按兩下才開啟，方便選取多個對話
  en: In the "All conversations" window on a computer, a click only selects a conversation; click again or double-click to open it, which makes selecting several easier
  ja: パソコンの「すべての会話」ウィンドウでは、クリックで選択だけ行い、もう一度クリックかダブルクリックで開くようにしました。複数選択がしやすくなります
- zh-CN: token 估算更准：同一个中转站的几个模型各自独立校准，来回切换不再互相拉动；校准稳定后修正得更平缓；个别离谱的用量数字不再把估算拉偏
  zh-TW: token 估算更準：同一個中轉站的幾個模型各自獨立校準，來回切換不再互相拉動；校準穩定後修正得更平緩；個別離譜的用量數字不再把估算拉偏
  en: More accurate token estimates: models on the same relay are calibrated independently, so switching between them no longer pulls them around; once calibration is stable it corrects more gently; a single wildly wrong usage figure no longer skews the estimate
  ja: トークンの見積もりがより正確になりました。同じ中継サービスの各モデルを個別に補正し、切り替えても互いに影響しません。補正が安定したあとは穏やかに修正し、極端におかしな使用量の数字で見積もりがずれることもなくなりました
