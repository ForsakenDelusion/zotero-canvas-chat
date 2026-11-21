# 贡献与发布规范

## 本地开发

需要 Node.js 22.12+、npm 与 `zip`：

```sh
npm ci
npm run dev    # 启动浏览器预览（使用内置演示数据）
npm run check  # TypeScript 类型检查
npm test       # 运行单元测试
npm run build  # 构建 XPI 与 updates.json（输出至 dist/）
```

涉及画布相关术语时请保持与 [`GLOSSARY.md`](GLOSSARY.md) 一致；沙盒架构决策见 [`docs/adr/0001-sandboxed-canvas.md`](docs/adr/0001-sandboxed-canvas.md)。

## 分支与提交

- `main` 为受保护分支，只通过 Pull Request 从 `dev` 合入。
- 日常开发在 `dev` 或基于 `dev` 的功能分支进行，按功能/修复粒度小步提交。
- 推荐使用 Conventional Commits 前缀（如 `feat:`、`fix:`、`refactor:`、`docs:`、`chore:`）。

## 版本号与发版流程

- 只有代码/产物变更才更新版本号并创建 Release；纯文档或截图更新直接合入 `main`，**不要**打 tag 或发布 Release（避免影响 `updates.json` 自动更新链路）。
- 发版步骤：
  1. 在 `dev` 运行 `npm run version:bump -- <X.Y.Z>`，自动同步 `package.json`、`package-lock.json` 与 `addon/manifest.json`。
  2. 更新 [`CHANGELOG.md`](CHANGELOG.md)，将 `[Unreleased]` 整理为对应版本。
  3. 提 PR 将 `dev` 合入 `main`，等待 CI 全部通过后合并。
  4. 在最新的 `main` 提交上打语义化附注标签并推送：
     ```sh
     git tag -a vX.Y.Z -m "Release Canvas Chat vX.Y.Z"
     git push origin vX.Y.Z
     ```
  5. GitHub Actions（`Release` 工作流）会自动校验版本号、执行检查与测试、打包 `.xpi` 与 `updates.json` 并发布 GitHub Release。
