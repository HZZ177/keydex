import { Palette } from "lucide-react";

import styles from "./AppearanceSettingsPage.module.css";

export function AppearanceSettingsPage() {
  return (
    <main className={styles.page} data-testid="appearance-settings-page">
      <header className={styles.header}>
        <div>
          <h1>外观</h1>
          <p>主题等外观配置将在这里提供</p>
        </div>
      </header>

      <section className={styles.placeholder} aria-label="外观设置占位">
        <span className={styles.icon} aria-hidden="true">
          <Palette size={18} />
        </span>
        <div>
          <h2>暂未配置外观选项</h2>
          <p>字体已迁移到设置 - 常规，后续主题配置会放在这里。</p>
        </div>
      </section>
    </main>
  );
}
