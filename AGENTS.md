# AGENTS GUIDANCE

## Behavioral Rules (Always Enforced)

- 使用中文交流。
- Do what has been asked; nothing more, nothing less.
- NEVER create files unless they're absolutely necessary for achieving your goal.
- ALWAYS prefer editing an existing file to creating a new one.
- NEVER proactively create documentation files (`*.md`) or README files unless explicitly requested.
- NEVER commit secrets, credentials, API Keys, or `.env` files.
- 凡事有交代，件件有着落，事事有回音。
- 遇到任何错误、警告或异常，必须正视并给出解决方案，禁止以“不影响”为由忽视或跳过。
- 本项目以 `AGENTS.md` 作为规则源文件，`CLAUDE.md` 统一使用 symlink 指向 `AGENTS.md`（`ln -s AGENTS.md CLAUDE.md`）。
- 项目级规则记录在根目录的 `AGENTS.md` 中，各级目录也可能包含约束其目录树的 `AGENTS.md`。

## Project Context

- fanyi 是一个开源的 Manifest V3 浏览器翻译插件，支持沉浸式网页翻译与划词翻译。
- 项目使用 TypeScript 和 esbuild，不依赖前端 UI 框架。
- 源码位于 `src/`，静态资源位于 `public/`，测试位于 `tests/`，构建脚本位于 `scripts/`。
- `dist/` 是构建产物，不应直接编辑或提交。
- 常用命令：`npm run typecheck`、`npm test`、`npm run build`。

## Branding

- 产品英文名称统一写作「fanyi」，不得使用 `Fanyi`、`FANYI` 等其他大小写形式作为界面品牌文案。
- 包名、仓库名、文件名和程序标识符遵循对应技术规范，不受品牌文案大小写限制。
- 不得复制竞品的品牌、商标、专有文案或受版权保护的视觉素材。

## Develop Rules

- 技术方案必须充分考虑简洁性和可持续扩展性，思考清楚后再执行具体开发。
- 如非必要，尽量减少外部依赖。
- 遵循第一性原理：每个实体、组件应有且仅有一个明确职责，避免混合不同关注点。
- 必须特别谨慎地引入新概念；现有概念能够覆盖的场景，不得随意新造名词或实体。
- 决定技术方案前，必须先检索互联网，参考并总结社区先进经验；浏览器扩展能力优先参考 Chrome、MDN 等官方文档。
- 遵循 Manifest V3 安全约束，不得引入远程执行代码、`eval` 或不必要的主机权限。
- 网页内容必须视为不可信输入；向 DOM 写入外部文本时优先使用 `textContent`，不得直接拼接未转义内容。
- API Key 只能保存在浏览器本地存储，不得写入源码、日志、测试快照或同步存储。
- 内容脚本必须控制 DOM 扫描、MutationObserver 和网络请求规模，避免显著影响页面性能。

## Code Style Rules

- 禁止在代码中写大段注释。代码即注释，通过命名、结构和小函数让逻辑自解释。
- 默认不写注释。仅当 *Why* 非显然时（隐藏约束、不变量、surprising behavior、与直觉不符的取舍）写一行短注。
- 不要把设计讨论写进代码。PR review 中的 rationale、A/B 决策和设计取舍应留在 PR 描述或 review 回复中。
- 不写 WHAT，只写 WHY。`// increments counter` 这类注释属于噪音。
- 不写多行 docstring 解释设计决策。如果函数需要长篇解释，优先拆分或重命名使其自解释。
- 保持 TypeScript 严格类型，禁止使用无必要的 `any`、非空断言和不安全类型转换。

## File Naming Rules

- 所有源文件、测试文件和目录统一使用小写字母与 kebab-case，例如 `translation-card.ts`、`site-settings.test.ts`。
- 单个英文单词文件保留 lowercase，例如 `settings.ts`、`content.ts`、`popup.ts`。
- 文件名与导出符号解耦；导出符号遵循 TypeScript 惯例，类型和类使用 PascalCase，函数和变量使用 camelCase，常量使用 UPPER_SNAKE_CASE。
- 配置文件遵循上游工具默认命名，例如 `tsconfig.json`、`package.json`、`AGENTS.md`。

## Test Rules

- 每次修改代码后必须执行 `npm run typecheck`、`npm test` 和 `npm run build`，全部通过后才能 commit 和 push。
- 不能以“本地没有环境”为由跳过验证，必须先探索可用环境并给出明确结果。
- 行为变更必须补充对应测试用例，覆盖 Happy path 和关键边界情况。
- 涉及弹窗、设置页或网页注入样式时，除自动化测试外还应进行浏览器渲染或实际加载检查。
- 不得为了让测试通过而删除断言、跳过用例或降低现有质量门槛。

## Git Rules

- 采用分支开发模式：禁止直接向 `main` 提交代码，所有变更必须通过新建分支和 PR 合并。
- 声称“已修复”或“已完成”之前，必须先 commit 并 push，确保代码已推送到远程分支。
- 新任务使用有意义的分支名，例如 `feat/selection-toolbar`、`fix/dynamic-page-translation`。
- 对现有未合并分支的优化不要新建分支，应继续在原分支工作。
- 分支合并到远程 `main` 后，本地也要删除该分支并切回 `main`。
- 提交前必须检查 `git diff` 和 `git status`，不得提交密钥、临时文件、浏览器配置或构建产物。
