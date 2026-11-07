<!--
下一个版本的更新说明：上一个版本（基准版本）以来、用户能感觉到的改动。发布时写进 Release 页面和软件的更新提示。
每个 PR 都要维护：加入这次的条目；删掉或改写和它冲突的旧条目（例如这次改掉、撤销了以前加的功能）。
只改了后台逻辑的，建议也写一条简短的说明，例如「优化了一些后台逻辑」（已经有这样一条时不用重复加）。
发布新版本后的第一个 PR：清空下面的条目，把基准版本改成刚发布的版本。格式见 scripts/release-notes.js 开头的说明。
-->
基准版本: v0.5.2

- zh-CN: 服务商列表里可以用「＋ 添加服务商…」添加任意多个中转站，以前的「其他 OpenAI / Anthropic 兼容格式」自动转成添加的服务商
  zh-TW: 服務商清單裡可以用「＋ 新增服務商…」新增任意多個中轉站，以前的「其他 OpenAI / Anthropic 相容格式」自動轉成新增的服務商
  en: Add as many relays as you like with "＋ Add a provider…" in the provider list; your old "Other OpenAI / Anthropic-compatible" settings become added providers automatically
  ja: サービス一覧の「＋ サービスを追加…」で中継サービスをいくつでも追加でき、以前の「その他の OpenAI / Anthropic 互換形式」は自動的に追加したサービスになります
- zh-CN: 助理模式下右侧不再显示用不到的世界观、NPC角色、用户人设和重点指令
  zh-TW: 助理模式下右側不再顯示用不到的世界觀、NPC角色、使用者角色設定和重點指令
  en: In assistant mode the unused world, NPC characters, user's character and key instructions are no longer shown on the right
  ja: アシスタントモードでは、使わない世界観、NPCキャラクター、ユーザーキャラクター、重点指令を右側に表示しなくなりました
- zh-CN: 电脑上的「全部对话」窗口改为点一下选中、再点一次或双击打开，方便选中多个对话
  zh-TW: 電腦上的「全部對話」視窗改為點一下選取、再點一次或按兩下開啟，方便選取多個對話
  en: In the "All conversations" window on a computer, a click now selects and a second click or double-click opens, making it easier to select several
  ja: パソコンの「すべての会話」ウィンドウは、クリックで選択、もう一度クリックかダブルクリックで開くようになり、複数選択がしやすくなりました
- zh-CN: token 估算更准，同一中转站的各模型独立校准，稳定后修正更平缓，个别离谱的用量数字不再把估算拉偏
  zh-TW: token 估算更準，同一中轉站的各模型獨立校準，穩定後修正更平緩，個別離譜的用量數字不再把估算拉偏
  en: Token estimates are more accurate: models on the same relay are calibrated separately, corrections are gentler once stable, and a single wildly wrong usage figure no longer skews them
  ja: トークンの見積もりがより正確になり、同じ中継サービスの各モデルを個別に補正し、安定後は穏やかに修正し、極端な使用量の数字でずれなくなりました
- zh-CN: 「在这台设备上记住 API Key」注明是全局设置，对所有服务商生效
  zh-TW: 「在這台裝置上記住 API Key」註明是全域設定，對所有服務商生效
  en: "Remember API keys on this device" now says it is a global setting that applies to all providers
  ja: 「この端末に API キーを保存する」が全体の設定で、すべてのサービスに適用されることを明記しました
