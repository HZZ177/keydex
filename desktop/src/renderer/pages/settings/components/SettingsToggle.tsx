import styles from "./SettingsToggle.module.css";

export interface SettingsToggleProps {
  checked: boolean;
  disabled?: boolean;
  label: string;
  onChange: (checked: boolean) => void;
}

export function SettingsToggle({ checked, disabled = false, label, onChange }: SettingsToggleProps) {
  return (
    <button
      aria-checked={checked}
      aria-label={label}
      className={styles.toggle}
      data-settings-toggle
      disabled={disabled}
      onClick={() => onChange(!checked)}
      role="switch"
      type="button"
    >
      <span aria-hidden="true" className={styles.track} data-checked={checked ? "true" : "false"}>
        <span className={styles.thumb} />
      </span>
    </button>
  );
}
