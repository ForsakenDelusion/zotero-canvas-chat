# Changelog

本项目变更记录遵循 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/) 约定，版本号遵循 [Semantic Versioning](https://semver.org/lang/zh-CN/)。

## [Unreleased]

## [0.4.22] - 2026-11-21

### Added
- 展开卡片查看完整回答时，支持点击原对话引用编号查看支持段落并跳回 PDF 原文。
- LLM-for-Zotero 独立窗口支持在主区域打开画布并随左侧历史对话同步切换；点击右上角「画布」时按窗口宽度自适应分栏或主区域视图。
- 新增 GNU AGPL-3.0-or-later 开源许可（与 LLM-for-Zotero 一致），并随 `.xpi` 打包附带 `LICENSE`。
- 新增 GitHub Actions CI、Tag 自动发版工作流、版本号同步脚本（`npm run version:bump`）以及 Issue/PR 模板。

### Changed
- **迁移提示**：插件 ID 由 `zotero-canvas-chat@local` 规范化为 `zotero-canvas-chat@forsakendelusion.github.io`。已安装 `0.4.14` 及更早版本的用户升级时请先在 Zotero 插件管理中卸载旧版再安装新版；画布数据（`_zcanvas_data` 笔记）与模型设置会自动保留。
- 清理历史 `companion` 联动版遗留分支，完全对齐官方 LLM-for-Zotero。

## [0.4.14] - 2026-11-21

### Changed
- 改进对话同步回填、分支追问提示词与独立窗口画布集成体验。

## [0.4.12] - 2026-11-21

### Added
- 首个公开版本：在 LLM-for-Zotero 侧栏与独立窗口内提供阅读画布、PDF 摘录与回跳、分支追问、多分支汇聚、整理卡片与总结为 Zotero 阅读笔记。
