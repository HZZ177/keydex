import { Check, ChevronDown } from "lucide-react";
import {
  Button as AriaButton,
  ListBox,
  ListBoxItem,
  Popover,
  Select,
} from "react-aria-components";

import styles from "./TerminalDock.module.css";

export interface TerminalSelectOption {
  disabled?: boolean;
  label: string;
  value: string;
}

export function TerminalSelect({
  ariaLabel,
  disabled = false,
  onChange,
  options,
  placeholder,
  value,
  variant,
}: {
  ariaLabel: string;
  disabled?: boolean;
  onChange: (value: string) => void;
  options: TerminalSelectOption[];
  placeholder: string;
  value: string | null;
  variant: "profile" | "terminal";
}) {
  const selectedOption = options.find((option) => option.value === value) ?? null;

  return (
    <Select
      aria-label={ariaLabel}
      className={styles.terminalSelect}
      data-variant={variant}
      isDisabled={disabled}
      selectedKey={value}
      onSelectionChange={(key) => {
        if (key !== null) onChange(String(key));
      }}
    >
      <AriaButton className={styles.terminalSelectTrigger}>
        <span>{selectedOption?.label ?? placeholder}</span>
        <ChevronDown aria-hidden="true" size={13} />
      </AriaButton>
      <Popover className={styles.terminalSelectPopover} offset={4} placement="bottom end">
        <ListBox aria-label={`${ariaLabel}选项`} className={styles.terminalSelectOptions}>
          {options.map((option) => (
            <ListBoxItem
              className={styles.terminalSelectOption}
              id={option.value}
              isDisabled={option.disabled}
              key={option.value}
              textValue={option.label}
            >
              {({ isSelected }) => (
                <>
                  <span>{option.label}</span>
                  {isSelected ? <Check aria-hidden="true" size={13} /> : null}
                </>
              )}
            </ListBoxItem>
          ))}
        </ListBox>
      </Popover>
    </Select>
  );
}
