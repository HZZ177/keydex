# Keydex 发布说明

每次发版前，在本目录创建与版本号对应的 Markdown 文件：

```text
.github/release-notes/v0.3.12.md
```

运行 `Windows Release` 工作流时只需要输入版本号。`release_notes_file` 留空后，流水线会自动读取 `.github/release-notes/v<version>.md`；只有在说明文件位于其他仓库内路径时才需要填写该输入项。

同一份 Markdown 会被用于：

- GitHub Release 正文；
- 应用更新清单 `latest.json` 的 `notes` 字段；
- Keydex 的应用内更新弹窗。

请保留 Markdown 的真实换行，在标题、正文和列表之间留空行。不要再把完整说明粘贴到 GitHub Actions 的单行字符串输入中。
