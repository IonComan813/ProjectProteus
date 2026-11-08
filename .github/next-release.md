<!--
下一个版本的更新说明：上一个版本（基准版本）以来、用户能感觉到的改动。发布时写进 Release 页面和软件的更新提示。
每个 PR 都要维护：加入这次的条目；删掉或改写和它冲突的旧条目（例如这次改掉、撤销了以前加的功能）。
只改了后台逻辑的，建议也写一条简短的说明，例如「优化了一些后台逻辑」（已经有这样一条时不用重复加）。
发布新版本后的第一个 PR：清空下面的条目，把基准版本改成刚发布的版本。格式见 scripts/release-notes.js 开头的说明。
-->
基准版本: v0.5.4

- zh-CN: 服务商列表新增 Google Vertex AI（导入服务账号 JSON 使用，Gemini 和 Claude 模型都能用）、OpenCode 和 Command Code（Claude 模型自动切换接口）
  zh-TW: 服務商清單新增 Google Vertex AI（匯入服務帳戶 JSON 使用，Gemini 和 Claude 模型都能用）、OpenCode 和 Command Code（Claude 模型自動切換介面）
  en: New built-in providers: Google Vertex AI (import a service account JSON; works with Gemini and Claude models), OpenCode, and Command Code (switches API automatically for Claude models)
  ja: 内蔵サービスに Google Vertex AI（サービスアカウント JSON を読み込んで使用、Gemini と Claude の両モデルに対応）、OpenCode、Command Code（Claude モデルでは API を自動切り替え）を追加しました
- zh-CN: 内置服务商的接口地址改为固定、不能修改，以前给官方服务商改过的地址自动转成一个自己添加的服务商
  zh-TW: 內建服務商的介面位址改為固定、不能修改，以前給官方服務商改過的位址自動轉成一個自己新增的服務商
  en: Built-in providers now have fixed API addresses; an address you had changed on an official provider becomes a provider of your own automatically
  ja: 内蔵サービスの API アドレスは固定になり変更できなくなりました。公式サービスで変更していたアドレスは自動的に自分で追加したサービスになります
- zh-CN: 获取模型列表时，标准位置取不到会换几个常见的位置再试
  zh-TW: 取得模型清單時，標準位置取不到會換幾個常見的位置再試
  en: Getting the model list now tries a few other common locations when the standard one has none
  ja: モデル一覧の取得で、標準の場所にない場合はよくある別の場所も試すようになりました
