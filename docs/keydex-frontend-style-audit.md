# Keydex 前端样式审计与设计语言分析

> - 文档状态：审计基线 v1.0
> - 基线日期：2026-07-24
> - 适用范围：`desktop/src` 下的 Keydex 桌面应用前端，以及由前端负责外观桥接的浏览器、终端、Diff、Markdown、A2UI 和数据可视化表面。
> 基线说明：本文基于当前工作区实际代码与现有 E2E/视觉验收截图整理，包含基线日期时工作区内尚未提交的前端样式。代码事实与未来规范发生冲突时，以本文“必须/应/禁止”规则作为新增和重构代码的目标，以当前实现作为兼容基线。

## 1. 文档目的

Keydex 已经形成了一套可辨识的视觉语言：

- 温暖、克制的中性色工作台，而不是冷白色后台模板。
- 高信息密度，但避免拥挤和装饰性噪声。
- 内容优先，尽量减少不必要的卡片套卡片。
- 颜色承担语义，不承担大面积装饰。
- 浮层有轻微玻璃感和层次，主工作区保持平整、稳定。
- 动效用于解释状态与空间关系，不用于吸引注意力。
- 会话、文件、Diff、终端、浏览器和 Agent 交互共享同一套桌面工具语法。

本文用于记录 Keydex 当前样式实现、设计语言、实现差异与收敛建议。开发时直接执行的规则见 `docs/keydex-frontend-design-specification.md`。

本文不是：

- 营销页品牌手册；
- 一套脱离当前产品的通用 Web Design System；
- 对现有 4 万余行 CSS 的逐条复制；
- 要求一次性重写全部历史样式的迁移计划。

## 2. 规范关键词

- **必须**：新增或重构代码不可违反。
- **应**：默认遵循；偏离时应在代码或评审中说明具体原因。
- **可以**：在满足上层原则时可选。
- **禁止**：不得在新增代码中出现；历史实现应在相关区域重构时收敛。

## 3. 扫描范围与现状画像

### 3.1 技术和样式载体

当前桌面端使用：

- Tauri 2；
- React 19；
- TypeScript；
- Vite；
- CSS Modules；
- 少量全局基础 CSS；
- UnoCSS 已接入，但当前不是主要样式实现方式；
- Lucide React 作为主图标库；
- CodeMirror、Xterm、ECharts、AG Grid、Mermaid、Pierre Diff 等第三方渲染表面。

样式入口顺序见 `desktop/src/main.tsx`：

1. `uno.css`
2. `renderer/styles/layout.css`
3. `renderer/styles/markdown.css`
4. `renderer/styles/themes/index.css`
5. `styles.css`

新增全局规则时必须理解这个顺序，避免依赖偶然的覆盖关系。

### 3.2 规模

基线扫描得到：

| 指标 | 当前值 |
| --- | ---: |
| CSS 文件 | 174 |
| CSS Modules | 168 |
| CSS 非空行数 | 42,789 |
| CSS Module `import` 语句 | 220 |
| TSX 内联 `style={{...}}` | 61 |
| 全局样式基础文件（不含 UnoCSS 生成物） | 6 |

主要样式分布：

| 领域 | 文件数 | CSS 行数 |
| --- | ---: | ---: |
| 会话与消息 | 38 | 13,153 |
| 设置 | 19 | 6,408 |
| 工作区与文件预览 | 5 | 3,464 |
| 应用布局 | 10 | 3,235 |
| Git | 36 | 2,770 |
| 工作台 | 2 | 2,418 |
| MCP | 2 | 2,190 |
| 浏览器 | 7 | 1,832 |
| Diff | 24 | 1,802 |
| 聊天输入 | 4 | 1,227 |
| `renderer/styles` 主题、布局、Markdown基础 | 5 | 775 |

这说明 Keydex 的设计系统必须首先服务“复杂桌面工作台”，而不是只覆盖按钮、表单和普通内容页。

### 3.3 事实来源优先级

设计规范的代码事实按以下顺序判断：

1. `desktop/src/renderer/styles/themes/base.css`
2. `desktop/src/renderer/styles/themes/default-color-scheme.css`
3. `desktop/src/styles.css`
4. `desktop/src/renderer/styles/layout.css`
5. 共享组件及其 CSS Modules
6. 功能页面 CSS Modules
7. 主题、样式基础和组件契约测试
8. E2E 截图与人工视觉验收

截图用于验证最终观感，但可能早于当前工作区代码，不能替代当前 token 和组件实现。

## 4. Keydex 的核心设计语言

### 4.1 专业工具，而不是营销界面

Keydex 的第一屏是工作台。除首页空状态、启动页和品牌展示层外，禁止使用大面积 Hero、夸张渐变、大字号宣传语或装饰性插画占据操作空间。

主要页面应让用户快速回答：

- 我现在在哪个项目、会话或文件中？
- 当前 Agent、命令或工具处于什么状态？
- 下一步可执行操作在哪里？
- 内容的滚动边界和面板边界在哪里？

### 4.2 中性优先，语义色后置

Keydex 的常规交互以石墨黑、暖白、暖灰为主。主按钮不默认使用亮蓝色大色块，而常使用深色实心、浅灰填充或中性描边。

强调色主要用于：

- 链接；
- 开关开启态；
- 进度；
- 当前选择的小型标记；
- 成功、警告、失败、信息等状态；
- 标注、技能、未读等专项语义。

禁止把 `--color-accent` 当作所有按钮、标题、边框和选中背景的统一装饰色。Git 工作台已经通过局部 `--color-accent-1: var(--color-text-1)` 明确采用中性强调，这种做法符合 Keydex 视觉语言。

### 4.3 内容面，而不是卡片堆

页面主内容一般是一整块连续表面。卡片仅用于表达下列关系：

- 独立、可折叠或可提交的对象；
- 与周围内容有明确边界的工具结果；
- 浮层或短暂状态；
- 需要聚合多个字段的设置项、A2UI 表单或审批对象。

禁止仅为了“看起来精致”给每一行、每一段和每一层都增加边框、阴影和圆角。

Agent 助手正文默认无气泡；用户消息使用克制的浅色气泡。这一非对称关系是 Keydex 会话设计的重要特征。

### 4.4 稳定空间与连续状态

侧栏、预览、会话、工作台和终端是持续存在的工作上下文。状态变化应尽量在原位置更新，避免无必要的整体重排、闪烁或重新挂载。

动效应解释：

- 面板从哪里展开；
- 选中指示从哪一项移动到哪一项；
- 工作台助手如何从胶囊过渡到输入框或侧栏；
- 内容为何出现、折叠或退出。

动效不应造成：

- 主内容持续抖动；
- 滚动位置被多个控制器竞争；
- hover 时大面积位移；
- 频繁改变行高；
- 用户正在阅读的内容被重新定位。

### 4.5 局部反馈优先

错误、审批、加载和结果应尽量显示在所属对象附近：

- 模型错误属于 turn 或消息；
- 命令错误属于命令卡；
- 文件变更状态属于文件变更表面；
- 表单校验属于字段；
- 浏览器权限属于浏览器表面。

Toast 用于跨区域、短暂、无需保留上下文的通知。禁止用一个全局 Toast 代替对象内可恢复的错误状态。

## 5. 样式架构

### 5.1 分层

Keydex 样式分为五层：

| 层级 | 责任 | 主要文件 |
| --- | --- | --- |
| 基础尺寸与字体 | 应用最小尺寸、布局宽度、圆角、阴影、动效、字体栈 | `themes/base.css` |
| 主题语义 | 明暗主题颜色、表面、状态、Diff 和语法色 | `themes/default-color-scheme.css` |
| 全局元素 | 根字号、盒模型、按钮/输入继承、无障碍辅助类 | `styles.css` |
| 全局视觉原语 | App Shell、阅读列、滚动条、通用表面 | `styles/layout.css` |
| 功能与组件 | 页面结构、状态、局部变体 | 各 `*.module.css` |

### 5.2 CSS Modules 是默认实现

新增组件必须默认使用 CSS Modules。全局选择器只允许用于：

- 应用根节点；
- `.keydex-*` 基础原语；
- Markdown 运行时；
- 第三方库必须桥接的 DOM；
- 主题根属性；
- 必须穿透 CSS Module 的明确 `:global(...)` 契约。

禁止为了方便在全局文件中增加某个页面或业务组件的专属类。

### 5.3 状态使用语义属性

组件状态应优先用稳定的 `data-*`、ARIA 属性或明确 variant 表达，例如：

```css
.item[data-active="true"] { ... }
.panel[data-status="failed"] { ... }
.root[data-density="compact"] { ... }
.button[aria-expanded="true"] { ... }
```

禁止依赖脆弱的 DOM 层级、文本内容或第 N 个子元素表达业务状态。

### 5.4 内联样式边界

内联样式可以用于运行时几何和动态数值：

- 浮层坐标；
- 拖拽宽高；
- 图表/Canvas 计算结果；
- 进度宽度；
- 虚拟列表偏移；
- 用户自定义项目颜色。

静态的颜色、间距、圆角、阴影、字号和 hover 状态必须放在 CSS 和 token 中。禁止在 TSX 内复制一套静态视觉主题。

### 5.5 局部 token

复杂组件可以定义局部 CSS 变量作为稳定变体接口，例如：

- `--git-control-height`
- `--a2ui-control-height`
- `--message-user-bubble-bg`
- `--sendbox-keydex-*`
- `--workbench-assistant-*`

局部 token 必须：

- 由明确的根组件拥有；
- 命名带领域前缀；
- 最终派生自全局语义 token；
- 对运行时注入值提供合理 fallback；
- 不伪装成全局通用 token。

## 6. 颜色系统

### 6.1 基础主题

Keydex 当前提供 Light 和 Dracula Dark 两套语义主题。

| 角色 | Token | Light | Dark |
| --- | --- | --- | --- |
| 应用画布 | `--app-bg` | `#f7f7f7` | `#21222c` |
| 主壳层 | `--shell-bg` | `#fffefc` | `#282a36` |
| 左侧栏 | `--sidebar-bg` | `#f7f6f3` | `#242631` |
| 标准内容面 | `--surface-bg` | `#fffefc` | `#282a36` |
| 抬升表面 | `--color-bg-elevated` | `#ffffff` | `#2d2f3d` |
| 弱填充 | `--surface-muted` | `#f4f4f4` | `#30323f` |
| Hover | `--surface-hover` | `#ececec` | `#393c4d` |
| Active | `--surface-active` | `#e9e9e9` | `#44475a` |
| 主文本 | `--color-text-1` | `#171717` | `#f8f8f2` |
| 次文本 | `--color-text-2` | `#555555` | `#dedee7` |
| 三级文本 | `--color-text-3` | `#7a7a7a` | `#a9acc2` |
| 最弱文本 | `--color-text-4` | `#a3a3a3` | `#6272a4` |
| 弱边框 | `--color-border-1` | `#eeeeee` | `#343746` |
| 标准边框 | `--color-border-2` | `#dddddd` | `#44475a` |
| 强边框 | `--color-border-3` | `#c9c9c9` | `#596483` |
| 主强调 | `--color-primary-6` | `#1677ff` | `#ff79c6` |

Light 主题不是纯白后台：大面积主表面使用 `#fffefc`，侧栏使用 `#f7f6f3`。这是 Keydex 温暖、纸感但不泛黄的基础。

Dark 主题采用 Dracula 方向，但大面积表面仍应克制。荧光色只用于语法、链接和小面积状态，不得大面积铺底。

### 6.2 状态色

| 语义 | Token | Light | Dark | 用法 |
| --- | --- | --- | --- | --- |
| 成功 | `--color-success-6` | `#1f9d55` | `#50fa7b` | 完成、增加、可用 |
| 警告 | `--color-warning-6` | `#d97706` | `#ffb86c` | 风险、等待确认 |
| 危险 | `--color-danger-6` | `#d92d20` | `#ff5555` | 失败、删除、阻断 |
| 信息 | `--color-info-6` | `#1677ff` | `#8be9fd` | 信息、下载、跳转 |
| 标注 | `--annotation-accent` | `#d87575` | `#d87575` | 文档/网页标注 |
| 技能 | `--color-skill` | `#b06dff` | `#ff79c6` | Skill 上下文 |
| 未读 | `--session-unread-color` | `#f97316` | 继承 | 会话未读 |

状态色必须同时配合至少一种非颜色信号：

- 图标；
- 文本；
- 形状；
- 边框；
- 状态标签；
- `aria-label`。

禁止仅靠红/绿区分状态。

### 6.3 品牌色与功能色的关系

Keydex 品牌标记由暖米色、石墨黑和珊瑚红构成。应用主画布延续暖米白与石墨色，但功能强调色仍由主题语义 token 决定：

- 珊瑚红不是全局 CTA 色；
- Light 主题的蓝色主要是链接和状态色；
- Dark 主题的粉色主要是强调和语法色；
- 标注可稳定使用 `--annotation-accent`；
- 项目图标颜色属于用户识别辅助，必须局部作用，不得改变全局语义。

### 6.4 颜色使用规则

必须：

- 从语义 token 取色；
- 用 `color-mix(...)` 生成同语义的弱背景、弱边框和 hover；
- 同时检查 Light 与 Dark；
- 第三方组件通过主题适配器接收语义色。

禁止：

- 在功能 CSS 中新增无说明的十六进制品牌色；
- 在 Light 中写死白色后假设 Dark 仍正确；
- 直接把蓝色作为通用焦点环；
- 用 `--color-primary-6` 代替成功、警告或危险语义；
- 用 `--color-text-4` 承载必要正文。

允许的直接颜色例外：

- 品牌资产和启动页；
- Windows 原生关闭按钮；
- 终端模拟器的明确背景；
- 图表数据系列；
- 用户自定义项目色；
- 外部协议或第三方格式要求的颜色。

这些例外仍必须有 Light/Dark 或可读性策略。

## 7. 字体与排版

### 7.1 字体栈

默认字体分为三类：

| 角色 | Token | 用途 |
| --- | --- | --- |
| UI | `--font-sans` | 导航、按钮、设置、工具栏 |
| 阅读 | `--font-reading` | 对话正文、Markdown、长文本 |
| 等宽 | `--font-mono` | 代码、路径、命令、ID、结构化输出 |

系统默认优先使用 Segoe UI Variable，并为中文提供苹方、微软雅黑、Noto CJK、思源黑体等 fallback。

用户可以选择：

- 系统默认；
- Maple Mono CN；
- JetBrains Mono。

字体切换会同时更新 UI、阅读和等宽 token。组件不得自行写死与 Provider 冲突的字体栈；第三方库桥接除外。

### 7.2 字号层级

当前样式中最常见的字号是 12px、11px、10px 和 13px。新增通用 UI 应使用以下层级：

| 层级 | 字号 | 典型用途 |
| --- | ---: | --- |
| Micro | 9–10px | 极小计数、Diff 行号、密集调试元数据 |
| Meta | 11px | 时间、路径、说明、辅助状态 |
| Control | 12px | 按钮、菜单、工具栏、标签 |
| Row / Compact body | 13px | 导航项、列表主文案、设置行标题 |
| Reading | 14px | Markdown 和连续正文 |
| Dialog title | 15–16px | 确认框、表单弹窗、A2UI 小标题 |
| Page title | 22px | 设置页一级标题 |
| Empty/entry title | 23–27px | 首页、工作区选择、Markdown H1 |

规则：

- 禁止用 `vw`、`vh`、`vmin` 或 `vmax` 控制字号；
- 正文不应小于 12px；
- 10px 及以下只用于非关键、短文本；
- 一行内的图标与文字应有相同视觉重量；
- 不因区域变窄而连续缩小字号，应优先隐藏次要信息或切换布局。

### 7.3 字重

推荐角色：

| 字重 | 用途 |
| ---: | --- |
| 400 | 阅读正文 |
| 500–560 | 普通控件、轻强调 |
| 600 | 选中导航、列表主标题 |
| 650 | 页面、区块和重要对象标题 |
| 680–760 | A2UI、品牌或特殊入口的有限强调 |

新增通用组件不应继续创造 570、620、660、720、730 等近似但无明确角色的字重。

### 7.4 行高

基础 token：

- `--ui-line-height-tight: 1.4`
- `--ui-line-height-compact: 1.4`
- `--ui-line-height-body: 1.5`

推荐：

| 内容 | 行高 |
| --- | ---: |
| 单行控件 | 1–1.4 |
| 紧凑说明 | 1.35–1.45 |
| 普通 UI 正文 | 1.5–1.6 |
| Markdown / 长文本 | 1.7 |

路径、代码和数值应启用等宽字体或 tabular numbers，避免状态变化时宽度抖动。

### 7.5 文本溢出

单行工具栏、菜单、列表主标题必须：

```css
min-width: 0;
overflow: hidden;
text-overflow: ellipsis;
white-space: nowrap;
```

必要信息被截断时必须提供：

- 自定义 Tooltip；
- 可复制详情；
- 展开区域；
- 多行版本。

禁止仅依赖浏览器原生 `title` 形成不一致的提示体验。

## 8. 间距、密度与尺寸

### 8.1 推荐间距序列

当前最常见 gap 为 8、6、7、5、10、4、2、3、12px。为减少继续漂移，新增通用 UI 应优先从以下序列取值：

`2 / 4 / 6 / 8 / 10 / 12 / 14 / 18 / 22 / 24 / 32`

角色建议：

| 间距 | 用途 |
| ---: | --- |
| 2px | 同组菜单项、紧密状态 |
| 4px | 图标内组、文本标题与次信息 |
| 6px | 图标与短标签 |
| 8px | 默认控件内部、按钮组 |
| 10px | 列表行和小卡片内容 |
| 12px | 卡片内边距、区块内部 |
| 14px | 面板边缘、弹窗标题 |
| 18px | 区块间隔、页面横向留白 |
| 22–24px | 大区块、弹窗或文档间隔 |
| 32px | 空状态、入口页的大间隔 |

7px、9px 等值属于既有像素校准，新增通用组件应避免继续扩散。

### 8.2 核心布局尺寸

| 角色 | Token / 当前值 |
| --- | --- |
| 应用最小宽度 | `--app-min-width: 360px` |
| 标题栏高度 | `--titlebar-height: 36px` |
| 侧栏默认宽度 | `--sidebar-default-width: 286px` |
| 侧栏当前宽度 | `--sidebar-width: 286px` |
| 侧栏折叠宽度 | `--sidebar-collapsed-width: 58px` |
| Composer 宽度 | `--composer-width: 780px` |
| 阅读列宽度 | `--content-reading-width: 800px` |
| 完整内容最小宽度 | 常用 `420px` |
| Git 控件高度 | `30px` |
| Git 字段高度 | `32px` |
| A2UI 表单控件高度 | `36px` |

### 8.3 控件密度

Keydex 是鼠标键盘优先的桌面应用，不采用移动端 44px 的统一触控高度。

| 控件类型 | 推荐高度 |
| --- | ---: |
| 小图标按钮 | 24–28px |
| 常规工具栏按钮 | 28–30px |
| 紧凑列表行 | 28–32px |
| 常规输入/选择器 | 32–36px |
| 设置选项行 | 48px 或更高 |
| 带说明的菜单项 | 36–48px |
| Composer 发送按钮 | 30–32px |

同一工具栏中按钮高度必须一致。图标按钮的视觉图标可以为 13–16px，但点击热区不得缩小到图标本身。

## 9. 圆角、边框、阴影和玻璃层

### 9.1 圆角

全局 token：

| Token | 值 | 用途 |
| --- | ---: | --- |
| `--radius-xs` | 4px | 小菜单项、代码按钮、紧凑行 |
| `--radius-sm` | 6px | 图标按钮、普通控件 |
| `--radius-md` | 8px | 输入、卡片、标准表面 |
| `--radius-lg` | 14px | 确认框、用户消息、大卡片 |
| `--radius-pill` | 999px | 胶囊、开关、圆形图标、状态点 |

特殊大表面可以使用 12、16、18、20px，但必须有明确角色：

- 12px：主内容容器、菜单或全屏面板；
- 16px：表单弹窗；
- 18–20px：Composer、工作台助手、品牌入口。

禁止在同一组件族中混用 7、8、9、10、11、12px 而没有层级意义。现有 7px 是历史密集控件校准，不应成为新 token。

### 9.2 边框

- 标准边框为 1px；
- 大面积内容面优先使用 `--color-border-1` 或 `--color-border-subtle`；
- 可交互控件使用 `--color-border-default`；
- 强边界、拖拽或焦点才使用 `--color-border-strong`；
- Active 状态可以使用浅填充加 inset 1px ring；
- 禁止通过 2–3px 常驻粗边框制造层级。

### 9.3 阴影

基础阴影：

| Token | 值 | 用途 |
| --- | --- | --- |
| `--shadow-soft` | `0 10px 28px rgb(15 23 42 / 8%)` | Composer、小型抬升表面 |
| `--shadow-popover` | `0 18px 50px rgb(15 23 42 / 14%)` | 弹窗、菜单、浮层 |

主工作区、侧栏、Git 主面板、Diff 主表面一般不使用外阴影。层级优先通过背景、1px 边框和空间关系建立。

### 9.4 玻璃感

`backdrop-filter` 允许用于：

- Dialog；
- Popover、Context Menu、Tooltip；
- 标题栏模式切换；
- 工作台助手的形态过渡；
- Sticky 顶栏。

禁止在每个普通卡片和列表行上使用 blur。玻璃层必须有足够不透明背景和边框，不能牺牲文本可读性。

## 10. 图标与品牌资产

### 10.1 图标体系

Lucide React 是主图标库，当前约 150 个 TSX 文件直接使用。图标尺寸主要集中在：

- 14px；
- 13px；
- 15px；
- 16px；
- 12px；
- 17–18px。

推荐：

| 场景 | 图标尺寸 |
| --- | ---: |
| 小型密集操作 | 12–13px |
| 默认工具栏/菜单 | 14px |
| 输入、选择器、设置行 | 15–16px |
| 区块标题 | 16–18px |
| 大型空状态 | 20–24px |

主笔画粗细应保持 1.8–2.1。除特殊品牌图形外，不应混用填充风格和线性风格。

### 10.2 图标使用规则

- 图标必须表达稳定、可理解的动作或对象；
- 只有高频、行业通用操作可以只显示图标；
- 图标按钮必须有 `aria-label`；
- 需要解释的图标按钮必须接入 `AppTooltipLayer`；
- 同一功能在侧栏、Tab、首页入口等位置必须复用同一 glyph 映射；
- 删除、危险等不可逆操作不应只依赖颜色，必要时显示文字。

### 10.3 品牌标记

品牌标记位于标题栏、启动页和品牌展示层。标题栏中保持 18px 图形、30px 点击/承载区域，不应把大 Logo 常驻在工作空间中。

启动页可以保留独立的纸张背景、网格、珊瑚信号点和品牌入场动画；这些是品牌例外，不是普通页面模板。

## 11. 应用壳层与页面布局

### 11.1 标题栏

标题栏高度固定 36px，并承担：

- 品牌入口；
- Agent / 工作台 / 项目模式切换；
- 项目或 Git 上下文；
- 窗口拖拽区；
- 原生窗口控制。

规则：

- 背景与侧栏连续；
- 模式切换使用三段 pill slider；
- 选中指示移动 180ms；
- 窗口按钮保持 Windows 语义，关闭 hover 使用系统红；
- 标题和项目名必须省略；
- 拖拽区与可交互区不得重叠。

### 11.2 左侧栏

默认宽 286px，折叠后 58px。侧栏是导航与历史上下文，不是独立卡片。

规则：

- 背景使用 `--sidebar-bg`；
- 不增加常驻右边框；
- 行高通常 28–32px；
- 主行字号 13px，分组标签 11px；
- Hover/Active 使用浅 pill 填充；
- 行内操作只在 hover、focus-within 或菜单打开时显示；
- 折叠时保留稳定图标热区；
- 底部渐隐应覆盖完整按钮并与滚动区分离。

### 11.3 主内容与右侧栏

主内容表面使用：

- 1px 标准边框；
- 左侧 12px 圆角；
- 连续的暖白表面；
- 自己的滚动所有权。

右侧栏打开时与主内容拼接，不重复边框。最大化右侧栏时应通过宽度和 flex 关系过渡，不应卸载内容或切换成完全不同的结构。

面板展开/收起基准为 220ms，使用 `--motion-ease-standard`。

### 11.4 首页

首页是唯一允许较强入口感的常规页面：

- 内容最大宽约 728px；
- 标题 24–27px；
- Composer 是视觉中心；
- 大面积留白；
- 不展示无关仪表盘和说明卡片。

首页 Composer 仍应与会话 Composer 共用 `SendBox`，通过局部 CSS 变量调整高度、圆角和阴影。

### 11.5 会话页

会话页采用三行布局：

1. Sticky 顶栏；
2. 唯一消息滚动文档；
3. Composer Dock。

会话阅读宽度以 780–800px 为核心。消息列表负责垂直滚动，外层不应再成为竞争滚动容器。

Composer Dock 底部固定在布局行中，不使用 `position: fixed`；其上方通过渐隐过渡与内容衔接。

### 11.6 工作台

工作台是多面板密集模式：

- 文件树/浏览区；
- 可调整分隔条；
- 主预览；
- 多 Tab；
- 可浮动、展开或停靠的助手；
- 可选终端。

规则：

- 所有 flex/grid 子项必须显式 `min-width: 0; min-height: 0`；
- Tab 栏高度约 34px；
- Tab 水平溢出时可隐藏原生滚动条，但必须提供可见的左右滚动按钮；
- 分隔条命中区域可以宽于可见线；
- Hover/drag 只增强 2px 左右的可见线，不突然变成粗条；
- 工作台助手的 420/650ms morph 是特殊空间动效，不应复制到普通按钮。

### 11.7 设置

设置拥有独立但与主应用一致的壳层：

- 相同标题栏和侧栏宽度；
- 相同折叠行为；
- 左侧菜单 30px 高、13px 主文案；
- 内容区左侧 12px 圆角；
- 页面内容居中，常见宽度 820–860px；
- 常规页面顶部留白约 76px、底部约 116px；
- 用量页可以更宽、更深。

设置行采用“左侧解释、右侧控件”的双列布局；窄于约 760px 时转为单列。

### 11.8 Git 工作台

Git 是高密度工具表面：

- 主字体 12px；
- 元数据 11px；
- 控件 30px；
- 字段 32px；
- 多列可调整布局；
- Active Tab 使用中性色，而非亮蓝色；
- Diff 区切换到独立 Diff token 图谱。

Git 中列表行点击预览和 Checkbox 选择必须是两个独立交互。视觉上也必须区分“当前预览”“已选择”“状态颜色”。

### 11.9 浏览器与终端

浏览器工具栏高度约 40px，图标按钮 28px，查找栏 34px。浏览器原生 WebView 是独立原生表面：

- 任何 Dialog、Toast、菜单或遮罩覆盖浏览器时必须走现有 Occlusion 协调；
- 禁止仅提高 CSS `z-index` 后假设能盖住原生表面；
- 浏览器主题、背景和占位表面必须与当前主题同步。

终端是专业工具例外：

- Xterm 使用等宽字体；
- Light 表面为暖白；
- Dark 终端可使用更深的 `#111318`；
- 工具栏仍遵循 Keydex 中性控件；
- 终端内容缓冲与 DOM 实例应保持，不因折叠而重建。

## 12. 组件规范

### 12.1 按钮

按钮分为：

| 类型 | 外观 | 典型用途 |
| --- | --- | --- |
| Icon | 透明，hover 浅填充 | 工具栏、高频操作 |
| Secondary | 抬升表面 + 标准边框 | 取消、次操作 |
| Primary neutral | 深色或轻中性填充 | 提交、发送、确认 |
| Danger | 危险色弱背景 + 危险文字/边框 | 删除、不可逆确认 |
| Pill | 全圆角浅填充 | 模式、筛选、状态、短操作 |

状态顺序：

1. 默认；
2. Hover；
3. Focus-visible；
4. Active；
5. Disabled；
6. Loading。

Active 可以使用 `scale(0.94–0.96)`，但只能用于小按钮，且 reduced motion 下应关闭。

### 12.2 输入与文本域

- 继承全局字体；
- 高度 32–36px；
- 背景使用弱填充或抬升表面；
- 默认边框可透明，但 hover/focus 必须提供边界反馈；
- Placeholder 使用三级或四级文本，但必要说明不得只放在 Placeholder；
- 文本域可纵向伸缩时必须有最大高度和内部滚动；
- 错误态使用危险边框、错误文本和 `role="alert"`；
- 自动保存设置不应借保存动作触发无关连接测试。

### 12.3 Select

标准设置选择器使用 `SettingsSelect`：

- Regular 触发器 34px；
- Compact 触发器 30px；
- 下拉层 12px 圆角；
- 选项 48px，Compact 36px；
- 有说明的 Compact 选项 44px；
- 菜单开关 120–150ms；
- 选中项显示 Check；
- 必须有 listbox/option 语义和 Escape/外部点击关闭。

### 12.4 Toggle

标准 Toggle：

- 点击热区 42×34px；
- 轨道 34×20px；
- 滑块 16px；
- 开启态使用 `--color-accent`；
- 必须使用 `role="switch"` 和 `aria-checked`；
- Disabled 降低透明度，但仍应能辨认当前状态。

### 12.5 菜单与 Context Menu

标准 Context Menu：

- 最小宽 118px；
- 最大宽 220px；
- 12px 圆角；
- 6px 内边距；
- 菜单项 28px；
- 12px 文案；
- 160ms 入场；
- 子菜单与主菜单保持相同表面。

新增右键菜单必须通过 `AppContextMenuProvider`，禁止在页面内复制另一套菜单定位和层级系统。

### 12.6 Dialog

必须优先使用 `AppDialog`、`ConfirmDialog` 和 `DialogButton`。

| Size | 宽/高基准 | 用途 |
| --- | --- | --- |
| Confirm | 420px | 确认和危险操作 |
| Form | 520px，最大高 720px | 表单 |
| Search | 720px | 搜索和选择 |
| Drawer | 560px，满高 | 右侧详情 |
| Fullscreen | 最大 1320×860px | 大型预览和编辑 |

Dialog 必须：

- 有 `role="dialog"`；
- Modal 时有 `aria-modal`；
- 捕获并循环 Tab 焦点；
- Escape 行为明确；
- 关闭后恢复触发元素焦点；
- 浏览器原生表面打开时正确遮挡；
- reduced motion 下关闭入场动画。

危险确认默认不允许点击遮罩误关闭。

### 12.7 Tooltip

必须使用 `AppTooltipLayer`：

- 单行最大宽 280px；
- 多行最大宽 320px；
- 12px 字号；
- 6px 圆角；
- 与目标间距 8px；
- 自动约束在视口内；
- 不接收鼠标事件；
- 解释性 Tooltip 可多行；
- 显式 `data-tooltip-label` 优先于从上下文推断。

Tooltip 不能替代可见的必要标签、错误信息或表单说明。

### 12.8 Toast

Toast 位于标题栏下方居中：

- 默认胶囊；
- 最小高 38px；
- 宽 210–520px；
- 展开后最大 640px；
- 语义色只以弱背景、图标和小操作出现；
- 内容过长时提供展开；
- 进入/退出 180ms；
- 不抢占主流程焦点。

### 12.9 Chip、Badge、Pill

- 用于短、可扫描、独立的信息；
- 高度一般 20–30px；
- 文案一般 10–12px；
- 必须一行省略；
- 可移除 Chip 需要独立删除热区；
- 技能、文件、引用、标注等不同上下文可以有专项色，但背景应保持低饱和；
- 禁止把长句放进 Pill。

### 12.10 Loading、Empty、Error

Loading：

- 保持最终布局尺寸；
- 优先 Skeleton 或原位 Spinner；
- 不用全屏遮罩阻断无关操作；
- 循环动画 720–900ms，reduced motion 下静止或改为非运动提示。

Empty：

- 一句话解释当前状态；
- 如有下一步，给一个明确主操作；
- 不堆叠插画和长说明。

Error：

- 显示具体对象、原因和恢复动作；
- 可复制技术详情；
- 长技术详情使用等宽字体和可滚动区域；
- 不只显示“失败”。

## 13. 会话、Agent 与生成内容

### 13.1 消息关系

用户消息：

- 右对齐；
- 最大宽通常不超过约 568px；
- 14px 大圆角；
- 10×14px 内边距；
- 使用浅色弱背景。

助手消息：

- 左对齐；
- 默认全宽；
- 无背景、无边框、无圆角；
- 内容与 Markdown 直接成为阅读文档的一部分。

Overlay 或窄侧栏会话可以为助手增加弱背景和 15px 圆角，但这是局部变体，不能反向改变主会话。

### 13.2 消息操作

- Copy、Fork、Reverse、时间、耗时等次级操作默认弱化；
- Hover、focus-within 或操作反馈时显示；
- 图标按钮通常 24px；
- 显示/隐藏不得改变消息高度；
- Streaming 活动点仅在真实流式活动时出现。

### 13.3 Composer

标准 Composer：

- 宽度继承 `--composer-width`；
- 圆角 18–20px；
- 输入字号 14px；
- 输入最大高约 188px；
- 发送按钮 30–32px 深色圆形；
- 上下文 Chip 最多约三行后内部滚动；
- 拖拽附件状态在原框内显示虚线覆盖层；
- Focus 不使用亮蓝外发光。

Composer 内不同区域必须保持稳定：

- 上下文；
- 输入；
- 状态和附件；
- 左右工具；
- 发送/停止。

任何状态切换都不应让发送按钮横向跳动。

### 13.4 Tool、Command、File Change

工具结果应遵循统一层级：

1. 工具或动作标题；
2. 当前状态与耗时；
3. 参数/目标摘要；
4. 可展开详情；
5. 结果、错误或审批操作。

命令和结构化输出使用 `--font-mono`。大输出拥有自己的明确滚动区，不把整个会话横向撑开。

### 13.5 A2UI

A2UI 是会话中的交互文档，不应被包成一个统一的大蓝色卡片。

外层：

- 最大宽通常 760px；
- 透明、无边框；
- 状态标题可以视觉隐藏但保留可访问语义；
- 操作只在 hover/focus 时增强。

内部：

- 表单最大宽约 800px；
- 控件高度 36px；
- 表单大表面 18px 圆角；
- 字段卡片 14px 圆角；
- 表格通过 AG Grid token 桥接；
- Chart、Choice、Form、Table 可以有独立构图，但必须共享主题、字体和状态语义；
- 提交、取消、修正和只读结果必须有明确视觉阶段。

## 14. Markdown、代码、Diff 与数据表面

### 14.1 Markdown

`.keydex-markdown` 是统一阅读原语：

- 字体：`--font-reading`；
- 字号：14px；
- 行高：1.7；
- 自动断词；
- 普通段落上下 12px；
- H1 为 23px；
- H2–H6 为 16px；
- 链接使用主题主色；
- 引用使用 3px 左边框；
- 图片 6px 圆角。

普通表格：

- 100% 宽；
- 自动布局；
- 1–6 列优先换行；
- 单元格允许 `overflow-wrap: anywhere`。

宽表格或虚拟表格：

- `min-width: max-content`；
- 横向滚动；
- 不强制换行造成虚拟行高失真。

### 14.2 代码

- 使用 `--font-mono`；
- 行内代码为弱底色、4px 圆角；
- 块代码为 8px 圆角；
- Header 约 36px；
- 语言标签 11px；
- 操作按钮 26px；
- 代码内容横向滚动、禁止无控制地纵向撑高；
- Source/Preview 切换使用中性 segmented control；
- Dark 主题使用 Dracula 语法色；
- HTML、Mermaid、数学预览与源码表面保持相同外框。

### 14.3 Diff

Diff 有独立且完整的语义 token 图谱：

- added；
- removed；
- modified；
- hunk；
- gutter；
- selection；
- annotation；
- aligned connector；
- toolbar；
- scrollbar。

必须使用 `--diff-*` token。禁止用链接蓝、通用成功绿或 Dracula 荧光色直接替代 Diff 语义色。

Diff 的核心规则是单一滚动所有权。虚拟化引擎创建的滚动根必须是唯一垂直滚动容器，外层不得同时 `overflow: auto`。

### 14.4 终端

- 强制等宽；
- 内容区由 Xterm 管理；
- Keydex 只控制外壳、工具栏、搜索和主题桥接；
- 不在终端输出上叠加 UI 阅读字体；
- Search 浮层使用标准抬升表面；
- 终端颜色主题不能影响应用其他区域。

### 14.5 图表与表格

AG Grid 必须通过 CSS 变量桥接：

- 背景；
- 前景；
- Header；
- Border；
- Hover；
- Selection；
- Focus；
- 字体；
- 单元格 Padding。

ECharts、Mermaid 和 Canvas 必须通过统一主题适配函数获取颜色。禁止在多个页面内各维护一套 `#334155 / #64748b / #cbd5e1` 之类的固定浅色配置。

数据系列可以有独立调色板，但轴、网格、Tooltip、图例和文本必须跟随 Keydex 主题。

## 15. 交互状态与动效

### 15.1 基础动效 token

| Token | 值 | 用途 |
| --- | --- | --- |
| `--motion-fast` | 140ms | Hover、颜色、透明度 |
| `--motion-panel` | 180ms | Popover、面板、Toast |
| `--motion-ease-out` | `cubic-bezier(0.16, 1, 0.3, 1)` | 进入、展开 |
| `--motion-ease-standard` | `cubic-bezier(0.2, 0, 0, 1)` | 位置、选中、结构过渡 |

扩展时长：

- 120ms：小型 Tooltip、退出；
- 160ms：菜单和 segmented indicator；
- 180ms：Dialog、面板；
- 220ms：侧栏宽度；
- 420–650ms：仅工作台助手的大型空间 morph。

### 15.2 Hover

Hover 默认只改变：

- 背景；
- 文本色；
- 边框；
- 小型图标透明度；
- 最多 `translateY(-1px)`。

禁止普通列表行在 Hover 时改变高度、内边距或列宽。

### 15.3 Focus

全局浏览器 outline 已被关闭，因此每个交互组件必须自行提供 `:focus-visible`。

默认焦点样式：

- 中性 1px ring；
- 或中性 2px outline；
- 必要时加 1–3px 外层弱背景；
- 不使用亮蓝泛光。

专项工具可以使用自己的语义焦点色，例如标注使用 `--annotation-accent`，但必须保证对比度。

### 15.4 Active

Active/Pressed 应通过以下一至两种信号表达：

- `--surface-active`；
- inset ring；
- 图标/文本主色；
- 0.94–0.96 的短暂 scale；
- segmented indicator 位置。

不要同时叠加高饱和背景、粗边框、大阴影和缩放。

### 15.5 Disabled

当前常见透明度为 0.38–0.68。推荐：

- 不可用且无状态价值：0.42–0.55；
- 仍需辨认当前值：0.58–0.68；
- Cursor 使用 `default` 或 `not-allowed`，同组件族保持一致；
- 禁止 Disabled 时隐藏必要标签。

### 15.6 Reduced Motion

当前有 79 个 CSS 文件、82 处 reduced-motion 规则。所有新增：

- 入场；
- 位移；
- 旋转；
- 脉冲；
- 宽高过渡；
- 无限循环

都必须提供 `prefers-reduced-motion: reduce` 行为。

Reduced Motion 下应：

- 移除位移和缩放；
- 停止无限动画；
- 保留最终状态；
- 必要时保留极短淡入，但不能依赖动效传达唯一信息。

## 16. 响应式、容器与滚动

### 16.1 桌面优先

Keydex 最小应用宽度为 360px，但完整工作台需要更大空间。响应式目标是保持功能可达，而不是把所有桌面区域压缩成移动网页。

现有关键断点包括：

- 420px：极窄 A2UI / 局部控件；
- 520px：首页和紧凑浏览器；
- 640–680px：Toast、Select；
- 760px：设置双列转单列；
- 860px：首页和会话边距；
- 1080px：复杂会话/工具布局。

新增布局应优先根据内容和容器能力决定断点，不应盲目复制页面宽度断点。

### 16.2 Container Query

当组件会同时出现在主区、侧栏、弹窗和工作台时，应使用 Container Query。现有使用者包括：

- SendBox；
- Browser Panel；
- Web Annotation Drawer；
- Diff Toolbar；
- Git History；
- Git Tool Window。

禁止仅用 `100vw` 判断一个可能位于窄侧栏中的组件。

### 16.3 单一滚动所有权

每个视觉区域必须只有一个明确的主滚动容器：

- 会话：Message List；
- 文件预览：Document Viewport；
- Diff：Viewer 或 Engine Root；
- Git：当前 pane；
- Terminal：Xterm viewport；
- Dialog Drawer：Dialog body；
- Context/Select：菜单 options。

父子两层同时垂直 `overflow: auto` 是禁止的，除非两个区域视觉上和交互上确实独立。

### 16.4 滚动条

标准滚动条：

- 8–11px；
- Track 透明；
- Thumb 使用三级/边框色混合；
- Pill 圆角；
- 通过透明边框缩小可见宽度；
- Hover 适度增强。

消息、代码、Diff 等本地滚动区域必须让用户能识别滚动能力。只有 Tab Strip 等同时提供显式滚动按钮的区域可以隐藏原生滚动条。

## 17. 可访问性

### 17.1 对比度

基于当前主题值，在标准表面上的近似对比度：

| 组合 | Light | Dark |
| --- | ---: | ---: |
| 主文本 / Surface | 17.79:1 | 13.36:1 |
| 次文本 / Surface | 7.40:1 | 10.65:1 |
| 三级文本 / Surface | 4.26:1 | 6.35:1 |
| 最弱文本 / Surface | 2.50:1 | 3.03:1 |
| 主强调 / Surface | 4.07:1 | 5.97:1 |

因此：

- 必要的小字号正文必须使用主文本或次文本；
- Light 的三级文本不应承载必须达到 4.5:1 的关键小文本；
- 最弱文本只用于 Placeholder、装饰、Disabled 或有其他可见标签的辅助信息；
- Light 的小号蓝色链接应使用更深色、下划线或其他增强方案；
- 状态色不得单独承担文字可读性。

现有 token 并不自动保证所有组合满足 WCAG，组件仍需验证实际背景和字号。

### 17.2 键盘

所有交互必须支持：

- Tab 导航；
- Enter/Space 激活；
- Escape 关闭浮层；
- Dialog 焦点循环；
- 关闭后焦点恢复；
- 可滚动区的键盘访问；
- 菜单和 Select 的明确 ARIA 状态。

### 17.3 语义

优先使用原生元素。自定义组件必须提供：

- `role`；
- `aria-label` 或可见 Label；
- `aria-expanded`；
- `aria-selected`；
- `aria-checked`；
- `aria-disabled`；
- `aria-controls`；
- `aria-live` 或 `role="alert"`，仅在适当状态使用。

### 17.4 Tooltip 与辅助名称

`aria-label` 是可访问名称，不自动等同 Tooltip 文案。可见文本按钮不应因为有文字就被强制加 Tooltip；图标按钮和被截断内容应提供显式功能提示。

### 17.5 Forced Colors

当前只有少量 Forced Colors 覆盖。新增关键控件应避免：

- 只靠背景色显示边界；
- 用透明 border 占位但在高对比模式完全消失；
- 使用 Canvas 无替代文本；
- 隐藏系统焦点而不给替代。

## 18. 文案风格

### 18.1 基本语气

Keydex 文案应：

- 简洁；
- 直接；
- 面向动作；
- 不营销；
- 不责备用户；
- 在错误中给出恢复路径。

### 18.2 命名

- 按钮使用动词：`新建会话`、`测试连接`、`刷新模型`、`复制`；
- 状态使用结果：`已启用`、`下载中`、`等待确认`；
- 危险操作写清对象：`删除供应商`，不只写 `确认`；
- Tooltip 解释功能，不重复可见按钮文字；
- 标题不加无意义句号；
- 说明文本一般控制在一到两句。

### 18.3 技术信息

路径、ID、命令、错误码：

- 使用等宽字体；
- 可以复制；
- 默认可省略；
- 展开后展示完整值；
- 不在普通段落里堆积 JSON。

## 19. 第三方组件主题桥接

任何第三方组件接入时必须回答：

1. 背景如何跟随 Light/Dark？
2. 文本、边框和 Hover 如何取语义 token？
3. 字体是否跟随 `--font-sans` 或 `--font-mono`？
4. 焦点如何表现？
5. 滚动所有权属于谁？
6. Reduced Motion 如何处理？
7. 高缩放和窄容器下是否可用？
8. 原生表面是否需要 Occlusion 协调？

已有桥接方向：

- AG Grid：CSS 变量；
- Mermaid：`getMermaidConfig(theme)`；
- Pierre Diff：`--diff-*` 和引擎 style bridge；
- Xterm：主题对象 + 容器背景；
- CodeMirror：编辑器主题；
- Browser WebView：appearance contract。

ECharts 和部分使用统计图表仍有硬编码浅色值，属于后续收敛项。

## 20. 新组件实现模板

```css
.root {
  display: grid;
  min-width: 0;
  gap: 8px;
  border: 1px solid var(--color-border-subtle);
  border-radius: var(--radius-md);
  background: var(--color-bg-elevated);
  color: var(--color-text-primary);
}

.action {
  min-height: 30px;
  border: 1px solid transparent;
  border-radius: var(--radius-sm);
  background: transparent;
  color: var(--color-text-secondary);
  font-size: 12px;
  transition:
    background-color var(--motion-fast) var(--motion-ease-out),
    color var(--motion-fast) var(--motion-ease-out),
    box-shadow var(--motion-fast) var(--motion-ease-out);
}

.action:hover:not(:disabled) {
  background: var(--surface-hover);
  color: var(--color-text-primary);
}

.action:focus-visible {
  outline: 0;
  box-shadow: 0 0 0 1px color-mix(in srgb, var(--color-border-strong) 54%, transparent);
}

.action[data-active="true"] {
  background: var(--surface-active);
  color: var(--color-text-primary);
}

.action:disabled {
  cursor: default;
  opacity: 0.52;
}

@media (prefers-reduced-motion: reduce) {
  .action {
    transition: none;
  }
}
```

这个模板不是要求所有组件长得一样，而是展示 Keydex 的默认语法：

- 语义 token；
- 低饱和边界；
- 中性 hover/focus；
- 明确状态属性；
- 紧凑尺寸；
- Reduced Motion。

## 21. 设计评审清单

### 21.1 视觉

- [ ] Light 和 Dark 都可读。
- [ ] 大面积表面使用暖中性层级，而不是任意纯白/纯黑。
- [ ] Accent 只承担明确语义。
- [ ] 没有无意义的卡片套卡片。
- [ ] 圆角与组件层级一致。
- [ ] 阴影只用于抬升层。
- [ ] 图标尺寸与同组一致。
- [ ] 长中文、路径、模型名和分支名不会破坏布局。

### 21.2 交互

- [ ] Hover 不改变布局尺寸。
- [ ] Focus-visible 清晰且不是默认蓝色泛光。
- [ ] Active、Selected、Checked、Previewed 没有混为一个状态。
- [ ] Disabled 仍能辨认必要状态。
- [ ] Loading 不导致页面跳动。
- [ ] 错误显示在所属对象附近。
- [ ] Tooltip、Menu、Dialog 在视口边缘仍可用。
- [ ] 浏览器原生表面上的浮层已处理 Occlusion。

### 21.3 布局和性能

- [ ] Flex/Grid 子项有正确的 `min-width: 0` / `min-height: 0`。
- [ ] 每个区域只有一个主滚动所有者。
- [ ] 大列表、长会话、Diff、终端没有被取消虚拟化。
- [ ] 窄容器使用 Container Query 或合适的局部响应式。
- [ ] 字号不使用视口单位。
- [ ] 动画不驱动高频布局抖动。

### 21.4 可访问性

- [ ] 图标按钮有可访问名称。
- [ ] 表单有 Label、错误和说明。
- [ ] Dialog 管理焦点。
- [ ] 菜单/Select/Toggle 有正确 ARIA。
- [ ] 颜色不是唯一状态信号。
- [ ] 必要小文本满足对比度。
- [ ] Reduced Motion 下仍可理解。

## 22. 测试与验收

设计系统相关的重点契约：

- `desktop/tests/style-foundation.spec.ts`
- `desktop/tests/theme-tokens.spec.ts`
- `desktop/tests/aligned-diff-theme-tokens.spec.ts`
- `desktop/tests/annotations-visual-style.spec.ts`
- `desktop/tests/app-dialog.spec.tsx`
- `desktop/tests/app-tooltip-layer.spec.tsx`
- `desktop/tests/settings-shell.spec.tsx`
- `desktop/tests/appearance-settings-page.spec.tsx`

推荐的最小样式基础验证：

```powershell
pnpm --dir desktop exec vitest run `
  tests/style-foundation.spec.ts `
  tests/theme-tokens.spec.ts `
  tests/aligned-diff-theme-tokens.spec.ts `
  tests/app-dialog.spec.tsx `
  tests/app-tooltip-layer.spec.tsx
```

视觉验收矩阵至少包含：

| 维度 | 取值 |
| --- | --- |
| 主题 | Light / Dark |
| 缩放 | 100% / 125% / 150% |
| 宽度 | 标准 / 窄 / 最大化 |
| 状态 | Default / Hover / Focus / Active / Disabled / Loading / Error |
| 内容 | 中文 / 英文 / 长路径 / 长标题 / 大输出 |
| 动效 | 普通 / Reduced Motion |
| 输入 | 键盘 / 鼠标 |

对 UI Bug 的验收必须验证最终可见结果，不能只验证事件触发、路由变化或 helper 执行。

## 23. 当前未完全统一的区域

以下是扫描得到的设计债务，不应被误当作新规范：

### 23.1 Token 命名仍有分叉

静态扫描发现 CSS 中定义约 420 个自定义属性，引用约 486 个属性名。未在 CSS 中直接定义的变量中，一部分是运行时注入或有 fallback 的合法局部变量；另一部分是历史别名，例如：

- `--text-secondary`
- `--text-muted`
- `--border-subtle`
- `--surface-1`
- `--surface-raised`
- `--color-warning-1`
- `--color-danger-1`
- `--ui-line-height-normal`
- `--shadow-lg`

新增代码禁止继续引入同义别名。重构相关区域时应统一到 `--color-*`、`--surface-*`、`--radius-*`、`--motion-*` 等现有主命名。

### 23.2 字号和间距尚未 token 化

颜色、圆角、阴影和动效已有基础 token，但字号和间距仍大量直接写值。后续可以增加有限的 typography/spacing token，但不应机械替换所有局部像素校准。

### 23.3 圆角有历史漂移

当前高频值同时包含：

- `var(--radius-sm)`；
- `var(--radius-md)`；
- 7px；
- 8px；
- 999px；
- 10px；
- 12px。

新增通用组件应回到 token；7px 等仅保留在经过视觉验收的既有密集组件。

### 23.4 部分第三方图表仍写死浅色

A2UI Chart、Usage Stats 等 ECharts 配置存在固定 Slate/Light 色值。它们需要统一的 Keydex Chart Theme Adapter，尤其要覆盖：

- Axis；
- Grid；
- Legend；
- Tooltip；
- Label；
- Dark theme；
- Export。

### 23.5 Focus 与对比度需要系统审计

全局 outline 被关闭，而局部 focus-visible 规则并非由一个共享 Primitive 强制。Light 的三级文本、最弱文本和主蓝在小字号下也存在对比度边界。

后续应建立：

- 交互元素 Focus 可见性扫描；
- 小字号文本对比度检查；
- Forced Colors 验收；
- 不以颜色为唯一状态信号的自动/人工检查。

### 23.6 Z-index 尚未形成统一层级表

Dialog、Tooltip、Toast、Context Menu、Startup、Terminal Popover 和浏览器原生表面已有各自层级，但没有集中 token。新增浮层必须复用共享 Primitive，禁止继续自由追加超大 `z-index`。

### 23.7 Theme 选择行为未完全产品化

Light/Dark token 图谱已完整存在，设置侧栏提供主题切换，但 `ThemeProvider` 当前以 Light 初始化，主题持久化不属于现有稳定契约。新增主题相关功能必须明确：

- 启动时来源；
- 持久化；
- 系统主题跟随；
- 浏览器、终端、Mermaid、Diff、图表同步时机。

## 24. 收敛优先级

### P0：阻止继续分叉

- 新代码只使用主语义 token；
- 第三方表面必须接入 Light/Dark；
- 所有交互必须有 focus-visible；
- 所有动画必须有 Reduced Motion；
- 保持单一滚动所有权。

### P1：补齐基础系统

- 建立有限的字号、间距和控件高度 token；
- 统一 Chart Theme Adapter；
- 收敛 legacy token alias；
- 建立 Contrast 和 Forced Colors 检查；
- 统一 Theme 持久化契约。

### P2：组件复用和视觉基线

- 收敛重复的 Select、Menu、Button、Form Field；
- 建立 Light/Dark × 100/125/150% 的视觉基线；
- 建立关键表面的截图回归；
- 集中管理浮层层级和原生表面 Occlusion。

## 25. 代码索引

### 基础

- `desktop/src/main.tsx`
- `desktop/src/styles.css`
- `desktop/src/renderer/styles/layout.css`
- `desktop/src/renderer/styles/markdown.css`
- `desktop/src/renderer/styles/themes/base.css`
- `desktop/src/renderer/styles/themes/default-color-scheme.css`

### Provider

- `desktop/src/renderer/providers/ThemeProvider.tsx`
- `desktop/src/renderer/providers/FontProvider.tsx`
- `desktop/src/renderer/providers/AppProviders.tsx`
- `desktop/src/renderer/providers/NotificationProvider.tsx`
- `desktop/src/renderer/providers/AppContextMenuProvider.tsx`

### 共享组件

- `desktop/src/renderer/components/dialog/AppDialog.tsx`
- `desktop/src/renderer/components/tooltip/AppTooltipLayer.tsx`
- `desktop/src/renderer/components/floating/FloatingLayer.tsx`
- `desktop/src/renderer/pages/settings/components/SettingsSelect.tsx`
- `desktop/src/renderer/pages/settings/components/SettingsToggle.tsx`
- `desktop/src/renderer/components/chat/SendBox/SendBox.tsx`

### 核心表面

- `desktop/src/renderer/components/layout/Layout.module.css`
- `desktop/src/renderer/components/layout/Titlebar/Titlebar.module.css`
- `desktop/src/renderer/components/layout/Sider/Sider.module.css`
- `desktop/src/renderer/pages/conversation/ChatLayout/ChatLayout.module.css`
- `desktop/src/renderer/pages/conversation/messages/MessageList.module.css`
- `desktop/src/renderer/pages/conversation/messages/MessageText.module.css`
- `desktop/src/renderer/pages/workbench/WorkbenchModePage.module.css`
- `desktop/src/renderer/pages/workbench/WorkbenchAssistantSurface.module.css`
- `desktop/src/renderer/pages/settings/SettingsShell.module.css`
- `desktop/src/renderer/features/git/components/GitToolWindow.module.css`
- `desktop/src/renderer/features/browser/ui/BrowserPanel.module.css`
- `desktop/src/renderer/features/terminal/TerminalDock.module.css`
- `desktop/src/renderer/features/annotations/ui/AnnotationRail.module.css`
- `desktop/src/renderer/pages/conversation/messages/a2ui/`
- `desktop/src/renderer/components/diff/`

---

这套规范的最终目标不是让所有页面“长得一模一样”，而是让用户在任何 Keydex 表面都能感到同一个产品逻辑：安静的中性画布、清晰的工作层级、紧凑的专业工具、克制但准确的状态色，以及在长时间工作中依然稳定、可读、可预测的交互。
