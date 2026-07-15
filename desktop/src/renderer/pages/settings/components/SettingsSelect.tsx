import { Check, ChevronDown } from "lucide-react";
import { useEffect, useId, useRef, useState } from "react";

import { FloatingLayer, type FloatingPlacement } from "@/renderer/components/floating";

import styles from "./SettingsSelect.module.css";

const MENU_EXIT_ANIMATION_MS = 120;

export interface SettingsSelectOption<T extends string> {
  description?: string;
  label: string;
  value: T;
}

export interface SettingsSelectProps<T extends string> {
  ariaLabel: string;
  density?: "regular" | "compact";
  disabled?: boolean;
  onChange: (value: T) => void;
  options: Array<SettingsSelectOption<T>>;
  placeholder?: string;
  placement?: FloatingPlacement;
  value: T | null;
}

export function SettingsSelect<T extends string>({
  ariaLabel,
  density = "regular",
  disabled = false,
  onChange,
  options,
  placeholder = "请选择",
  placement = "bottom",
  value,
}: SettingsSelectProps<T>) {
  const menuId = useId();
  const rootRef = useRef<HTMLDivElement | null>(null);
  const menuRef = useRef<HTMLDivElement | null>(null);
  const closeTimerRef = useRef<number | null>(null);
  const [open, setOpen] = useState(false);
  const [closing, setClosing] = useState(false);
  const selectedOption = options.find((option) => option.value === value) ?? null;
  const triggerLabel = selectedOption?.label ?? placeholder;

  const clearCloseTimer = () => {
    if (closeTimerRef.current !== null) {
      window.clearTimeout(closeTimerRef.current);
      closeTimerRef.current = null;
    }
  };

  const openMenu = () => {
    clearCloseTimer();
    setClosing(false);
    setOpen(true);
  };

  const closeMenu = () => {
    if (!open && !closing) {
      return;
    }
    clearCloseTimer();
    setOpen(false);
    if (prefersReducedMotion()) {
      setClosing(false);
      return;
    }
    setClosing(true);
    closeTimerRef.current = window.setTimeout(() => {
      setClosing(false);
      closeTimerRef.current = null;
    }, MENU_EXIT_ANIMATION_MS);
  };

  useEffect(() => {
    if (disabled) {
      closeMenu();
    }
  }, [disabled]);

  useEffect(() => {
    if (!open) {
      return;
    }

    const handlePointerDown = (event: PointerEvent) => {
      const target = event.target;
      if (!(target instanceof Node)) {
        return;
      }
      if (rootRef.current?.contains(target) || menuRef.current?.contains(target)) {
        return;
      }
      closeMenu();
    };
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        closeMenu();
      }
    };

    document.addEventListener("pointerdown", handlePointerDown);
    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("pointerdown", handlePointerDown);
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, [open]);

  useEffect(() => () => clearCloseTimer(), []);

  const chooseOption = (nextValue: T) => {
    closeMenu();
    if (nextValue !== value) {
      onChange(nextValue);
    }
  };

  const toggleMenu = () => {
    if (open) {
      closeMenu();
      return;
    }
    openMenu();
  };
  const menuVisible = open || closing;

  return (
    <div className={styles.root} data-density={density} data-open={open ? "true" : "false"} ref={rootRef}>
      <button
        aria-controls={menuVisible ? menuId : undefined}
        aria-expanded={open}
        aria-haspopup="listbox"
        aria-label={`${ariaLabel}：${triggerLabel}`}
        className={styles.trigger}
        disabled={disabled}
        type="button"
        onClick={toggleMenu}
      >
        <span className={styles.triggerText}>
          <strong>{triggerLabel}</strong>
        </span>
        <ChevronDown aria-hidden="true" data-open={open ? "true" : "false"} size={16} />
      </button>

      {menuVisible ? (
        <FloatingLayer
          alignment="end"
          aria-hidden={closing ? "true" : undefined}
          anchorRef={rootRef}
          className={styles.dropdown}
          data-density={density}
          data-state={closing ? "closing" : "open"}
          floatingRef={menuRef}
          matchAnchorWidth
          placement={placement}
        >
          <div className={styles.options} id={menuId} role="listbox" aria-label={`${ariaLabel}选项`}>
            {options.map((option) => {
              const active = option.value === value;
              return (
                <button
                  aria-selected={active}
                  className={styles.option}
                  data-active={active ? "true" : "false"}
                  data-has-description={option.description ? "true" : "false"}
                  key={option.value}
                  role="option"
                  type="button"
                  onClick={() => chooseOption(option.value)}
                >
                  <span>
                    <strong>{option.label}</strong>
                    {option.description ? <small>{option.description}</small> : null}
                  </span>
                  {active ? <Check aria-hidden="true" size={15} /> : null}
                </button>
              );
            })}
          </div>
        </FloatingLayer>
      ) : null}
    </div>
  );
}

function prefersReducedMotion(): boolean {
  return (
    typeof window !== "undefined" &&
    typeof window.matchMedia === "function" &&
    window.matchMedia("(prefers-reduced-motion: reduce)").matches
  );
}
