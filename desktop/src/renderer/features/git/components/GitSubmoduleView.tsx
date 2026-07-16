import { Boxes, RefreshCw, Unplug } from "lucide-react";
import { useEffect, useMemo, useState } from "react";

import type { GitSubmodule, GitSubmodulesSnapshot } from "@/runtime/gitTypes";

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
  useEffect(() => {
    setSelected((current) => {
      const available = new Set(snapshot?.submodules.map((module) => module.path) ?? []);
      const retained = current.filter((path) => available.has(path));
      return retained.length ? retained : [...available];
    });
  }, [snapshot]);
  const selectedModules = useMemo(
    () => snapshot?.submodules.filter((module) => selected.includes(module.path)) ?? [],
    [selected, snapshot],
  );
  if (loading) return <section className={styles.root} aria-label="Git submodules"><p>Loading submodules…</p></section>;
  if (!snapshot?.submodules.length) return <section className={styles.root} aria-label="Git submodules"><header><Boxes size={14} /><strong>Submodules</strong></header><p>No submodules configured in this repository.</p></section>;
  const run = (action: GitSubmoduleAction) => onAction(action, selected, recursive, action === "deinit");
  return (
    <section className={styles.root} aria-label="Git submodules">
      <header><Boxes size={14} /><div><strong>Submodules</strong><span>Parent repository {snapshot.repositoryId}</span></div></header>
      <ul>{snapshot.submodules.map((module) => (
        <SubmoduleRow
          key={module.path}
          module={module}
          checked={selected.includes(module.path)}
          onToggle={() => setSelected((current) => current.includes(module.path) ? current.filter((path) => path !== module.path) : [...current, module.path])}
        />
      ))}</ul>
      <label className={styles.recursive}><input type="checkbox" checked={recursive} onChange={(event) => setRecursive(event.target.checked)} />Include nested submodules recursively</label>
      {recursive ? <aside role="status"><strong>Recursive impact preview</strong><span>{selectedModules.length} selected root(s): {selectedModules.map((module) => module.path).join(", ")}. Nested repositories may also be initialized, updated, or synchronized.</span></aside> : null}
      <div className={styles.actions}>
        <button type="button" disabled={busy || !selected.length} onClick={() => run("init")}>Initialize</button>
        <button type="button" disabled={busy || !selected.length} onClick={() => run("update")}><RefreshCw size={12} />Update</button>
        <button type="button" disabled={busy || !selected.length} onClick={() => run("sync")}>Sync URLs</button>
        <button type="button" disabled={busy || !selected.length} onClick={() => run("deinit")}><Unplug size={12} />Deinitialize</button>
      </div>
    </section>
  );
}

function SubmoduleRow({ module, checked, onToggle }: { module: GitSubmodule; checked: boolean; onToggle: () => void }) {
  return (
    <li data-state={module.state}>
      <label><input type="checkbox" aria-label={`Select ${module.path}`} checked={checked} onChange={onToggle} /><span><strong>{module.path}</strong><small>{module.state} · {module.objectId.slice(0, 12)}</small></span></label>
      <dl><div><dt>Child root</dt><dd>{module.childRootPath ?? "Not initialized"}</dd></div><div><dt>URL</dt><dd>{module.url ?? "Not configured"}</dd></div></dl>
    </li>
  );
}
