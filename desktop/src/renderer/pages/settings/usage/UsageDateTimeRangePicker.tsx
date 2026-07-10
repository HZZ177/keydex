import { CalendarDate, Time } from "@internationalized/date";
import { ChevronLeft, ChevronRight } from "lucide-react";
import { useState } from "react";
import { Button } from "react-aria-components/Button";
import { Dialog } from "react-aria-components/Dialog";
import { I18nProvider } from "react-aria-components/I18nProvider";
import { DialogTrigger, Popover } from "react-aria-components/Popover";
import {
  CalendarCell,
  CalendarGrid,
  CalendarGridBody,
  CalendarGridHeader,
  CalendarHeaderCell,
  Heading,
  RangeCalendar,
  type RangeValue,
} from "react-aria-components/RangeCalendar";
import { DateInput, DateSegment, Label, TimeField } from "react-aria-components/TimeField";

import styles from "./UsageDateTimeRangePicker.module.css";

export interface UsageDateTimeRangeValue {
  startTime: string;
  endTime: string;
}

export interface UsageDateTimeRangePickerProps {
  active: boolean;
  onApply: (value: UsageDateTimeRangeValue) => void;
  value: UsageDateTimeRangeValue;
}

interface PickerDraft {
  dates: RangeValue<CalendarDate>;
  endTime: Time;
  startTime: Time;
}

export function UsageDateTimeRangePicker({ active, onApply, value }: UsageDateTimeRangePickerProps) {
  const [isOpen, setIsOpen] = useState(false);
  const [draft, setDraft] = useState<PickerDraft>(() => toPickerDraft(value));
  const [validationError, setValidationError] = useState<string | null>(null);
  const formattedValue = formatTriggerRange(value);
  const previewValue = isOpen ? formatPickerDraft(draft) : formattedValue;
  const showRangeValue = active || isOpen;

  function handleOpenChange(nextOpen: boolean) {
    if (nextOpen) {
      setDraft(toPickerDraft(value));
    }
    setValidationError(null);
    setIsOpen(nextOpen);
  }

  function updateDates(dates: RangeValue<CalendarDate>) {
    setDraft((current) => ({ ...current, dates }));
    setValidationError(null);
  }

  function updateStartTime(startTime: Time) {
    setDraft((current) => ({ ...current, startTime }));
    setValidationError(null);
  }

  function updateEndTime(endTime: Time) {
    setDraft((current) => ({ ...current, endTime }));
    setValidationError(null);
  }

  function cancel() {
    setDraft(toPickerDraft(value));
    setValidationError(null);
    setIsOpen(false);
  }

  function apply() {
    const nextValue = fromPickerDraft(draft);
    if (!nextValue) {
      setValidationError("结束时间不能早于开始时间");
      return;
    }
    onApply(nextValue);
    setValidationError(null);
    setIsOpen(false);
  }

  return (
    <I18nProvider locale="zh-CN">
      <DialogTrigger isOpen={isOpen} onOpenChange={handleOpenChange}>
        <Button
          aria-label={showRangeValue ? `自定义时间范围，当前 ${previewValue}` : "自定义时间范围"}
          className={styles.trigger}
          data-active={active ? "true" : "false"}
          data-open={isOpen ? "true" : "false"}
          type="button"
        >
          <span>{showRangeValue ? previewValue : "自定义"}</span>
        </Button>
        <Popover className={styles.popover} offset={8} placement="bottom end" shouldFlip>
          <Dialog aria-label="自定义时间范围" className={styles.dialog}>
            <RangeCalendar
              aria-label="日期范围"
              className={styles.calendar}
              firstDayOfWeek="mon"
              onChange={updateDates}
              value={draft.dates}
            >
              <div className={styles.calendarNavigation}>
                <Button aria-label="上个月" className={styles.navigationButton} slot="previous" type="button">
                  <ChevronLeft aria-hidden="true" size={16} />
                </Button>
                <Heading className={styles.calendarHeading} />
                <Button aria-label="下个月" className={styles.navigationButton} slot="next" type="button">
                  <ChevronRight aria-hidden="true" size={16} />
                </Button>
              </div>
              <CalendarGrid className={styles.calendarGrid} weekdayStyle="narrow">
                <CalendarGridHeader>
                  {(day) => <CalendarHeaderCell className={styles.calendarHeaderCell}>{day}</CalendarHeaderCell>}
                </CalendarGridHeader>
                <CalendarGridBody>
                  {(date) => <CalendarCell className={styles.calendarCell} date={date} />}
                </CalendarGridBody>
              </CalendarGrid>
            </RangeCalendar>

            <section aria-label="时间" className={styles.timeFields}>
              <PickerTimeField label="开始时间" onChange={updateStartTime} value={draft.startTime} />
              <PickerTimeField label="结束时间" onChange={updateEndTime} value={draft.endTime} />
            </section>

            <footer className={styles.footer}>
              {validationError ? (
                <span className={styles.validationError} role="alert">
                  {validationError}
                </span>
              ) : null}
              <div className={styles.actions}>
                <Button className={styles.cancelButton} onPress={cancel} type="button">
                  取消
                </Button>
                <Button className={styles.applyButton} onPress={apply} type="button">
                  应用
                </Button>
              </div>
            </footer>
          </Dialog>
        </Popover>
      </DialogTrigger>
    </I18nProvider>
  );
}

function PickerTimeField({ label, onChange, value }: { label: string; onChange: (value: Time) => void; value: Time }) {
  return (
    <TimeField
      className={styles.timeField}
      granularity="minute"
      hourCycle={24}
      onChange={(nextValue) => {
        if (nextValue) {
          onChange(nextValue);
        }
      }}
      shouldForceLeadingZeros
      value={value}
    >
      <Label className={styles.timeLabel}>{label}</Label>
      <DateInput className={styles.timeInput}>
        {(segment) => <DateSegment className={styles.timeSegment} segment={segment} />}
      </DateInput>
    </TimeField>
  );
}

function toPickerDraft(value: UsageDateTimeRangeValue): PickerDraft {
  const fallbackEnd = new Date();
  const fallbackStart = new Date(fallbackEnd);
  fallbackStart.setDate(fallbackStart.getDate() - 6);
  fallbackStart.setHours(0, 0, 0, 0);

  const start = parseDate(value.startTime) ?? fallbackStart;
  const end = parseDate(value.endTime) ?? fallbackEnd;

  return {
    dates: {
      start: new CalendarDate(start.getFullYear(), start.getMonth() + 1, start.getDate()),
      end: new CalendarDate(end.getFullYear(), end.getMonth() + 1, end.getDate()),
    },
    startTime: new Time(start.getHours(), start.getMinutes()),
    endTime: new Time(end.getHours(), end.getMinutes()),
  };
}

function fromPickerDraft(draft: PickerDraft): UsageDateTimeRangeValue | null {
  const start = combineDateAndTime(draft.dates.start, draft.startTime);
  const end = combineDateAndTime(draft.dates.end, draft.endTime);
  if (end.getTime() < start.getTime()) {
    return null;
  }
  return {
    startTime: start.toISOString(),
    endTime: end.toISOString(),
  };
}

function combineDateAndTime(date: CalendarDate, time: Time) {
  return new Date(date.year, date.month - 1, date.day, time.hour, time.minute, 0, 0);
}

function parseDate(value: string) {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

function formatTriggerRange(value: UsageDateTimeRangeValue) {
  const start = parseDate(value.startTime);
  const end = parseDate(value.endTime);
  if (!start || !end) {
    return "自定义";
  }
  return `${formatDateTime(start)} – ${formatDateTime(end)}`;
}

function formatPickerDraft(draft: PickerDraft) {
  const start = combineDateAndTime(draft.dates.start, draft.startTime);
  const end = combineDateAndTime(draft.dates.end, draft.endTime);
  return `${formatDateTime(start)} – ${formatDateTime(end)}`;
}

function formatDateTime(date: Date) {
  const pad = (part: number) => String(part).padStart(2, "0");
  return `${date.getFullYear()}/${pad(date.getMonth() + 1)}/${pad(date.getDate())} ${pad(date.getHours())}:${pad(
    date.getMinutes(),
  )}`;
}
