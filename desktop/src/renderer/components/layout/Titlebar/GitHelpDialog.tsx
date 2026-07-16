import { AlertTriangle, GitBranch, ShieldCheck, X } from "lucide-react";
import { useEffect, useRef } from "react";
import { createPortal } from "react-dom";

import styles from "./ProjectGitMenu.module.css";

export function GitHelpDialog({ onClose }: { onClose: () => void }) {
  const closeRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    const previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    queueMicrotask(() => closeRef.current?.focus());
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      onClose();
    };
    document.addEventListener("keydown", handleKeyDown, true);
    return () => {
      document.removeEventListener("keydown", handleKeyDown, true);
      previousFocus?.focus();
    };
  }, [onClose]);

  return createPortal(
    <div className={styles.helpOverlay} role="presentation" onMouseDown={(event) => {
      if (event.target === event.currentTarget) onClose();
    }}>
      <section
        className={styles.helpDialog}
        role="dialog"
        aria-modal="true"
        aria-labelledby="git-help-title"
      >
        <header className={styles.helpHeader}>
          <div>
            <span className={styles.helpEyebrow}><GitBranch size={13} /> Git 工作台</span>
            <h2 id="git-help-title">Git 操作与风险说明</h2>
          </div>
          <button ref={closeRef} type="button" aria-label="关闭 Git 帮助" onClick={onClose}>
            <X size={16} />
          </button>
        </header>

        <div className={styles.helpBody}>
          <section>
            <h3>两个入口，同一项目状态</h3>
            <p>顶部菜单用于更新、提交、推送、切换分支等高频动作；左侧 Git 入口会在主内容区打开完整面板，用于改动、历史、分支、远程、冲突和高级操作。所有命令只作用于当前项目中选定的 Git 根。</p>
          </section>
          <section>
            <h3><ShieldCheck size={14} /> 风险与确认</h3>
            <ul>
              <li><strong>只读：</strong>状态、Diff、历史、Blame、Reflog，不修改仓库。</li>
              <li><strong>写入：</strong>暂存、提交、切换、合并等会改变本地仓库，执行前展示目标和影响。</li>
              <li><strong>高风险：</strong>强推、Hard Reset、删除、Abort/Skip 等要求与当前操作绑定的二次确认。</li>
            </ul>
            <p>Update Project 默认使用 ff-only；分支分叉时不会静默降级成 Merge 或 Rebase，必须由用户重新选择策略。</p>
          </section>
          <section>
            <h3><AlertTriangle size={14} /> 授权、认证与恢复</h3>
            <p>项目目录位于某个仓库内部时，必须显式授权祖先仓库；多 Git 根分别选择和执行。远程命令保持非交互，不会在后台弹出凭据窗口，认证失败会给出帮助动作。冲突和未完成操作会从仓库元数据恢复，可继续、跳过或中止。</p>
          </section>
          <section>
            <h3>LFS 与能力边界</h3>
            <p>Force Push 只使用 --force-with-lease。安装 Git LFS 后可查看跟踪模式、对象和锁，并执行常用 fetch/pull/push；Keydex 不会自动安装 LFS。本工作台参考 PyCharm 的操作组织，但不声明与 PyCharm 完全兼容。</p>
          </section>
          <footer>
            完整说明收录在内置 Keydex 产品指南的“Git 工作台”章节。开源参考：Stack-Cairn/LiveAgent，固定提交 1616eb5e574274693dc29e18248650dc30911123，MIT License；详细归属与改写边界见该章节末尾的 LiveAgent attribution。
          </footer>
        </div>
      </section>
    </div>,
    document.body,
  );
}
