import { Boxes, RefreshCw, Unplug } from "lucide-react";
import { useEffect, useMemo, useState } from "react";

import type { GitSubmodule, GitSubmodulesSnapshot } from "@/runtime/gitTypes";

import { GitConfirmActionDialog } from "../dialogs";
import styles from "./GitSubmoduleView.module.css";

export type GitSubmoduleAction = "init" | "update" | "sync" | "deinit";

export function GitSubmoduleView({
  snapshot,
  loading,
  busy,
  onAction,
}: {
  snapshot: GitSubmodulesSnapshot | null;
  loading: boolean;
  busy: boolean;
  onAction: (action: GitSubmoduleAction, paths: readonly string[], recursive: boolean, force: boolean) => void;
}) {
  const [selected, setSelected] = useState<readonly string[]>([]);
  const [recursive, setRecursive] = useState(false);
  const [pendingAction, setPendingAction] = useState<GitSubmoduleAction | null>(null);
  useEffect(() => {
    setSelected((current) => {
      const available = new Set(snapshot?.submodules.map((module) => module.path) ?? []);
      const retained = current.filter((path) => available.has(path));
      return retained.length ? retained : [...available];
    });
  }, [snapshot]);
  useEffect(() => setPendingAction(null), [snapshot?.repositoryId, snapshot?.repositoryVersion]);
  const selectedModules = useMemo(
    () => snapshot?.submodules.filter((module) => selected.includes(module.path)) ?? [],
    [selected, snapshot],
  );
  if (loading) return <section className={styles.root} aria-label="Git 子模块"><p>正在读取子模块…</p></section>;
  if (!snapshot?.submodules.length) return <section className={styles.root} aria-label="Git 子模块"><header><Boxes size={14} /><strong>子模块</strong></header><p>此仓库尚未配置子模块。</p></section>;
  const run = (action: GitSubmoduleAction) => {
    if (action === "deinit" || recursive) setPendingAction(action);
    else onAction(action, selected, false, false);
  };
  return (
    <section className={styles.root} aria-label="Git 子模块">
      <header><Boxes size={14} /><div><strong>子模块</strong><span>父仓库 {snapshot.repositoryId}</span></div></header>
      <ul>{snapshot.submodules.map((module) => (
        <SubmoduleRow
          key={module.path}
          module={module}
          checked={selected.includes(module.path)}
          onToggle={() => setSelected((current) => current.includes(module.path) ? current.filter((path) => path !== module.path) : [...current, module.path])}
        />
      ))}</ul>
      <label className={styles.recursive}><input type="checkbox" checked={recursive} onChange={(event) => setRecursive(event.target.checked)} />递归包含嵌套子模块</label>
      {recursive ? <aside role="status"><strong>递归影响预览</strong><span>已选择 {selectedModules.length} 个根子模块：{selectedModules.map((module) => module.path).join(", ")}。嵌套仓库也可能被初始化、更新或同步。</span></aside> : null}
      <div className={styles.actions}>
        <button type="button" disabled={busy || !selected.length} onClick={() => run("init")}>初始化</button>
        <button type="button" disabled={busy || !selected.length} onClick={() => run("update")}><RefreshCw size={12} />更新</button>
        <button type="button" disabled={busy || !selected.length} onClick={() => run("sync")}>同步地址</button>
        <button type="button" disabled={busy || !selected.length} onClick={() => run("deinit")}><Unplug size={12} />取消初始化</button>
      </div>
      {pendingAction ? (
        <GitConfirmActionDialog
          title={pendingAction === "deinit" ? "确认取消初始化子模块" : `确认递归${submoduleActionLabel(pendingAction)}`}
          description={pendingAction === "deinit" ? "已签出的子仓库文件会被移除，Git 元数据仍可用于恢复。" : "操作会递归进入所选根子模块下的嵌套仓库。"}
          target={selected.join("、")}
          details={[`根子模块：${selected.length} 个`, `递归：${recursive ? "是" : "否"}`, `动作：${submoduleActionLabel(pendingAction)}`]}
          confirmLabel={pendingAction === "deinit" ? "确认取消初始化" : "确认递归执行"}
          busy={busy}
          onCancel={() => setPendingAction(null)}
          onConfirm={() => { const action = pendingAction; setPendingAction(null); onAction(action, selected, recursive, action === "deinit"); }}
        />
      ) : null}
    </section>
  );
}

function submoduleActionLabel(action: GitSubmoduleAction): string {
  return ({ init: "初始化", update: "更新", sync: "同步地址", deinit: "取消初始化" })[action];
}

function SubmoduleRow({ module, checked, onToggle }: { module: GitSubmodule; checked: boolean; onToggle: () => void }) {
  return (
    <li data-state={module.state}>
      <label><input type="checkbox" aria-label={`选择 ${module.path}`} checked={checked} onChange={onToggle} /><span><strong>{module.path}</strong><small>{submoduleStateLabel(module.state)} · {module.objectId.slice(0, 12)}</small></span></label>
      <dl><div><dt>子仓库根目录</dt><dd>{module.childRootPath ?? "尚未初始化"}</dd></div><div><dt>远程地址</dt><dd>{module.url ?? "尚未配置"}</dd></div></dl>
    </li>
  );
}

function submoduleStateLabel(state: GitSubmodule["state"]): string {
  return ({ uninitialized: "未初始化", initialized: "已初始化", modified: "有改动", missing: "目录缺失", conflict: "存在冲突" } as Partial<Record<GitSubmodule["state"], string>>)[state] ?? "状态未知";
}
