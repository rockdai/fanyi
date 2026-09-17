# Chrome Web Store 上架资料

控制台：<https://chrome.google.com/webstore/devconsole>。以下内容按控制台页签整理，可直接粘贴。

## 上传包

```bash
npm run package   # 生成 fanyi-<version>.zip，manifest.json 位于压缩包根目录
```

每次重新上传前需要提高 `public/manifest.json` 与 `package.json` 中的 `version`。

## 商品详情（Store listing）

**名称**：fanyi - 智能 AI 翻译

**摘要**：开源、轻量的智能 AI 网页翻译与划词翻译工具。

**详细说明**：

```
fanyi 是一个开源、轻量的智能 AI 翻译扩展。保留网页原文，在每个段落下方插入译文；选中任意文字即可就地翻译、复制与朗读。

主要功能
- 网页翻译：原文与译文对照阅读，滚动到哪里翻译到哪里，动态加载的内容也会自动补译
- 划词翻译：选中文本后直接显示译文，支持复制与朗读原文
- 内置 Google 翻译，无需任何配置即可使用
- 支持接入 OpenAI 兼容接口：OpenAI、DeepSeek、Kimi、智谱、通义千问、Gemini、OpenRouter、vLLM 或任何自定义服务，API Key 只保存在本地
- 自动识别源语言，支持 10 种目标语言
- 三种译文样式、网站排除列表、可自定义快捷键（Alt+Shift+F 翻译网页，Alt+Shift+S 翻译选中文本）

隐私
fanyi 没有账号系统，也不运营任何服务器。开启翻译的网页正文和你选中的文本会直接发送到你选择的翻译服务，设置与 API Key 全部保存在浏览器本地。代码以 Apache-2.0 许可证开源：https://github.com/rockdai/fanyi
```

**类别**：生产力 / 工具（Productivity › Tools）

**语言**：中文（简体）

**图片素材**（`npm run store-assets` 生成）：

| 素材 | 文件 | 尺寸 |
| --- | --- | --- |
| 商店图标 | `public/icons/icon-128.png` | 128×128 |
| 截图 1：网页翻译 | `store/screenshot-1-page.png` | 1280×800 |
| 截图 2：划词翻译 | `store/screenshot-2-selection.png` | 1280×800 |
| 截图 3：翻译服务设置 | `store/screenshot-3-options.png` | 1280×800 |
| 小宣传图（必填） | `store/promo-small.png` | 440×280 |

**其他链接**：主页 `https://github.com/rockdai/fanyi`，支持 `https://github.com/rockdai/fanyi/issues`。

## 隐私（Privacy）

**单一用途说明**：

```
翻译用户正在浏览的网页正文和选中的文本，并在页面内显示译文。
```

**权限理由**：

| 权限 | 理由 |
| --- | --- |
| `storage` | 在本地保存语言偏好、译文样式、网站排除列表和用户自己填写的 API Key。 |
| `activeTab` | 弹窗需要读取当前标签页的标题和网址来显示状态、判断是否在排除列表中，并向当前标签页发送开始或停止翻译的指令。 |
| `contextMenus` | 提供「翻译网页」和「翻译选中文本」两个右键菜单项。 |
| 主机权限 `https://translate.googleapis.com/*` | 调用内置的 Google 翻译接口获取译文。 |
| 主机权限 `https://api.openai.com/*` | 调用默认的 OpenAI 接口获取译文。 |
| 可选主机权限 `https://*/*`、`http://*/*` | 仅当用户把 AI 接口地址改为其他服务（例如 DeepSeek、自建 vLLM）时，才在设置页请求该服务域名的访问权限。 |
| 内容脚本匹配所有 `http`/`https` 页面 | 翻译功能需要在用户打开的任意网页中读取可见段落并插入译文，并响应用户的文本选择以提供划词翻译。网页正文只在用户通过弹窗、快捷键或右键菜单开启翻译后（或用户主动开启「进入网页后立即翻译」设置后）才会读取和发送；划词翻译默认在选中文本后自动发送所选文本，用户可改为点击按钮触发或关闭。 |

**远程代码**：否。所有代码打包在扩展内，不加载、不执行任何远程脚本。

**数据使用**：

- 勾选「网站内容」：用户开启翻译的网页正文，以及用户在网页中选中的文本，会发送到用户选择的翻译服务。
- 勾选「身份验证信息」：用户自行填写的 API Key 保存在本地，并随翻译请求发送到用户配置的接口。
- 其余类别（个人身份信息、健康、财务、通信、位置、浏览记录、用户活动）均不收集。
- 三项认证全部勾选：不出售数据；不用于与核心功能无关的用途；不用于信用评估或贷款。

**隐私政策 URL**：`https://github.com/rockdai/fanyi/blob/main/PRIVACY.md`

## 分发（Distribution）

免费；公开；所有地区。

## 提交前检查

- 开发者账号已缴纳一次性注册费，已开启两步验证并验证联系邮箱，已完成 trader / non-trader 声明。
- `npm run typecheck && npm test && npm run build` 通过。
- 上传包由 `npm run package` 生成，不含 sourcemap 与临时文件。
- 内容脚本匹配所有网站属于「广泛主机权限」，审核通常需要几天到几周；超过三周可联系开发者支持。
