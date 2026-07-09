import styles from "./ProjectModePage.module.css";

export function ProjectModePage() {
  return (
    <main className={styles.root} data-testid="project-mode-page" aria-label="项目模式">
      <iframe className={styles.demoFrame} src="/project-mode-demo.html" title="Keydex 项目模式 Demo" />
    </main>
  );
}
