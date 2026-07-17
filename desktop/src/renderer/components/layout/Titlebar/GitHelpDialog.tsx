import { AlertTriangle, GitBranch, ShieldCheck } from "lucide-react";

import { AppDialog } from "@/renderer/components/dialog";

import styles from "./ProjectGitMenu.module.css";

export function GitHelpDialog({ onClose }: { onClose: () => void }) {
  return (
    <AppDialog
      title="Git 操作与风险说明"
      description={<span className={styles.helpEyebrow}><GitBranch size={13} /> Git 工作台</span>}
      size="form"
      backdrop="plain"
      closeLabel="关闭 Git 帮助"
      closeOnOverlayClick={false}
      onClose={onClose}
    >
      <div className={styles.helpBody}>
          <section>
            <h3>两个入口，同一项目状态</h3>
            <p>顶部菜单用于更新、提交、推送、切换分支等高频动作；左侧 Git 入口会在主内容区打开完整面板，用于改动、历史、分支、远程、冲突和高级操作。所有命令只作用于当前项目中选定的 Git 根。</p>
          </section>
          <section>
            <h3><ShieldCheck size={14} /> 风险与确认</h3>
            <ul>
              <li><strong>只读：</strong>状态、差异、历史、逐行历史、引用记录，不修改仓库。</li>
              <li><strong>写入：</strong>暂存、提交、切换、合并等会改变本地仓库，执行前展示目标和影响。</li>
              <li><strong>高风险：</strong>强制推送、硬重置、删除、中止、跳过等操作要求与当前任务绑定的二次确认。</li>
            </ul>
            <p>“更新项目”按 PyCharm 的交互结构提供合并与变基两种方式；Keydex 只执行弹窗中确认的方式，失败后不会自动切换。</p>
          </section>
          <section>
            <h3><AlertTriangle size={14} /> 授权、认证与恢复</h3>
            <p>项目目录位于某个仓库内部时，必须显式授权祖先仓库；多 Git 根分别选择和执行。远程命令保持非交互，不会在后台弹出凭据窗口，认证失败会给出帮助动作。冲突和未完成操作会从仓库元数据恢复，可继续、跳过或中止。</p>
          </section>
          <section>
            <h3>大文件存储与能力边界</h3>
            <p>强制推送只使用带租约保护的方式。安装 Git 大文件存储扩展后可查看跟踪模式、对象和锁，并执行常用的获取、拉取和推送；Keydex 不会自动安装该扩展。本工作台参考 PyCharm 的操作组织，但不声明与 PyCharm 完全兼容。</p>
          </section>
          <footer>
            完整说明收录在内置 Keydex 产品指南的“Git 工作台”章节。开源参考：Stack-Cairn/LiveAgent，固定提交 1616eb5e574274693dc29e18248650dc30911123，采用 MIT 许可证；详细归属与改写边界见该章节末尾的 LiveAgent 归属说明。
          </footer>
      </div>
    </AppDialog>
  );
}
