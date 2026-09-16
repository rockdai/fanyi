# fanyi

fanyi 是一个开源的浏览器双语阅读插件，提供沉浸式网页翻译与划词翻译。

## 功能

- 保留网页原文，在段落下方插入译文
- 划词后就地展示翻译、复制与朗读
- 支持自动识别源语言及 10 种目标语言
- 内置 Google 公共翻译服务（无需配置）
- 支持 OpenAI 兼容接口、自定义模型与服务地址
- 三种译文样式、网站排除列表与快捷键
- 本地保存设置与密钥，不上传到 fanyi 服务器

## 本地开发

```bash
npm install
npm run build
```

打开 Chrome/Edge 的扩展管理页，启用开发者模式，选择“加载已解压的扩展程序”，然后选择 `dist` 目录。

```bash
npm run dev       # 监听源码并持续构建
npm run typecheck # TypeScript 检查
npm test          # 单元测试
```

## 快捷键

- `Alt+Shift+F`：开启或关闭当前页面的沉浸式翻译
- `Alt+Shift+S`：翻译当前选中的文本

可在 `chrome://extensions/shortcuts` 中修改快捷键。

## 隐私

fanyi 不提供中转服务器。需要翻译的文本会直接发送至你选择的翻译服务。API Key 仅保存在浏览器本地存储中，不会随浏览器账号同步。

Google 公共翻译接口无需密钥，但属于实验性能力，可能存在频率限制；稳定或私密场景建议配置自己的 OpenAI 兼容服务。

## License

[Apache-2.0](LICENSE)
