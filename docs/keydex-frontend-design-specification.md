# Keydex 前端样式规范手册

> - 版本：v1.1
> - 基线：2026-07-24
> - 适用范围：`desktop/src` 下的桌面应用前端
> - 样式实现：React 19 + TypeScript + CSS Modules
> - 现状分析：见 `docs/keydex-frontend-style-audit.md`

本手册只回答四个问题：使用什么 Token、组件应有多大、各种状态如何表现、实现时允许或禁止什么。

## 0. 使用规则

### 0.1 规范等级

| 关键词 | 含义 |
| --- | --- |
| 必须 | 新增和重构代码不可违反 |
| 应 | 默认遵守；偏离时必须说明原因 |
| 可以 | 满足上层规则时可选 |
| 禁止 | 新代码不得使用；历史代码在相关重构中移除 |

### 0.2 决策顺序

发生冲突时，按以下顺序执行：

1. 已有共享组件的公开 API 和交互契约；
2. `desktop/src/renderer/styles/themes/` 中的 Token；
3. 本手册；
4. 当前功能模块内已经稳定使用的局部 Token；
5. 历史 CSS 字面量。

不得以“当前某个页面已经这样写”为理由复制不符合本手册的历史样式。

### 0.3 默认实现

| 项目 | 标准 |
| --- | --- |
| 样式隔离 | CSS Modules |
| 全局样式 | 仅主题、基础排版、应用布局和 Markdown |
| 图标 | `lucide-react` |
| 状态表达 | `data-*`、ARIA 属性或伪类 |
| 主题 | `data-theme="light"` / `data-theme="dark"` |
| 尺寸单位 | UI 使用 `px`；内容宽度可使用 `ch`；响应式可使用 `%`、`vw`、`clamp()` |
| 动效 | 只使用 `opacity`、`transform`、颜色和阴影过渡 |
| 浮层 | 使用 `AppDialog`、`FloatingLayer`、`AppContextMenuProvider`、`AppTooltipLayer` |

### 0.4 一页速查

| 类别 | 默认值 |
| --- | --- |
| 默认 UI 字号 | 12px |
| 强调行/控件字号 | 13px |
| 阅读正文 | 14px / 1.7 |
| 默认控件高度 | 30px |
| 紧凑控件高度 | 28px |
| 表单控件高度 | 34px；A2UI 为 36px |
| 默认间距 | 8px |
| 默认圆角 | 6px 或 8px |
| 默认边框 | `1px solid var(--color-border-default)` |
| 默认动效 | `140ms var(--motion-ease-out)` |
| 默认图标 | 14px |
| 默认内容宽度 | 800px |
| 会话/Composer 宽度 | 780px |
| 左侧栏 | 286px；折叠 58px |
| 标题栏 | 36px |

## 1. Design Tokens

### 1.1 Token 使用约束

必须：

- 颜色、主题表面、字体、圆角、阴影、动效和核心布局尺寸使用现有 Token。
- Light 和 Dark 使用相同的语义 Token 名称。
- 局部计算值通过组件级 CSS 自定义属性传递。

禁止：

- 在组件 CSS 中根据主题复制两套结构样式。
- 使用十六进制颜色模拟已有语义色。
- 使用 `blue`、`gray`、`red` 等视觉名称定义公共 Token。
- 新增 `--text-secondary`、`--surface-1` 等与现有命名重复的别名。
- 用 `!important` 覆盖主题 Token。

### 1.2 核心布局 Token

| Token | 值 | 用途 |
| --- | ---: | --- |
| `--app-min-width` | 360px | 应用最小宽度 |
| `--titlebar-height` | 36px | 原生标题栏 |
| `--sidebar-default-width` | 286px | 左侧栏默认宽度 |
| `--sidebar-width` | 286px | 左侧栏运行时宽度 |
| `--sidebar-collapsed-width` | 58px | 左侧栏折叠宽度 |
| `--composer-width` | 780px | 会话内容与输入区基准宽度 |
| `--content-reading-width` | 800px | 文档阅读列宽度 |

不得在功能模块中重复声明这些尺寸。

### 1.3 圆角 Token

| Token | 值 | 使用范围 |
| --- | ---: | --- |
| `--radius-xs` | 4px | 菜单项、紧凑行、小型按钮 |
| `--radius-sm` | 6px | 普通按钮、输入框、工具栏控件 |
| `--radius-md` | 8px | 普通容器、Select、提示块 |
| `--radius-lg` | 14px | 用户消息、确认框、较大内容块 |
| `--radius-pill` | 999px | Toggle、Chip、模式切换、圆形按钮 |

允许的固定例外：

| 场景 | 圆角 |
| --- | ---: |
| Form Dialog | 16px |
| 展开 Toast | 18px |
| Composer 外框 | 18–20px |
| 工作台 Assistant 形变表面 | 20–34px |
| 全屏 Dialog | 12px |

新组件不得新增 5px、7px、9px、10px、11px、13px 等圆角档位。

### 1.4 阴影 Token

| Token | Light | Dark | 用途 |
| --- | --- | --- | --- |
| `--shadow-soft` | `0 10px 28px rgb(15 23 42 / 8%)` | `0 10px 28px rgb(9 10 16 / 34%)` | Composer、轻浮层 |
| `--shadow-popover` | `0 18px 50px rgb(15 23 42 / 14%)` | `0 18px 50px rgb(9 10 16 / 48%)` | Dialog、Popover |

规则：

- 普通内容容器不使用阴影。
- 阴影只表达脱离文档流的层级。
- 同一表面不得同时使用强边框和强阴影。
- 禁止使用彩色阴影表达主操作。

### 1.5 动效 Token

| Token | 值 | 用途 |
| --- | --- | --- |
| `--motion-fast` | 140ms | Hover、Focus、颜色、轻微位移 |
| `--motion-panel` | 180ms | Dialog、Toast、面板展开 |
| `--motion-ease-out` | `cubic-bezier(0.16, 1, 0.3, 1)` | 进入、响应用户操作 |
| `--motion-ease-standard` | `cubic-bezier(0.2, 0, 0, 1)` | 面板和空间状态变化 |

允许：

- Hover 位移最大 1px。
- Active 缩放最小 0.94，常规使用 0.96–0.98。
- Popover 进入位移最大 4px。

禁止：

- 普通操作使用弹跳、旋转或持续呼吸动画。
- 对 `width`、`height`、`top`、`left` 做高频动画。
- 动效时长超过 260ms，除非是进度演示或产品展示层。

### 1.6 字体 Token

| Token | 用途 |
| --- | --- |
| `--font-sans` | UI、按钮、菜单、表单 |
| `--font-reading` | Markdown、长文本 |
| `--font-mono` | 代码、路径、命令、哈希、数值标识 |

字体由 `FontProvider` 更新。组件不得直接指定 Segoe UI、Maple Mono、JetBrains Mono 或系统字体名称。

## 2. 颜色规范

### 2.1 基础背景

| Token | Light | Dark | 用途 |
| --- | --- | --- | --- |
| `--color-bg-1` | `#ffffff` | `#282a36` | 基础内容面 |
| `--color-bg-2` | `#f7f7f7` | `#21222c` | 应用背景 |
| `--color-bg-3` | `#ededed` | `#30323f` | 第三级背景 |
| `--color-bg-4` | `#e3e3e3` | `#3a3d4e` | 强调背景 |
| `--color-fill-1` | `#f4f4f4` | `#30323f` | 弱填充 |
| `--color-fill-2` | `#ececec` | `#393c4d` | Hover 填充 |
| `--color-fill-3` | `#e2e2e2` | `#44475a` | Active 填充 |
| `--fill-0` | `#ffffff` | `#282a36` | 零层填充 |

### 2.2 产品表面

| Token | Light | Dark | 使用位置 |
| --- | --- | --- | --- |
| `--app-bg` | `--color-bg-2` | `--color-bg-2` | 应用最外层 |
| `--shell-bg` | `#fffefc` | `--color-bg-1` | 主应用壳层 |
| `--sidebar-bg` | `#f7f6f3` | `#242631` | 标题栏与左侧栏 |
| `--surface-bg` | `#fffefc` | `--color-bg-1` | 内容表面 |
| `--surface-muted` | `--color-fill-1` | `--color-fill-1` | 次要填充 |
| `--surface-hover` | `--color-fill-2` | `--color-fill-2` | Hover |
| `--surface-active` | `#e9e9e9` | `--color-fill-3` | Selected / Active |
| `--color-bg-elevated` | `--color-bg-1` | `#2d2f3d` | 浮层 |

选择规则：

| 场景 | 使用 |
| --- | --- |
| 页面底色 | `--app-bg` |
| 主工作面 | `--shell-bg` 或 `--surface-bg` |
| 左侧导航 | `--sidebar-bg` |
| 普通卡片/内容块 | `--surface-bg` |
| 弱分组 | `--surface-muted` |
| Hover | `--surface-hover` |
| 当前项 | `--surface-active` |
| Dialog、Menu、Tooltip | `--color-bg-elevated` |

### 2.3 文本

| Token | Light | Dark | 使用位置 |
| --- | --- | --- | --- |
| `--color-text-1` | `#171717` | `#f8f8f2` | 标题、正文、重要操作 |
| `--color-text-2` | `#555555` | `#dedee7` | 普通控件、说明正文 |
| `--color-text-3` | `#7a7a7a` | `#a9acc2` | 辅助信息、图标 |
| `--color-text-4` | `#a3a3a3` | `#6272a4` | Placeholder、弱元数据 |
| `--color-text-inverse` | `#ffffff` | `#282a36` | 深色实心背景上的文本 |

必须：

- 正文使用 `--color-text-1` 或 `--color-text-2`。
- 可操作图标至少使用 `--color-text-3`。
- `--color-text-4` 只用于非关键文本和 Placeholder。

禁止：

- 使用 `opacity` 降低正文对比度。
- 在 `--surface-muted` 上使用 `--color-text-4` 承载必要信息。
- 仅通过浅灰文本表示 Disabled；同时使用禁用语义和交互状态。

### 2.4 边框

| Token | Light | Dark | 使用位置 |
| --- | --- | --- | --- |
| `--color-border-1` | `#eeeeee` | `#343746` | 轻分隔线 |
| `--color-border-2` | `#dddddd` | `#44475a` | 控件与普通容器 |
| `--color-border-3` | `#c9c9c9` | `#596483` | 强边界、滚动条 |
| `--color-border-subtle` | `--color-border-1` | `--color-border-1` | 语义别名 |
| `--color-border-default` | `--color-border-2` | `--color-border-2` | 语义别名 |
| `--color-border-strong` | `--color-border-3` | `--color-border-3` | 语义别名 |

优先使用语义别名。基础序号 Token 仅用于定义新语义 Token 或实现精确层级。

### 2.5 Primary 色阶

| Token | Light | Dark |
| --- | --- | --- |
| `--color-primary-1` | `#edf5ff` | `#3a2638` |
| `--color-primary-2` | `#d6eaff` | `#4b2946` |
| `--color-primary-3` | `#a9d2ff` | `#663052` |
| `--color-primary-4` | `#72b5ff` | `#8f3f70` |
| `--color-primary-5` | `#3693ff` | `#d65da8` |
| `--color-primary-6` | `#1677ff` | `#ff79c6` |
| `--color-primary-7` | `#0958d9` | `#ff92d0` |

`--color-accent` 等于 `--color-primary-6`。

Accent 只用于：

- Toggle 选中；
- 明确的链接和可点击文本；
- 当前选择的标记；
- Focus 或 Selection 的局部提示；
- 需要与普通内容区分的产品能力标记。

Accent 不用于：

- 大面积页面背景；
- 每一个主要按钮；
- 普通标题；
- 导航当前项的整块高饱和填充；
- 纯装饰渐变。

### 2.6 状态色

| 语义 | Token | Light | Dark |
| --- | --- | --- | --- |
| 成功 | `--color-success-6` | `#1f9d55` | `#50fa7b` |
| 警告 | `--color-warning-6` | `#d97706` | `#ffb86c` |
| 危险 | `--color-danger-6` | `#d92d20` | `#ff5555` |
| 信息 | `--color-info-6` | `#1677ff` | `#8be9fd` |
| 批注 | `--annotation-accent` | `#d87575` | `#d87575` |
| Skill | `--color-skill` | `#b06dff` | `#ff79c6` |
| 未读会话 | `--session-unread-color` | `#f97316` | 继承 Light 定义 |

状态色必须与文本、图标或形状同时出现。不得只靠颜色区分成功、警告和失败。

### 2.7 Diff 与 Syntax

Diff 必须使用 `--diff-*` Token：

- 新增：`--diff-added-*`
- 删除：`--diff-removed-*`
- 修改：`--diff-modified-*`
- Hunk：`--diff-hunk-*`
- 表面：`--diff-surface-*`
- Gutter：`--diff-gutter-*`
- Selection：`--diff-selection-*`
- Annotation：`--diff-annotation-*`

代码高亮必须使用：

- `--syntax-keyword`
- `--syntax-atom`
- `--syntax-number`
- `--syntax-string`
- `--syntax-regexp`
- `--syntax-comment`
- `--syntax-variable`
- `--syntax-function`
- `--syntax-type`
- `--syntax-property`
- `--syntax-operator`
- `--syntax-punctuation`

禁止在 Diff、CodeMirror、Markdown Renderer 或第三方高亮主题中直接写红、绿、蓝色。

## 3. 排版

### 3.1 字号

| 角色 | 字号 | 行高 | 字重 | 使用范围 |
| --- | ---: | ---: | ---: | --- |
| Micro | 8–9px | 1–1.3 | 500–600 | 图表刻度、极紧凑技术标记；普通 UI 禁用 |
| Dense Meta | 10px | 1.35–1.45 | 400–600 | Git 哈希、Diff 元数据、时间 |
| Meta | 11px | 1.35–1.5 | 400–600 | 辅助说明、Placeholder、标签 |
| UI Default | 12px | 1.4–1.5 | 400–600 | 按钮、菜单、表单、普通行 |
| UI Emphasis | 13px | 1.4–1.5 | 500–650 | 导航标题、强调行、输入摘要 |
| Reading / Input | 14px | 1.55–1.7 | 400–600 | Markdown、Composer 输入 |
| Dialog / Section Title | 15–16px | 1.35–1.4 | 600–650 | Dialog、页面区块标题 |
| Startup / Page Title | 17px | 1.35 | 650 | 启动状态、页面主标题 |
| Markdown H1 | 23px | 1.25 | 650 | Markdown 一级标题 |

规则：

- 新增普通 UI 默认使用 12px。
- 10px 以下只允许用于非关键、技术性、短文本。
- 不得使用 `vw`、`vh`、`clamp()` 控制普通文字大小。
- 同一组件最多使用三个字号层级。
- 按钮文字不得小于 11px。
- 输入正文不得小于 12px；Composer 固定 14px。

### 3.2 字重

| 字重 | 用途 |
| ---: | --- |
| 400 | 普通正文 |
| 450–500 | 次强调、Tooltip |
| 560 | Select 当前值、紧凑强调 |
| 600 | 导航、按钮、区块标签 |
| 650 | 标题、Toast 标题、强操作 |

禁止在普通 UI 中使用 700 以上字重。

### 3.3 文本截断

单行：

```css
overflow: hidden;
text-overflow: ellipsis;
white-space: nowrap;
```

可换行技术文本：

```css
white-space: pre-wrap;
overflow-wrap: anywhere;
```

规则：

- 项目名、路径、模型名和会话标题必须可查看完整值，至少提供 Tooltip。
- 错误详情不得仅保留截断后的单行。
- 命令、日志和代码使用 `--font-mono`，并保留原始空白。

## 4. 间距、密度和尺寸

### 4.1 间距序列

新增样式只使用以下间距：

| 值 | 用途 |
| ---: | --- |
| 2px | 同组图标、紧凑列表 |
| 4px | 标签与辅助信息 |
| 6px | 图标和文字、紧凑控件 |
| 8px | 默认组件间距 |
| 10px | 行内操作、控件内边距 |
| 12px | 区块内边距 |
| 14px | 标题与正文、Dialog 组 |
| 16px | 标准容器内边距 |
| 18px | Dialog 内边距 |
| 20px | 页面小节 |
| 24px | 页面边距、Dialog 外边距 |
| 32px | 大区块和空状态 |

禁止新增 3px、5px、7px、9px、11px、13px、15px、17px 等作为普通布局间距。边界对齐和视觉补偿除外。

### 4.2 控件高度

| 高度 | 类型 |
| ---: | --- |
| 22px | Toast 内部操作、极小图标按钮 |
| 24px | 标题栏模式项 |
| 28px | 菜单项、侧栏操作、紧凑按钮 |
| 30px | 默认按钮、侧栏搜索、紧凑 Select |
| 32px | Composer 发送按钮、常规工具按钮 |
| 34px | 设置 Select、工作台 Tab、常规复合控件 |
| 36px | A2UI 表单控件、强调操作 |
| 38px | Toast 最小高度 |
| 40px | 浏览器工具栏、Composer 工具行 |
| 42px | Toggle 点击区域 |

同一工具栏中的按钮高度必须一致。

### 4.3 点击区域

- 桌面紧凑工具按钮最小 28×28px。
- 标题栏模式按钮有效高度为 24px，但外层容器为 30px。
- Toggle 点击区域为 42×34px，不能缩成 Track 尺寸。
- 只有图标的按钮必须有 `aria-label` 和 Tooltip。
- 相邻图标按钮之间至少保留 2px 间隔。

## 5. 表面、边框和层级

### 5.1 表面类型

| 类型 | 背景 | 边框 | 圆角 | 阴影 |
| --- | --- | --- | --- | --- |
| 页面 | `--shell-bg` | 无 | 0 或壳层圆角 | 无 |
| 普通容器 | `--surface-bg` | `--color-border-subtle` | 8px | 无 |
| 弱分组 | `--surface-muted` | 可无 | 6–8px | 无 |
| Inline Block | `--inline-block-bg` | `--inline-block-border` | 8px | 无 |
| Popover | `--color-bg-elevated` | 半透明 Default Border | 12px | Popover Shadow |
| Dialog | `--surface-bg` 或 Elevated | Default Border | 12–16px | Popover Shadow |
| Composer | `--composer-frame` | `--composer-border` | 18–20px | `--composer-shadow` |

禁止：

- 页面内连续使用三层以上卡片。
- 为每个设置项添加独立卡片。
- 使用阴影分隔同一平面上的行。
- 使用大面积半透明表面承载长文本。

### 5.2 公共浮层层级

| 层 | z-index | 入口 |
| --- | ---: | --- |
| Dialog | 180 | `AppDialog` |
| Tooltip | 210 | `AppTooltipLayer` |
| Notification | 220 | `NotificationProvider` |
| Floating Layer | 240 | `FloatingLayer` |
| Context Menu | 260 | `AppContextMenuProvider` |
| Context Submenu | 261 | `AppContextMenuProvider` |

规则：

- 功能模块内部层级使用 0–20。
- 跨模块浮层必须使用公共浮层入口。
- 禁止为普通 Dropdown 写 1000、9999、10000。
- 覆盖 Tauri Browser、Terminal 等原生表面时，必须走统一 Occlusion/Visibility 协议，不能只提高 CSS z-index。
- 启动页、产品展示和全屏预览是独立顶层场景，不作为普通组件参考。

## 6. 图标

### 6.1 尺寸

| 尺寸 | 使用位置 |
| ---: | --- |
| 11–12px | Micro 状态、紧凑元数据 |
| 13px | 菜单项、侧栏行 |
| 14px | 默认 UI 图标 |
| 15–16px | 标准按钮、输入装饰、工具栏 |
| 18px | 品牌入口、空状态小图标 |
| 20–24px | 空状态、一级功能入口 |

### 6.2 规则

必须：

- 优先复用已有 Lucide 图标语义。
- 图标颜色继承 `currentColor`。
- 文本按钮中的图标放在文字左侧，间距 5–7px。
- 展开图标使用旋转表达展开状态。

禁止：

- 同一操作在不同入口使用不同图标。
- 使用 Emoji 作为功能图标。
- 在 JSX 中重复内嵌常规 SVG。
- 仅通过图标颜色表达错误或成功。
- 用超过 24px 的功能图标填充普通工具栏。

## 7. 通用交互状态

| 状态 | 背景 | 文字/图标 | 边框/阴影 | 行为 |
| --- | --- | --- | --- | --- |
| Default | Transparent 或 Surface | Text 2/3 | Subtle/Default | 可交互 |
| Hover | `--surface-hover` | Text 1 | 可增强一级 | 140ms |
| Active | `--surface-active` | Text 1 | 可使用 inset ring | 不产生布局位移 |
| Selected | Active 或语义淡色 | Text 1 / Accent | 必须有非颜色提示 | 持续状态 |
| Focus Visible | 保持当前背景 | Text 1 | 中性 1–3px ring | 仅键盘焦点 |
| Disabled | 保持结构 | 原色 + 0.52–0.58 opacity | 不强调 | 无 Hover |
| Loading | 保持尺寸 | Spinner/进度文本 | 不抖动 | 禁止重复提交 |
| Danger | Danger 淡色 | Danger | Danger 混合边框 | 必须明确文案 |

### 7.1 Focus

全局已移除浏览器默认 Outline，因此所有自定义可交互组件必须定义 `:focus-visible`。

标准 Focus：

```css
.control:focus-visible {
  outline: 0;
  box-shadow:
    0 0 0 1px color-mix(in srgb, var(--color-border-strong) 54%, transparent),
    0 0 0 3px color-mix(in srgb, var(--surface-hover) 50%, transparent);
}
```

禁止：

- 只定义 `:hover`，不定义 `:focus-visible`。
- 对所有控件统一使用高饱和蓝色外圈。
- 使用 `outline: none` 后不提供替代反馈。

### 7.2 状态属性

优先使用：

```tsx
<button
  aria-expanded={open}
  aria-pressed={selected}
  data-active={selected}
  data-loading={loading}
/>
```

对应样式：

```css
.button[data-active="true"] { /* selected */ }
.button[data-loading="true"] { /* loading */ }
.button[aria-expanded="true"] { /* open */ }
.button:disabled { /* disabled */ }
```

禁止通过拼接 `active-blue selected-dark compact-v2` 等视觉类名表达状态。

## 8. 组件规范

### 8.1 Button

#### 尺寸

| 类型 | 高度 | 横向 Padding | 字号 | 圆角 |
| --- | ---: | ---: | ---: | ---: |
| Compact | 28px | 8–9px | 11–12px | 4–6px |
| Default | 30px | 10–12px | 12px | 6–8px |
| Form / Emphasis | 32–36px | 12–14px | 12–13px | 8px |
| Icon Compact | 28×28px | 0 | 图标 13–14px | 4px 或 Pill |
| Icon Default | 30–32px | 0 | 图标 14–16px | 6px 或 Pill |

#### 变体

| 变体 | 背景 | 边框 | 文字 |
| --- | --- | --- | --- |
| Ghost | Transparent | 无 | Text 2/3 |
| Secondary | Elevated | Default | Text 2 |
| Primary | Text 1 或 Text 1 的 8–12% 混合 | 弱边框 | Elevated / Text 1 |
| Danger | Danger 的 12–18% 混合 | Danger 混合 | Danger |

Keydex 的 Primary 是中性高对比操作，不默认使用 Accent 蓝/粉背景。

必须：

- 一个操作组最多一个 Primary。
- 删除、丢弃、强制覆盖使用 Danger。
- Loading 时保持按钮原宽度。
- Icon Button 提供 `aria-label` 和 Tooltip。

禁止：

- 用 Accent 色把每个“确定”按钮都变成蓝色或粉色。
- 在同一行放置两个同权重 Primary。
- Disabled 时继续触发 Tooltip 之外的交互。

### 8.2 Input 与 Textarea

| 属性 | Compact | Default / Settings | A2UI |
| --- | ---: | ---: | ---: |
| 高度 | 28–30px | 32–34px | 36px |
| 字号 | 11–12px | 12–13px | 12–13px |
| 横向 Padding | 8px | 9–12px | 10–12px |
| 圆角 | 6px | 6–8px | 8–14px，按容器层级 |
| 边框 | Default | Default | Default |

Textarea：

- 最小高度按内容场景定义，不低于 72px。
- 代码、命令、JSON 使用 `--font-mono`。
- 长内容允许垂直 Resize；固定 Composer 除外。

错误状态：

- 使用 Danger Border + 错误文本。
- 错误文本字号 11px。
- 不得只改变 Placeholder 颜色。

### 8.3 Settings Select

标准组件：`SettingsSelect`

| 属性 | Regular | Compact |
| --- | ---: | ---: |
| 触发器宽度 | 最大 310px | 最大 240px |
| 触发器高度 | 34px | 30px |
| 当前值字号 | 13px | 12px |
| Dropdown 最大宽度 | 360px | 360px |
| Option 最小高度 | 48px | 36px |
| 带说明 Option | 48px | 44px |
| Dropdown 圆角 | 12px | 12px |
| Option 圆角 | 8px | 7px |

规则：

- 当前选项使用背景和 Check 图标双重表达。
- Dropdown 超高时内部滚动。
- 小于 680px 时 Trigger 占满可用宽度。
- 禁止用原生 `<select>` 复刻 Settings Select 的视觉。

### 8.4 Toggle

标准组件：`SettingsToggle`

| 部位 | 尺寸 |
| --- | ---: |
| 点击区域 | 42×34px |
| Track | 34×20px |
| Thumb | 16×16px |
| Track Padding | 2px |
| Thumb 位移 | 14px |

| 状态 | 样式 |
| --- | --- |
| Off | `--color-border-3` Track |
| On | `--color-accent` Track |
| Hover/Focus | 外层弱 Hover + 3px Ring |
| Active | 整体缩放 0.96 |
| Disabled | 0.58 Opacity，无 Active |

必须使用 `role="switch"` 或原生等价语义，并提供 `aria-checked`。

### 8.5 Menu 与 Context Menu

标准入口：`AppContextMenuProvider`

| 属性 | 值 |
| --- | ---: |
| 最小宽度 | 118px |
| 最大宽度 | 220px |
| 外层 Padding | 6px |
| 项间距 | 3px |
| Item 高度 | 28px |
| Item 横向 Padding | 9px |
| 图标列 | 14px |
| 圆角 | Menu 12px；Item 4px |
| 字号 | 12px |
| Submenu 间距 | 6px |

规则：

- 菜单项文字单行截断。
- 分隔线只用于语义分组。
- Danger Item 必须同时有 Danger 文本或图标。
- 子菜单必须支持键盘和焦点进入。
- 菜单出现方向由可用视口空间决定。

### 8.6 Dialog

标准入口：`AppDialog`

| Size | 宽度 | 高度/上限 | 圆角 | 用途 |
| --- | --- | --- | ---: | --- |
| `confirm` | 420px | 内容自适应 | 14px | 确认、危险操作 |
| `form` | 520px | 最大 720px | 16px | 普通表单 |
| `search` | 720px | 最大 720px | 8px | 搜索、命令面板 |
| `drawer` | 560px | 100% | 0 | 右侧详情 |
| `fullscreen` | 最大 1320px | 最大 860px | 12px | 大型数据表面 |

结构：

1. Header
2. Body
3. Footer

必须：

- 捕获并循环焦点。
- `Escape` 关闭可取消 Dialog。
- 关闭后恢复触发元素焦点。
- Header 标题单行截断。
- Body 是唯一内部滚动区。
- Footer 操作右对齐，间距 8px。
- 危险操作位于最右侧。

禁止：

- 在页面组件中自行实现 Fixed Backdrop。
- Dialog 内再打开同层 Dialog；应使用 Drawer、Popover 或步骤切换。
- Header、Body 和 Footer 同时产生垂直滚动。

### 8.7 Tooltip

标准入口：`AppTooltipLayer`

| 类型 | 最大宽度 | Padding | 字号 | 行高 |
| --- | ---: | --- | ---: | ---: |
| 单行 | 280px | 5px 8px | 12px | 1.4 |
| 多行 | 320px | 8px 10px | 12px | 1.55 |

| 属性 | 标准 |
| --- | --- |
| 与目标距离 | 8px |
| 圆角 | 6px |
| 进入时间 | 120ms |
| Pointer Events | None |
| Backdrop Blur | 18px |

Tooltip 只用于补充说明，不得承载必须点击的操作。

### 8.8 Toast

标准入口：`NotificationProvider`

| 属性 | 标准 |
| --- | --- |
| 位置 | 标题栏下方 10px，水平居中 |
| 最小宽度 | 210px |
| 最大宽度 | 520px |
| 展开宽度 | 640px |
| 最小高度 | 38px |
| 默认圆角 | Pill |
| 展开圆角 | 18px |
| 字号 | 12px |
| 图标 | 16px |
| 操作按钮 | 22px 高 |

类型：Success、Error、Warning、Info。

规则：

- 标题不超过短语长度。
- 单行消息截断时必须允许展开。
- 错误详情展开后保留换行，并允许内部滚动。
- Toast 不作为确认对话框。
- 不得因新 Toast 到来导致 Composer 或页面布局移动。

### 8.9 Chip、Badge、Pill

| 类型 | 高度 | 字号 | 圆角 |
| --- | ---: | ---: | --- |
| Micro Badge | 16–18px | 9–10px | Pill |
| Metadata Chip | 22–24px | 10–11px | Pill |
| Context Chip | 28–30px | 11–12px | Pill |

规则：

- Chip 内部文字单行截断。
- 可删除 Chip 的关闭按钮点击区不得小于 18×18px。
- 状态 Badge 使用图标、圆点或文字辅助颜色。
- 不得将普通按钮伪装成 Badge。

### 8.10 Loading、Empty、Error

| 状态 | 必须包含 |
| --- | --- |
| Loading | 稳定占位、进度图形或文本、不可重复触发 |
| Empty | 发生了什么、下一步操作；必要时一个主操作 |
| Error | 简短结论、可理解原因、恢复操作、可展开技术详情 |

禁止：

- 只显示 Spinner 且没有上下文。
- 用 Toast 替代页面级错误。
- 在错误消失时让主布局发生大幅跳动。

## 9. 应用布局

### 9.1 应用壳层

```text
36px Titlebar
└── Main Layout
    ├── 286px / 58px Sidebar
    └── minmax(0, 1fr) Main Surface
```

规则：

- Shell 高度必须锁定到可用视口。
- Grid/Flex 子项必须设置 `min-width: 0`、`min-height: 0`。
- 页面只允许一个主垂直滚动容器。
- 固定工具栏和 Composer 不得成为第二个页面滚动源。

### 9.2 Titlebar

| 属性 | 值 |
| --- | ---: |
| 高度 | 36px |
| 背景 | `--sidebar-bg` |
| 品牌按钮 | 30×30px |
| 品牌图 | 18×18px |
| 模式切换容器 | 30px 高 |
| 模式项 | 24px 高 |
| 窗口控制 | 40×36px |

Titlebar 必须保留可拖拽区域；交互元素不得覆盖拖拽区域。

### 9.3 Sidebar

| 属性 | 展开 | 折叠 |
| --- | ---: | ---: |
| 宽度 | 286px | 58px |
| 外边距 | 12px 7px 10px | 左 10px |
| 主分组间距 | 14px | 14px |
| 行高 | 28–32px | 28–32px |
| 行圆角 | Pill | Pill |

规则：

- Active 使用弱填充和必要标记，不使用高饱和整行背景。
- 行尾操作在 Hover、Focus Within 或菜单打开时显示。
- 标题、项目名和会话名必须截断并可查看完整值。
- 折叠状态只保留图标和 Tooltip。

### 9.4 Reading Column

```css
width: min(
  var(--content-reading-width),
  calc(100vw - var(--sidebar-width) - 72px)
);
max-width: 100%;
margin: 0 auto;
```

文档、长文本和普通会话内容使用 780–800px 基准宽度。数据表、Diff、Terminal、Browser 可以占满工作区。

### 9.5 Settings

- 左侧导航与内容区保持稳定双栏。
- Setting Row 默认使用平面列表，不逐项加卡片。
- Label 使用 12–13px，说明使用 11px。
- 控件右对齐，常规宽度最大 310px。
- 窄于 680px 时改为上下布局，控件占满宽度。
- 普通设置保存反馈使用行内状态或 Toast，不弹确认框。

### 9.6 Workbench

- Tab 高度固定 34px。
- Pane 边界使用 Subtle Border。
- 数据表面允许满宽，不套 Reading Column。
- Assistant 浮动、展开、抽屉形态使用既有几何变量和 `workbenchAssistantGeometry`。
- 不得在新功能中复制 Assistant 的 20–34px 特殊圆角。

### 9.7 Git

- 默认字号 11–12px；哈希、日期、路径可用 10px。
- 工具按钮 28–30px。
- 列表行 28–34px。
- 表单控件 28–32px。
- 增删改必须使用 Diff Token。
- 危险 Git 操作必须使用 Danger 状态和确认步骤。

### 9.8 Browser

| 属性 | 值 |
| --- | ---: |
| 顶部复合工具区 | 最小 40px |
| 地址/标签行 | 34px |
| 工具按钮 | 28px |
| 字号 | 11–12px |

浏览器 WebView 是原生表面。任何 Dialog、Menu、Tooltip 或标注层覆盖 Browser 时必须同步处理 WebView 可见性或裁剪区域。

### 9.9 Terminal

- Terminal 内容使用 `--font-mono`。
- Terminal 内容背景允许使用专用深色表面；壳层仍使用 Keydex Token。
- Terminal Dock 工具栏遵循 28–30px 控件规格。
- 搜索、复制、关闭等操作必须支持键盘。
- 不得用普通 UI 字体渲染终端内容。

## 10. 会话与 Agent

### 10.1 Message List

| 属性 | 标准 |
| --- | --- |
| 内容宽度 | `--composer-width`，780px |
| 用户消息最大宽度 | 568px |
| 窄屏用户消息 | 最大 92% |
| Notice 最大宽度 | 720px |
| Context Chip 最大宽度 | 340px |

规则：

- Message List 是会话页唯一主滚动容器。
- 新消息追加时仅在用户处于跟随底部状态时自动滚动。
- 历史加载不得重置当前阅读位置。
- 时间和操作只在 Hover、Focus 或明确展开时出现。

### 10.2 User Message

| 属性 | 标准 |
| --- | --- |
| 对齐 | 右侧 |
| 背景 | `--message-user-bg` |
| 圆角 | 14px |
| 正文字号 | 13px |
| 行高 | 1.7–1.72 |
| 最大宽度 | 568px |

### 10.3 Assistant Message

- 普通会话默认不使用实心气泡。
- 内容直接落在 Reading Column 中。
- Markdown 使用 14px / 1.7。
- Tool、Command、File Change 使用独立 Inline Block。
- Workbench Assistant 可通过局部 Token 使用弱透明气泡，不得反向影响普通会话。

### 10.4 Composer

| 属性 | 标准 |
| --- | --- |
| 基准宽度 | 780px |
| 外框圆角 | 18–20px |
| 输入最小高度 | 44–48px |
| 输入最大高度 | 188px |
| 输入字号 | 14px |
| 输入行高 | 1.45–1.55 |
| Toolbar 最小高度 | 40px |
| Context Chip | 30px |
| Attachment Preview | 66×66px |
| Attachment Button | 30×30px |
| Send / Stop | 32×32px |

规则：

- Composer 位于页面 Grid 的底部行，不使用 `position: fixed`。
- 输入增长到最大高度后内部滚动。
- 发送按钮使用 `--color-text-1` 实心背景，而不是 Accent。
- Running 时发送入口切换为 Stop，尺寸和位置保持不变。
- Context、附件和运行状态不得覆盖输入正文。

### 10.5 Tool、Command 和 File Change

- 标题行使用 11–12px。
- 命令、路径、哈希使用 `--font-mono`。
- 默认展示摘要；详情按需展开。
- Running、Success、Warning、Error 必须有文字或图标。
- 文件变更使用 Diff Token。
- 错误详情必须可复制。
- 不得在每个 Tool Block 上使用高饱和状态背景。

## 11. Markdown、代码和数据表面

### 11.1 Markdown

| 元素 | 标准 |
| --- | --- |
| 正文 | 14px / 1.7 |
| H1 | 23px / 1.25 |
| H2–H6 | 16px / 1.35 |
| Inline Code | 0.9em，`--code-bg` |
| Code Block | 12px / 1.55 |
| Code Header | 11px |
| 阅读宽度 | 800px |

规则：

- 使用 `.keydex-markdown` 全局契约。
- 组件不得复制 Markdown Heading、List、Table 样式。
- 长 URL、路径和代码允许断行或横向滚动。
- 表格由运行时根据内容选择 Wrap 或 Scroll。
- Mermaid、图片和代码块必须遵循运行时资源加载与尺寸契约。

### 11.2 Code

- 使用 `--font-mono`。
- 使用 `--syntax-*` Token。
- 保留空格、制表符和换行。
- Code Block 具有独立 Header 和复制操作。
- 大代码块允许虚拟化或内部滚动。
- 禁止对代码区域应用普通正文的 `overflow-wrap: anywhere`。

### 11.3 Diff

- 使用统一 Diff Token，不重新定义红绿主题。
- Gutter 和代码正文保持独立对齐。
- Selection、Annotation、Search Match 不能复用同一种背景。
- Split/Aligned Diff 在窄容器中允许横向滚动，不强制压缩代码列。
- Diff Toolbar 控件使用 28–30px。
- 变更状态必须同时使用符号、文字或边线。

### 11.4 A2UI

| 表面 | 标准 |
| --- | --- |
| 外层 Block | 最大 760px |
| Form | 最大 800px |
| Chart | 最大 560px |
| Table Fullscreen | 最大 1320px |
| 表单控件 | 36px |
| 表单主表面圆角 | 18px |
| 内部分组圆角 | 14px |
| 默认 UI 字号 | 12px |

规则：

- A2UI 外层保持透明，不增加统一大卡片。
- Form、Choice、Table、Chart 各自定义内部信息层级。
- AG Grid 通过 CSS 自定义属性桥接 Keydex Token。
- ECharts 颜色从主题 Token 生成。
- A2UI 流式揭示必须支持 Reduced Motion。
- 纠错、确认和提交状态必须可通过键盘操作。

### 11.5 第三方组件

必须桥接：

| 第三方 | 桥接内容 |
| --- | --- |
| CodeMirror | 背景、文字、边框、Selection、Syntax |
| Xterm | 内容背景、文字、Selection、光标 |
| AG Grid | Background、Foreground、Border、Header、Row Hover、Font |
| ECharts | Text、Axis、Grid、Series、Tooltip |
| Mermaid | Background、Text、Line、Node、Cluster |
| Pierre Diff | 全部 `--diff-*` 语义 |

禁止在 React 初始化配置中写死只适用于 Light 的 Slate/Gray 色板。

## 12. 响应式和滚动

### 12.1 响应式原则

- 桌面优先，应用最小宽度 360px。
- 组件优先使用 Container Query。
- 页面级结构变化使用 Media Query。
- 窄屏优先保留内容和主操作，隐藏辅助操作。
- 不通过缩小到 9px 以下解决空间不足。

常用现有边界：

| 宽度 | 处理 |
| ---: | --- |
| 860px | 会话宽度和用户消息收敛 |
| 760px | A2UI Form 布局收敛 |
| 720px | A2UI Choice/Debug 收敛 |
| 680px | Settings、Composer、Select 改为窄布局 |
| 640px | Toast 视口边距收敛 |
| 520px | A2UI 紧凑状态 |
| 440px | A2UI Form 单列 |
| 420px | A2UI Block 满宽 |
| 360px Container | Composer 工具项换行 |

不得仅因表格过宽就添加新的全局 Breakpoint；优先使用局部滚动或 Container Query。

### 12.2 滚动

标准滚动条：

```css
scrollbar-width: thin;
scrollbar-color: var(--color-border-3) transparent;
```

WebKit：

```css
::-webkit-scrollbar {
  width: 8px;
  height: 8px;
}

::-webkit-scrollbar-thumb {
  border: 2px solid transparent;
  border-radius: var(--radius-pill);
  background: var(--color-border-3);
  background-clip: padding-box;
}
```

规则：

- 页面、Dialog Body、Menu Options 各自只能有一个明确滚动所有者。
- 横向代码、Diff、Table 可以拥有局部横向滚动。
- 内嵌滚动区使用 `overscroll-behavior: contain`。
- 不得在未知高度的 Flex/Grid 子项上直接添加 `overflow: auto` 而不设置 `min-height: 0`。

## 13. 可访问性

### 13.1 必须项

- 所有交互元素可通过键盘到达。
- Icon Button 有 `aria-label`。
- Toggle 有 `role="switch"`/原生等价语义和 `aria-checked`。
- 展开控件有 `aria-expanded`。
- 当前选项有 `aria-selected`、`aria-current` 或等价语义。
- Dialog 有可关联标题，且实现焦点陷阱与焦点恢复。
- 状态变化通过文本、图标或 Live Region 传达。
- `prefers-reduced-motion: reduce` 下移除非必要动画。
- 高对比度模式下保留边界、选中和焦点。

### 13.2 对比度

| 内容 | 最低目标 |
| --- | ---: |
| 普通文本 | 4.5:1 |
| 大文本 | 3:1 |
| 图标、控件边界、Focus | 3:1 |

`--color-text-4` 不满足所有正文场景，只允许用于非关键辅助信息。

### 13.3 Reduced Motion

每个新增动画模块必须包含：

```css
@media (prefers-reduced-motion: reduce) {
  .animated {
    animation: none;
    transition: none;
  }
}
```

加载 Spinner 可以保留旋转，但不得同时位移或缩放。

## 14. CSS 实现标准

### 14.1 文件组织

```text
Component.tsx
Component.module.css
Component.test.tsx
```

组件样式默认与组件同目录。跨模块公共样式只允许进入：

- `renderer/styles/themes/`
- `renderer/styles/layout.css`
- `renderer/styles/markdown.css`
- `styles.css`

### 14.2 推荐模板

```tsx
import styles from "./ExampleControl.module.css";

interface ExampleControlProps {
  active?: boolean;
  disabled?: boolean;
  loading?: boolean;
}

export function ExampleControl({
  active = false,
  disabled = false,
  loading = false,
}: ExampleControlProps) {
  return (
    <button
      className={styles.root}
      type="button"
      disabled={disabled || loading}
      data-active={active}
      data-loading={loading}
      aria-pressed={active}
    >
      <span className={styles.label}>操作</span>
    </button>
  );
}
```

```css
.root {
  min-width: 0;
  height: 30px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 6px;
  border: 1px solid var(--color-border-default);
  border-radius: var(--radius-sm);
  background: var(--color-bg-elevated);
  color: var(--color-text-secondary);
  font-size: 12px;
  padding: 0 10px;
  transition:
    background-color var(--motion-fast) var(--motion-ease-out),
    border-color var(--motion-fast) var(--motion-ease-out),
    color var(--motion-fast) var(--motion-ease-out),
    box-shadow var(--motion-fast) var(--motion-ease-out);
}

.root:hover:not(:disabled) {
  background: var(--surface-hover);
  color: var(--color-text-primary);
}

.root[data-active="true"] {
  background: var(--surface-active);
  color: var(--color-text-primary);
}

.root:focus-visible {
  outline: 0;
  box-shadow: 0 0 0 2px
    color-mix(in srgb, var(--color-border-strong) 46%, transparent);
}

.root:disabled {
  cursor: default;
  opacity: 0.55;
}

@media (prefers-reduced-motion: reduce) {
  .root {
    transition: none;
  }
}
```

### 14.3 CSS 属性顺序

新增 CSS 按以下顺序排列：

1. CSS 自定义属性；
2. Position；
3. Box model；
4. Display / Grid / Flex；
5. Overflow；
6. Border / Background；
7. Typography；
8. Interaction；
9. Transform / Transition / Animation；
10. Filter / Backdrop Filter。

### 14.4 内联样式

允许：

- 运行时测量出的坐标、宽高；
- 拖拽和 Resize 几何值；
- 图表库只能通过 JS 传入的动态值；
- 通过 CSS 自定义属性向模块传递运行时参数。

推荐：

```tsx
<div
  className={styles.panel}
  style={{ "--panel-width": `${width}px` } as React.CSSProperties}
/>
```

禁止：

```tsx
<div
  style={{
    color: "#555",
    background: "#fff",
    borderRadius: 8,
    padding: 12,
  }}
/>
```

### 14.5 禁止项

- 新增全局视觉类名。
- 在功能模块定义 `body`、`button`、`input` 全局规则。
- 硬编码主题颜色。
- 为解决层级问题写任意超大 z-index。
- 使用 `transition: all`。
- 使用 `outline: none` 而无 Focus 替代。
- 使用 Emoji 作为产品图标。
- 使用卡片嵌套卡片表达普通层级。
- 通过缩小字体掩盖布局问题。
- 在不同页面复制同一 Select、Dialog、Tooltip 或 Context Menu。

## 15. 评审清单

### 15.1 Token

- [ ] 颜色全部来自现有语义 Token。
- [ ] Light 和 Dark 不需要复制结构 CSS。
- [ ] 使用现有圆角、阴影和动效 Token。
- [ ] 没有新增同义 Token。
- [ ] Diff、Syntax、第三方组件完成主题桥接。

### 15.2 尺寸与排版

- [ ] 字号属于允许层级。
- [ ] 控件高度属于 28/30/32/34/36px 体系。
- [ ] 间距属于标准序列。
- [ ] Icon Button 点击区至少 28×28px。
- [ ] 文本截断后仍可查看完整值。

### 15.3 状态

- [ ] Default、Hover、Active、Focus、Disabled 均有定义。
- [ ] Loading 不改变组件尺寸。
- [ ] Selected 不只依赖颜色。
- [ ] Danger 有文字或图标语义。
- [ ] Reduced Motion 已覆盖。

### 15.4 布局

- [ ] 页面只有一个主滚动容器。
- [ ] Flex/Grid 子项具有正确的 `min-width: 0` / `min-height: 0`。
- [ ] 窄容器下主操作仍可用。
- [ ] Browser/Terminal 原生表面遮挡已处理。
- [ ] 没有不必要的卡片或阴影。

### 15.5 可访问性

- [ ] 全部操作可键盘完成。
- [ ] Icon Button 有辅助名称。
- [ ] Focus Visible 清晰可见。
- [ ] Dialog 焦点陷阱和恢复正确。
- [ ] 文本和非文本对比度达标。
- [ ] 状态变化不只使用颜色。

## 16. 验收矩阵

每个新共享组件至少验证：

| 维度 | 组合 |
| --- | --- |
| Theme | Light、Dark |
| Scale | 100%、125%、150% |
| Width | 默认、窄容器、360px 最小应用宽度 |
| Input | Mouse、Keyboard |
| State | Default、Hover、Focus、Active、Disabled、Loading、Error |
| Motion | Normal、Reduced Motion |
| Content | 中文、英文、长路径、长错误、空值 |

视觉验收必须验证最终可见结果，不能只断言事件触发或路由变化。

## 17. 代码入口

### Token 与全局

- `desktop/src/renderer/styles/themes/base.css`
- `desktop/src/renderer/styles/themes/default-color-scheme.css`
- `desktop/src/renderer/styles/themes/index.css`
- `desktop/src/renderer/styles/layout.css`
- `desktop/src/renderer/styles/markdown.css`
- `desktop/src/styles.css`

### Provider

- `desktop/src/renderer/providers/ThemeProvider.tsx`
- `desktop/src/renderer/providers/FontProvider.tsx`
- `desktop/src/renderer/providers/NotificationProvider.tsx`
- `desktop/src/renderer/providers/AppContextMenuProvider.tsx`

### 共享组件

- `desktop/src/renderer/components/dialog/AppDialog.tsx`
- `desktop/src/renderer/components/dialog/DialogButton.tsx`
- `desktop/src/renderer/components/floating/FloatingLayer.tsx`
- `desktop/src/renderer/components/tooltip/AppTooltipLayer.tsx`
- `desktop/src/renderer/pages/settings/components/SettingsSelect.tsx`
- `desktop/src/renderer/pages/settings/components/SettingsToggle.tsx`
- `desktop/src/renderer/components/chat/SendBox/SendBox.tsx`

### 核心表面

- `desktop/src/renderer/components/layout/Titlebar/Titlebar.module.css`
- `desktop/src/renderer/components/layout/Sider/Sider.module.css`
- `desktop/src/renderer/pages/conversation/messages/MessageList.module.css`
- `desktop/src/renderer/pages/conversation/messages/MessageText.module.css`
- `desktop/src/renderer/pages/workbench/WorkbenchModePage.module.css`
- `desktop/src/renderer/pages/workbench/WorkbenchAssistantSurface.module.css`
- `desktop/src/renderer/features/browser/ui/BrowserPanel.module.css`
- `desktop/src/renderer/features/terminal/TerminalDock.module.css`
- `desktop/src/renderer/components/diff/`
- `desktop/src/renderer/pages/conversation/messages/a2ui/`

### 契约测试

- `desktop/tests/style-foundation.spec.ts`
- `desktop/tests/theme-tokens.spec.ts`
- `desktop/tests/aligned-diff-theme-tokens.spec.ts`

## 18. 偏离规范

只有以下情况可以偏离：

- 原生平台控件限制；
- 第三方组件无法通过现有接口实现；
- 数据可视化或代码表面有明确的专业语义；
- 为兼容已有交互而进行的局部过渡。

偏离时必须：

1. 在组件 CSS 附近写明原因；
2. 使用局部 Token，不修改全局 Token；
3. 同时验证 Light、Dark 和键盘操作；
4. 不把例外复制到其他组件；
5. 在后续公共能力补齐后移除例外。
