import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const scannedRoots = [
  resolve(repoRoot, "desktop/src/renderer"),
  resolve(repoRoot, "backend/app"),
];

const forbiddenVisibleEnglish = [
  "Enter 发送",
  "Agent Runtime",
  "Agent 正在处理",
  "Python Agent Runtime",
  "新增 Provider",
  "编辑 Provider",
  "删除 Provider",
  "暂无 Provider",
  "Provider 可用",
  "Provider 已停用",
  "读取 Provider",
  "Provider 保存失败",
  "Provider 不存在",
  "Provider 名称",
  "OpenAI-compatible Provider",
  "未保存 Key",
  "Base URL",
  "API Key",
];

describe("localization", () => {
  it("keeps known visible product phrases in Chinese", () => {
    const offenders: string[] = [];
    for (const filePath of scannedRoots.flatMap(collectSourceFiles)) {
      const content = readFileSync(filePath, "utf8");
      for (const phrase of forbiddenVisibleEnglish) {
        if (content.includes(phrase)) {
          offenders.push(`${relative(filePath)}: ${phrase}`);
        }
      }
    }

    expect(offenders).toEqual([]);
  });
});

function collectSourceFiles(root: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(root)) {
    const path = resolve(root, entry);
    const stat = statSync(path);
    if (stat.isDirectory()) {
      files.push(...collectSourceFiles(path));
    } else if (/\.(ts|tsx|py)$/.test(entry)) {
      files.push(path);
    }
  }
  return files;
}

function relative(path: string): string {
  return path.replace(`${repoRoot}\\`, "").replace(/\\/g, "/");
}
