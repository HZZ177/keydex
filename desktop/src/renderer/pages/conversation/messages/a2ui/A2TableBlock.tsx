import {
  AllCommunityModule,
  ModuleRegistry,
  themeQuartz,
  type CellValueChangedEvent,
  type ColDef,
} from "ag-grid-community";
import {
  AgGridReact,
  type CustomCellEditorProps,
  type CustomCellRendererProps,
  type CustomHeaderProps,
} from "ag-grid-react";
import {
  Check,
  ChevronDown,
  ChevronUp,
  PencilLine,
  Plus,
  Trash2,
} from "lucide-react";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { flushSync } from "react-dom";

import type { ConversationMessage } from "@/renderer/stores/conversationStore";

import type { A2UICancelHandler, A2UISubmitHandler, ParsedA2UIMessage } from "./A2UIBlock";
import { A2CorrectionToggle } from "./A2CorrectionToggle";
import styles from "./A2TableBlock.module.css";
import { A2UIStateLine } from "./A2UIStateLine";
import {
  A2ActionMotionButton,
  A2InteractiveMotionItem,
  A2InteractiveMotionRoot,
} from "./A2UIMotion";
import { tableSemanticAdapter } from "./adapters/tableSemanticAdapter";
import { useA2UISemanticStream } from "./runtime/useA2UISemanticStream";

ModuleRegistry.registerModules([AllCommunityModule]);

type TableColumnType = "text" | "number" | "boolean" | "select" | "date";
type TableCellValue = string | number | boolean | null;
type TableActionKind = "submit" | "cancel";
type TableActionStage = "idle" | "loading" | "done";
type TableMotionState = "active" | "dirty" | "submitting" | "submitted" | "cancelled" | "error";

interface TableOption {
  label: string;
  value: string;
  disabled: boolean;
}

interface TableColumn {
  key: string;
  label: string;
  type: TableColumnType;
  required: boolean;
  width: number | null;
  options: TableOption[];
}

interface TableRow {
  id: string;
  values: Record<string, TableCellValue>;
}

interface TableChanges {
  cells: Array<{
    row_id: string;
    column_key: string;
    old_value: TableCellValue;
    new_value: TableCellValue;
  }>;
  column_labels: Array<{
    column_key: string;
    old_label: string;
    new_label: string;
  }>;
  added_row_ids: string[];
  deleted_row_ids: string[];
}

interface TableModel {
  title: string;
  description: string;
  submitLabel: string;
  columns: TableColumn[];
  rows: TableRow[];
  allowAddRows: boolean;
  allowDeleteRows: boolean;
  status: string;
  resultType: string;
  correctionNote: string;
  submittedChanges: TableChanges;
}

interface TableSnapshot {
  columns: TableColumn[];
  rows: TableRow[];
  labels: Record<string, string>;
}

interface GridRow {
  id: string;
  [key: string]: TableCellValue;
}

interface TableActionPhase {
  kind: TableActionKind;
  stage: Exclude<TableActionStage, "idle">;
}

interface EditableHeaderProps extends CustomHeaderProps<GridRow> {
  columnKey: string;
  renameable: boolean;
  onRename: (columnKey: string, label: string) => void;
}

interface SelectCellEditorProps extends CustomCellEditorProps<GridRow, TableCellValue> {
  options: TableOption[];
}

interface InputCellEditorProps extends CustomCellEditorProps<GridRow, TableCellValue> {
  inputType: "text" | "number" | "date";
}

interface ValueCellRendererProps extends CustomCellRendererProps<GridRow, TableCellValue> {
  tableColumn: TableColumn;
  showEditHint: boolean;
}

interface DeleteCellRendererProps extends CustomCellRendererProps<GridRow> {
  onDelete: (rowId: string) => void;
}

export interface A2TableBlockProps {
  message: ConversationMessage;
  parsed: ParsedA2UIMessage;
  onSubmit?: A2UISubmitHandler;
  onCancel?: A2UICancelHandler;
}

const ACTION_LOADING_MS = 120;
const ACTION_DONE_MS = 420;

export function A2TableBlock({ message, parsed, onSubmit, onCancel }: A2TableBlockProps) {
  const semanticStream = useA2UISemanticStream(parsed, tableSemanticAdapter, {
    scopeKey: message.id,
    initialVisibleUnits: 1,
    maxUnitsPerTick: 4,
  });
  const semanticParsed = useMemo(
    () => ({ ...parsed, payload: semanticStream.payload }),
    [parsed, semanticStream.payload],
  );
  const model = useMemo(() => tableModel(semanticParsed), [semanticParsed]);
  const modelSignature = useMemo(() => snapshotSignature(model.columns, model.rows), [model.columns, model.rows]);
  const initialSnapshot = useMemo(() => tableSnapshot(model), [modelSignature]);
  const [rows, setRows] = useState<TableRow[]>(() => cloneRows(model.rows));
  const [labels, setLabels] = useState<Record<string, string>>(() => columnLabels(model.columns));
  const [invalidCells, setInvalidCells] = useState<Set<string>>(() => new Set());
  const [correctionMode, setCorrectionMode] = useState(false);
  const [correctionNote, setCorrectionNote] = useState("");
  const [localSubmitting, setLocalSubmitting] = useState<TableActionKind | null>(null);
  const [actionPhase, setActionPhase] = useState<TableActionPhase | null>(null);
  const [localSubmitted, setLocalSubmitted] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const baselineRef = useRef<TableSnapshot>(initialSnapshot);
  const editedCellKeysRef = useRef(new Set<string>());
  const renamedColumnKeysRef = useRef(new Set<string>());
  const mountedRef = useRef(true);
  const actionTokenRef = useRef(0);

  const actionable =
    model.status === "waiting_input" &&
    Boolean(parsed.interactionId) &&
    parsed.interaction?.can_submit !== false &&
    !localSubmitted;
  const streamSettled =
    !semanticStream.running &&
    semanticStream.visibleUnitCount >= semanticStream.totalUnitCount;
  const editingReady = actionable && !correctionMode && !localSubmitting;
  const structureEditingReady = editingReady && streamSettled;
  const terminal = model.status === "submitted" || model.status === "cancelled";
  const sortableReady = terminal || editingReady;
  const gridDisabled = correctionMode || Boolean(localSubmitting) || (!terminal && !editingReady);
  const changes = useMemo(
    () => tableChanges(baselineRef.current, model.columns, rows, labels),
    [labels, model.columns, rows],
  );
  const changeCount = totalChangeCount(changes);
  const canSubmit =
    actionable &&
    streamSettled &&
    Boolean(onSubmit) &&
    !localSubmitting &&
    (!correctionMode || Boolean(correctionNote.trim()));
  const canCancel = actionable && Boolean(onCancel) && !localSubmitting;
  const cancelStage = actionStage(actionPhase, "cancel");
  const submitStage = actionStage(actionPhase, "submit");
  const gridRows = useMemo(() => toGridRows(rows, model.columns), [model.columns, rows]);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  useEffect(() => {
    actionTokenRef.current += 1;
    const next = tableSnapshot(model);
    baselineRef.current = next;
    setRows(cloneRows(next.rows));
    setLabels({ ...next.labels });
    setInvalidCells(new Set());
    setCorrectionMode(false);
    setCorrectionNote("");
    setLocalSubmitting(null);
    setActionPhase(null);
    setLocalSubmitted(false);
    setError(null);
    editedCellKeysRef.current.clear();
    renamedColumnKeysRef.current.clear();
  }, [message.id, parsed.interactionId]);

  useEffect(() => {
    const next = tableSnapshot(model);
    if (actionable && !terminal) {
      baselineRef.current = mergeTableSnapshot(baselineRef.current, next);
      setRows((current) => mergeStreamingRows(current, next.rows, editedCellKeysRef.current));
      setLabels((current) => mergeStreamingLabels(current, next.labels, renamedColumnKeysRef.current));
      return;
    }
    baselineRef.current = next;
    setRows(cloneRows(next.rows));
    setLabels({ ...next.labels });
    setInvalidCells(new Set());
  }, [actionable, modelSignature, terminal]);

  const renameColumn = useCallback((columnKey: string, nextLabel: string) => {
    const label = nextLabel.trim();
    if (!label) {
      return;
    }
    renamedColumnKeysRef.current.add(columnKey);
    setLabels((current) => ({ ...current, [columnKey]: label }));
  }, []);

  const updateCell = useCallback((event: CellValueChangedEvent<GridRow, TableCellValue>) => {
    const rowId = event.data?.id;
    const columnKey = event.colDef.field;
    if (!rowId || !columnKey) {
      return;
    }
    const column = model.columns.find((item) => item.key === columnKey);
    if (!column) {
      return;
    }
    const value = normalizeCellValue(event.newValue, column);
    editedCellKeysRef.current.add(tableCellKey(rowId, columnKey));
    setRows((current) => current.map((row) => (
      row.id === rowId ? { ...row, values: { ...row.values, [columnKey]: value } } : row
    )));
    setInvalidCells((current) => {
      const cellKey = tableCellKey(rowId, columnKey);
      if (!current.has(cellKey)) {
        return current;
      }
      const next = new Set(current);
      next.delete(cellKey);
      return next;
    });
  }, [model.columns]);

  const addRow = useCallback(() => {
    if (!structureEditingReady || !model.allowAddRows) {
      return;
    }
    setRows((current) => [
      ...current,
      {
        id: createLocalRowId(),
        values: Object.fromEntries(model.columns.map((column) => [column.key, defaultCellValue(column)])),
      },
    ]);
  }, [model.allowAddRows, model.columns, structureEditingReady]);

  const deleteRow = useCallback((rowId: string) => {
    if (!structureEditingReady || !model.allowDeleteRows) {
      return;
    }
    setRows((current) => current.filter((row) => row.id !== rowId));
    setInvalidCells((current) => new Set([...current].filter((key) => !key.startsWith(`${rowId}:`))));
  }, [model.allowDeleteRows, structureEditingReady]);

  const columnDefs = useMemo<ColDef<GridRow>[]>(() => {
    const definitions = model.columns.map((column): ColDef<GridRow> => ({
      colId: column.key,
      field: column.key,
      headerName: labels[column.key] || column.label,
      editable: editingReady,
      sortable: sortableReady && !correctionMode,
      resizable: true,
      minWidth: Math.min(column.width ?? 132, 180),
      width: column.width ?? undefined,
      flex: column.width ? undefined : 1,
      singleClickEdit: true,
      cellDataType: false,
      cellClass: editingReady ? styles.editableCell : undefined,
      cellClassRules: {
        [styles.invalidCell]: (params) => invalidCells.has(tableCellKey(params.data?.id || "", column.key)),
      },
      headerComponent: EditableTableHeader,
      headerComponentParams: {
        columnKey: column.key,
        renameable: editingReady,
        onRename: renameColumn,
      } satisfies Pick<EditableHeaderProps, "columnKey" | "renameable" | "onRename">,
      tooltipValueGetter: (params) => formattedCellValue(params.value, column),
      ...columnEditorDefinition(column, editingReady),
    }));
    if (structureEditingReady && model.allowDeleteRows) {
      definitions.push({
        colId: "__actions",
        headerName: "",
        width: 46,
        minWidth: 46,
        maxWidth: 46,
        pinned: "right",
        lockPinned: true,
        resizable: false,
        sortable: false,
        suppressMovable: true,
        cellRenderer: DeleteRowCell,
        cellRendererParams: { onDelete: deleteRow },
        cellClass: styles.actionCell,
      });
    }
    return definitions;
  }, [correctionMode, deleteRow, editingReady, invalidCells, labels, model.allowDeleteRows, model.columns, renameColumn, sortableReady, structureEditingReady]);

  const toggleCorrection = () => {
    if (!actionable || localSubmitting) {
      return;
    }
    setCorrectionMode((current) => {
      const next = !current;
      const baseline = baselineRef.current;
      setRows(cloneRows(baseline.rows));
      setLabels({ ...baseline.labels });
      setInvalidCells(new Set());
      editedCellKeysRef.current.clear();
      renamedColumnKeysRef.current.clear();
      setError(null);
      if (!next) {
        setCorrectionNote("");
      }
      return next;
    });
  };

  const submit = async () => {
    if (!canSubmit || !onSubmit || !parsed.interactionId) {
      return;
    }
    if (!correctionMode) {
      const invalid = requiredTableCells(model.columns, rows);
      if (invalid.size) {
        setInvalidCells(invalid);
        setError(`请检查 ${invalid.size} 个必填单元格`);
        return;
      }
    }
    const token = ++actionTokenRef.current;
    setLocalSubmitting("submit");
    setActionPhase({ kind: "submit", stage: "loading" });
    setError(null);
    try {
      const payload = correctionMode
        ? {
            result_type: "correction",
            columns: [],
            rows: [],
            changes: emptyTableChanges(),
            correction_note: correctionNote.trim(),
          }
        : {
            result_type: "table",
            columns: model.columns.map((column) => ({ key: column.key, label: labels[column.key] || column.label })),
            rows: cloneRows(rows),
            changes,
          };
      const submitPromise = onSubmit(parsed.interactionId, payload, message.threadId);
      if (!mountedRef.current || token !== actionTokenRef.current) {
        return;
      }
      void Promise.resolve(submitPromise).catch((reason) => {
        if (mountedRef.current && token === actionTokenRef.current) {
          setError(errorMessage(reason));
          setActionPhase(null);
          setLocalSubmitted(false);
        }
      });
      await wait(ACTION_LOADING_MS);
      if (!mountedRef.current || token !== actionTokenRef.current) {
        return;
      }
      setActionPhase({ kind: "submit", stage: "done" });
      await wait(ACTION_DONE_MS);
      if (mountedRef.current && token === actionTokenRef.current) {
        setLocalSubmitted(true);
      }
    } catch (reason) {
      if (mountedRef.current && token === actionTokenRef.current) {
        setError(errorMessage(reason));
        setActionPhase(null);
      }
    } finally {
      if (mountedRef.current && token === actionTokenRef.current) {
        setLocalSubmitting(null);
      }
    }
  };

  const cancel = async () => {
    if (!canCancel || !onCancel || !parsed.interactionId) {
      return;
    }
    const token = ++actionTokenRef.current;
    setLocalSubmitting("cancel");
    setActionPhase({ kind: "cancel", stage: "loading" });
    setError(null);
    try {
      const cancelPromise = onCancel(
        parsed.interactionId,
        correctionNote.trim() || "用户取消",
        message.threadId,
      );
      if (!mountedRef.current || token !== actionTokenRef.current) {
        return;
      }
      void Promise.resolve(cancelPromise).catch((reason) => {
        if (mountedRef.current && token === actionTokenRef.current) {
          setError(errorMessage(reason));
          setActionPhase(null);
          setLocalSubmitted(false);
        }
      });
      await wait(ACTION_LOADING_MS);
      if (!mountedRef.current || token !== actionTokenRef.current) {
        return;
      }
      setActionPhase({ kind: "cancel", stage: "done" });
      await wait(ACTION_DONE_MS);
      if (mountedRef.current && token === actionTokenRef.current) {
        setLocalSubmitted(true);
      }
    } catch (reason) {
      if (mountedRef.current && token === actionTokenRef.current) {
        setError(errorMessage(reason));
        setActionPhase(null);
      }
    } finally {
      if (mountedRef.current && token === actionTokenRef.current) {
        setLocalSubmitting(null);
      }
    }
  };

  const statusText = tableStatusText({
    changeCount,
    columns: model.columns.length,
    correctionMode,
    rows: rows.length,
    running: semanticStream.running || isStreamingStatus(model.status),
    status: model.status,
  });
  const gridHeight = tableGridHeight(rows.length);

  return (
    <A2InteractiveMotionRoot
      className={styles.table}
      data-testid="a2ui-table"
      data-grid-disabled={gridDisabled ? "true" : "false"}
      data-correction-mode={correctionMode ? "true" : "false"}
      live={!parsed.historyHydrated}
      motionScope={tableMotionScope(message.id, parsed)}
      motionState={tableMotionState(model.status, correctionMode, changeCount, localSubmitting, error)}
      {...semanticStream.rootProps}
    >
      <div className={styles.heading}>
        <div className={styles.headingCopy}>
          <h3>{model.title}</h3>
          {model.description ? <p>{model.description}</p> : null}
        </div>
        <span className={styles.statusPill} data-testid="a2ui-table-status">
          <span aria-hidden="true" />
          {statusText}
        </span>
      </div>

      <div className={styles.surface} data-disabled={gridDisabled ? "true" : "false"}>
        <div className={styles.toolbar}>
          <span>{model.columns.length} 列 · {rows.length} 行</span>
          {model.allowAddRows && !terminal ? (
            <button aria-label="新增一行" disabled={!structureEditingReady} type="button" title="新增一行" onClick={addRow}>
              <Plus aria-hidden="true" size={14} />
              <span>新增行</span>
            </button>
          ) : null}
        </div>
        {model.columns.length ? (
          <div className={styles.gridShell} style={{ height: gridHeight }}>
            <AgGridReact<GridRow>
              animateRows
              columnDefs={columnDefs}
              defaultColDef={{
                suppressHeaderMenuButton: true,
                suppressHeaderKeyboardEvent: () => correctionMode,
              }}
              enableCellTextSelection
              getRowId={(params) => params.data.id}
              headerHeight={38}
              maintainColumnOrder
              noRowsOverlayComponent={TableEmptyOverlay}
              rowData={gridRows}
              rowHeight={40}
              stopEditingWhenCellsLoseFocus
              suppressDragLeaveHidesColumns
              suppressMovableColumns
              theme={themeQuartz}
              tooltipShowDelay={450}
              onCellValueChanged={updateCell}
            />
            {gridDisabled && !terminal ? <div className={styles.gridBlocker} aria-hidden="true" /> : null}
          </div>
        ) : (
          <div className={styles.generating}>正在生成表格结构</div>
        )}
      </div>

      {terminal ? (
        <TableOutcome model={model} />
      ) : (
        <div className={styles.footerComposer}>
          <A2InteractiveMotionItem
            className={styles.correctionPanel}
            live={!parsed.historyHydrated}
            motionKey="table:correction"
            motionKind="table-correction"
            variant="field"
          >
            <A2CorrectionToggle
              controlsId={`${message.id}:a2ui-table-correction`}
              disabled={!actionable || Boolean(localSubmitting) || !streamSettled}
              expanded={correctionMode}
              idleDescription="我来告诉 Keydex 应该怎么做"
              idleTitle="以上表格不对"
              returnLabel="返回编辑表格"
              onToggle={toggleCorrection}
            />
            {correctionMode ? (
              <textarea
                aria-label="我来告诉 Keydex 应该怎么做"
                autoFocus
                disabled={!actionable || Boolean(localSubmitting)}
                id={`${message.id}:a2ui-table-correction`}
                maxLength={500}
                placeholder="例如：列结构不对、需要换一种分组方式，或者还缺少关键数据..."
                value={correctionNote}
                onChange={(event) => setCorrectionNote(event.currentTarget.value)}
              />
            ) : null}
          </A2InteractiveMotionItem>
          <div className={styles.footerMeta}>
            {correctionMode
              ? "已否决当前表格，填写说明后提交"
              : semanticStream.running
                ? "正在生成数据，请稍后..."
                : tableChangeSummary(changes)}
          </div>
          <A2InteractiveMotionItem
            className={styles.actions}
            live={!parsed.historyHydrated}
            motionKey="table:actions"
            motionKind="table-actions"
            variant="dock"
          >
            <A2ActionMotionButton
              aria-label={actionLabel(cancelStage, "取消", "取消中", "已取消")}
              className={styles.actionButton}
              data-badge-state={cancelStage}
              disabled={!canCancel}
              type="button"
              onClick={() => void cancel()}
            >
              <TableActionContent done="已取消" idle="取消" loading="取消中" stage={cancelStage} />
            </A2ActionMotionButton>
            <A2ActionMotionButton
              aria-label={actionLabel(submitStage, model.submitLabel, "提交中", "已提交")}
              className={[styles.actionButton, styles.submitButton].join(" ")}
              data-badge-state={submitStage}
              disabled={!canSubmit}
              type="button"
              onClick={() => void submit()}
            >
              <TableActionContent done="已提交" idle={model.submitLabel} loading="提交中" stage={submitStage} />
            </A2ActionMotionButton>
          </A2InteractiveMotionItem>
        </div>
      )}
      {error ? <div className={styles.error}>{error}</div> : null}
    </A2InteractiveMotionRoot>
  );
}

function EditableTableHeader({
  column,
  columnKey,
  displayName,
  enableSorting,
  progressSort,
  renameable,
  onRename,
}: EditableHeaderProps) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(displayName);
  const [sort, setSort] = useState(column.getSort());

  useEffect(() => {
    if (!editing) {
      setDraft(displayName);
    }
  }, [displayName, editing]);

  useEffect(() => {
    const update = () => setSort(column.getSort());
    column.addEventListener("sortChanged", update);
    return () => column.removeEventListener("sortChanged", update);
  }, [column]);

  const commit = () => {
    const label = draft.trim();
    if (label) {
      onRename(columnKey, label);
    } else {
      setDraft(displayName);
    }
    setEditing(false);
  };

  if (editing) {
    return (
      <input
        aria-label={`修改列名：${displayName}`}
        autoFocus
        className={styles.headerInput}
        maxLength={80}
        value={draft}
        onBlur={commit}
        onChange={(event) => setDraft(event.currentTarget.value)}
        onClick={(event) => event.stopPropagation()}
        onKeyDown={(event) => {
          event.stopPropagation();
          if (event.key === "Enter") {
            event.preventDefault();
            commit();
          } else if (event.key === "Escape") {
            setDraft(displayName);
            setEditing(false);
          }
        }}
      />
    );
  }

  return (
    <span className={styles.headerRoot}>
      <button
        aria-label={enableSorting ? `按${displayName}排序` : undefined}
        className={styles.headerSort}
        disabled={!enableSorting}
        title={enableSorting ? `按${displayName}排序` : displayName}
        type="button"
        onClick={(event) => progressSort(event.shiftKey)}
      >
        <span>{displayName}</span>
        {sort === "asc" ? <ChevronUp aria-hidden="true" size={12} /> : null}
        {sort === "desc" ? <ChevronDown aria-hidden="true" size={12} /> : null}
      </button>
      {renameable ? (
        <button
          className={styles.headerRename}
          aria-label={`修改列名：${displayName}`}
          title="修改列名"
          type="button"
          onClick={(event) => {
            event.preventDefault();
            event.stopPropagation();
            setEditing(true);
          }}
          onMouseDown={(event) => event.stopPropagation()}
        >
          <PencilLine aria-hidden="true" size={12} />
        </button>
      ) : null}
    </span>
  );
}

function TableSelectCellEditor({ api, onValueChange, options, value }: SelectCellEditorProps) {
  const available = options.filter((option) => !option.disabled);
  const focusRef = useRef<HTMLButtonElement>(null);
  const focusValue = available.some((option) => option.value === value)
    ? value
    : available[0]?.value;

  useLayoutEffect(() => {
    focusRef.current?.focus();
  }, []);

  return (
    <div className={styles.selectEditor} role="listbox" aria-label="选择单元格值">
      {available.map((option) => {
        const selected = option.value === value;
        return (
          <button
            ref={option.value === focusValue ? focusRef : undefined}
            aria-selected={selected}
            className={styles.selectEditorOption}
            data-selected={selected ? "true" : "false"}
            key={option.value}
            role="option"
            type="button"
            onMouseDown={(event) => event.preventDefault()}
            onClick={() => {
              flushSync(() => onValueChange(option.value));
              api.stopEditing();
            }}
          >
            <span>{option.label}</span>
            {selected ? <Check aria-hidden="true" size={13} /> : null}
          </button>
        );
      })}
    </div>
  );
}

function TableInputCellEditor({ api, colDef, inputType, onValueChange, value }: InputCellEditorProps) {
  const inputRef = useRef<HTMLInputElement>(null);

  useLayoutEffect(() => {
    inputRef.current?.focus();
    if (inputType === "text") {
      inputRef.current?.select();
    }
  }, [inputType]);

  return (
    <input
      ref={inputRef}
      aria-label={`编辑${colDef.headerName || "单元格"}`}
      className={styles.inputEditor}
      step={inputType === "number" ? "any" : undefined}
      type={inputType}
      value={value === null || value === undefined ? "" : String(value)}
      onChange={(event) => onValueChange(event.currentTarget.value || null)}
      onKeyDown={(event) => {
        if (event.key === "Enter") {
          event.preventDefault();
          event.stopPropagation();
          flushSync(() => onValueChange(event.currentTarget.value || null));
          api.stopEditing();
        } else if (event.key === "Escape") {
          event.preventDefault();
          event.stopPropagation();
          api.stopEditing(true);
        }
      }}
    />
  );
}

function TableValueCell({ showEditHint, tableColumn, value }: ValueCellRendererProps) {
  const text = formattedCellValue(value, tableColumn);
  return (
    <span className={styles.cellValue} data-empty={text ? "false" : "true"}>
      <span className={styles.cellText}>
        {text || (tableColumn.required ? <span className={styles.requiredHint}>必填</span> : null)}
      </span>
      {showEditHint ? <PencilLine aria-hidden="true" className={styles.cellEditHint} size={12} /> : null}
    </span>
  );
}

function DeleteRowCell({ data, onDelete }: DeleteCellRendererProps) {
  if (!data?.id) {
    return null;
  }
  return (
    <button
      aria-label="删除该行"
      className={styles.deleteButton}
      title="删除该行"
      type="button"
      onClick={(event) => {
        event.stopPropagation();
        onDelete(data.id);
      }}
    >
      <Trash2 aria-hidden="true" size={14} />
    </button>
  );
}

function TableEmptyOverlay() {
  return <div className={styles.emptyOverlay}>暂无数据，可以新增一行</div>;
}

function TableOutcome({ model }: { model: TableModel }) {
  if (model.status === "cancelled") {
    return (
      <A2UIStateLine tone="warning" testId="a2ui-table-state-line">
        已取消本次表格修改
      </A2UIStateLine>
    );
  }
  if (model.resultType === "correction") {
    return (
      <div className={styles.outcome}>
        <A2UIStateLine tone="success" testId="a2ui-table-state-line">
          已提交表格修正意见
        </A2UIStateLine>
        {model.correctionNote ? <p>{model.correctionNote}</p> : null}
      </div>
    );
  }
  return (
    <A2UIStateLine tone="success" testId="a2ui-table-state-line">
      {`本次表格修改已提交 · ${tableChangeSummary(model.submittedChanges)}`}
    </A2UIStateLine>
  );
}

function TableActionContent({
  done,
  idle,
  loading,
  stage,
}: {
  done: string;
  idle: string;
  loading: string;
  stage: TableActionStage;
}) {
  return (
    <>
      <span className={styles.buttonSignal} aria-hidden="true" />
      <span className={styles.buttonLabel} aria-hidden="true">
        <span data-active={stage === "idle" ? "true" : "false"}>{idle}</span>
        <span data-active={stage === "loading" ? "true" : "false"}>{loading}</span>
        <span data-active={stage === "done" ? "true" : "false"}>{done}</span>
      </span>
    </>
  );
}

function columnEditorDefinition(column: TableColumn, showEditHint: boolean): Partial<ColDef<GridRow>> {
  const valueRenderer: Partial<ColDef<GridRow>> = {
    cellRenderer: TableValueCell,
    cellRendererParams: { tableColumn: column, showEditHint },
  };
  if (column.type === "number") {
    return {
      ...valueRenderer,
      cellEditor: TableInputCellEditor,
      cellEditorParams: { inputType: "number" },
      valueParser: (params) => normalizeCellValue(params.newValue, column),
      valueFormatter: (params) => formattedCellValue(params.value, column),
    };
  }
  if (column.type === "boolean") {
    return {
      cellEditor: "agCheckboxCellEditor",
      cellRenderer: "agCheckboxCellRenderer",
    };
  }
  if (column.type === "select") {
    return {
      ...valueRenderer,
      cellEditor: TableSelectCellEditor,
      cellEditorParams: { options: column.options },
      cellEditorPopup: true,
      cellEditorPopupPosition: "under",
      valueFormatter: (params) => formattedCellValue(params.value, column),
    };
  }
  if (column.type === "date") {
    return {
      ...valueRenderer,
      cellEditor: TableInputCellEditor,
      cellEditorParams: { inputType: "date" },
      valueParser: (params) => normalizeCellValue(params.newValue, column),
    };
  }
  return {
    ...valueRenderer,
    cellEditor: TableInputCellEditor,
    cellEditorParams: { inputType: "text" },
  };
}

function tableModel(parsed: ParsedA2UIMessage): TableModel {
  const payload = parsed.payload;
  const interaction = parsed.interaction;
  const submitResult = asRecord(interaction?.submit_result);
  const status = normalizeStatus(interaction?.status ?? parsed.status);
  const resultType = scalarText(submitResult?.result_type);
  const sourceColumns = tableColumns(payload.columns);
  const submittedColumns = resultType === "table" ? submittedColumnLabels(submitResult?.columns) : {};
  const columns = sourceColumns.map((column) => ({
    ...column,
    label: submittedColumns[column.key] || column.label,
  }));
  const sourceRows = tableRows(payload.rows, columns);
  const submittedRows = resultType === "table" ? tableRows(submitResult?.rows, columns) : [];
  return {
    title: scalarText(payload.title) || "请审阅表格",
    description: scalarText(payload.description),
    submitLabel: scalarText(payload.submit_label) || "提交修改",
    columns,
    rows: status === "submitted" && resultType === "table" ? submittedRows : sourceRows,
    allowAddRows: payload.allow_add_rows === true,
    allowDeleteRows: payload.allow_delete_rows === true,
    status,
    resultType,
    correctionNote: scalarText(submitResult?.correction_note),
    submittedChanges: tableChangesFromValue(submitResult?.changes),
  };
}

function tableColumns(value: unknown): TableColumn[] {
  if (!Array.isArray(value)) {
    return [];
  }
  const seen = new Set<string>();
  return value
    .map((item) => {
      const record = asRecord(item);
      const key = scalarText(record?.key);
      const label = scalarText(record?.label);
      if (!record || !key || !label || seen.has(key)) {
        return null;
      }
      seen.add(key);
      return {
        key,
        label,
        type: tableColumnType(record.type),
        required: record.required === true,
        width: finiteNumber(record.width),
        options: tableOptions(record.options),
      } satisfies TableColumn;
    })
    .filter((column): column is TableColumn => Boolean(column));
}

function tableRows(value: unknown, columns: TableColumn[]): TableRow[] {
  if (!Array.isArray(value)) {
    return [];
  }
  const seen = new Set<string>();
  return value
    .map((item) => {
      const record = asRecord(item);
      const id = scalarText(record?.id);
      const values = asRecord(record?.values);
      if (!record || !id || !values || seen.has(id)) {
        return null;
      }
      seen.add(id);
      return {
        id,
        values: Object.fromEntries(columns.map((column) => [
          column.key,
          normalizeCellValue(values[column.key], column),
        ])),
      } satisfies TableRow;
    })
    .filter((row): row is TableRow => Boolean(row));
}

function tableOptions(value: unknown): TableOption[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value
    .map((item) => {
      const record = asRecord(item);
      const optionValue = scalarText(record?.value);
      const label = scalarText(record?.label) || optionValue;
      return optionValue && label
        ? { label, value: optionValue, disabled: record?.disabled === true }
        : null;
    })
    .filter((option): option is TableOption => Boolean(option));
}

function tableColumnType(value: unknown): TableColumnType {
  const type = scalarText(value).toLowerCase();
  if (type === "number" || type === "boolean" || type === "select" || type === "date") {
    return type;
  }
  return "text";
}

function toGridRows(rows: TableRow[], columns: TableColumn[]): GridRow[] {
  return rows.map((row) => ({
    id: row.id,
    ...Object.fromEntries(columns.map((column) => [column.key, row.values[column.key] ?? null])),
  }));
}

function normalizeCellValue(value: unknown, column: TableColumn): TableCellValue {
  if (value === undefined || value === null || value === "") {
    return null;
  }
  if (column.type === "number") {
    if (typeof value === "number" && Number.isFinite(value)) {
      return value;
    }
    const parsed = Number(String(value).replaceAll(",", ""));
    return Number.isFinite(parsed) ? parsed : null;
  }
  if (column.type === "boolean") {
    return value === true || scalarText(value).toLowerCase() === "true";
  }
  return String(value);
}

function formattedCellValue(value: unknown, column: TableColumn): string {
  if (value === undefined || value === null || value === "") {
    return "";
  }
  if (column.type === "boolean") {
    return value === true ? "是" : "否";
  }
  if (column.type === "select") {
    const text = scalarText(value);
    return column.options.find((option) => option.value === text)?.label ?? text;
  }
  if (column.type === "number" && typeof value === "number") {
    return new Intl.NumberFormat("zh-CN", { maximumFractionDigits: 6 }).format(value);
  }
  return scalarText(value);
}

function tableSnapshot(model: Pick<TableModel, "columns" | "rows">): TableSnapshot {
  return {
    columns: model.columns.map((column) => ({ ...column, options: column.options.map((option) => ({ ...option })) })),
    rows: cloneRows(model.rows),
    labels: columnLabels(model.columns),
  };
}

function cloneRows(rows: TableRow[]): TableRow[] {
  return rows.map((row) => ({ id: row.id, values: { ...row.values } }));
}

function mergeTableSnapshot(current: TableSnapshot, incoming: TableSnapshot): TableSnapshot {
  const incomingRowIds = new Set(incoming.rows.map((row) => row.id));
  return {
    columns: incoming.columns.length
      ? incoming.columns.map((column) => ({ ...column, options: column.options.map((option) => ({ ...option })) }))
      : current.columns,
    rows: [
      ...cloneRows(incoming.rows),
      ...cloneRows(current.rows.filter((row) => !incomingRowIds.has(row.id))),
    ],
    labels: { ...current.labels, ...incoming.labels },
  };
}

function mergeStreamingRows(
  current: TableRow[],
  incoming: TableRow[],
  editedCellKeys: ReadonlySet<string>,
): TableRow[] {
  const currentById = new Map(current.map((row) => [row.id, row]));
  const incomingRowIds = new Set(incoming.map((row) => row.id));
  const next = [
    ...incoming.map((row) => {
      const existing = currentById.get(row.id);
      if (!existing) {
        return { id: row.id, values: { ...row.values } };
      }
      const values = { ...row.values };
      for (const [columnKey, value] of Object.entries(existing.values)) {
        if (editedCellKeys.has(tableCellKey(row.id, columnKey))) {
          values[columnKey] = value;
        }
      }
      return { id: row.id, values };
    }),
    ...current
      .filter((row) => !incomingRowIds.has(row.id))
      .map((row) => ({ id: row.id, values: { ...row.values } })),
  ];
  return safeJsonStringify(next) === safeJsonStringify(current) ? current : next;
}

function mergeStreamingLabels(
  current: Record<string, string>,
  incoming: Record<string, string>,
  renamedColumnKeys: ReadonlySet<string>,
): Record<string, string> {
  const next = { ...incoming };
  for (const [columnKey, label] of Object.entries(current)) {
    if (renamedColumnKeys.has(columnKey) || !(columnKey in next)) {
      next[columnKey] = label;
    }
  }
  return safeJsonStringify(next) === safeJsonStringify(current) ? current : next;
}

function columnLabels(columns: TableColumn[]): Record<string, string> {
  return Object.fromEntries(columns.map((column) => [column.key, column.label]));
}

function snapshotSignature(columns: TableColumn[], rows: TableRow[]): string {
  return safeJsonStringify({ columns, rows });
}

function tableChanges(
  baseline: TableSnapshot,
  columns: TableColumn[],
  rows: TableRow[],
  labels: Record<string, string>,
): TableChanges {
  const originalById = new Map(baseline.rows.map((row) => [row.id, row]));
  const currentById = new Map(rows.map((row) => [row.id, row]));
  const cells: TableChanges["cells"] = [];
  for (const originalRow of baseline.rows) {
    const currentRow = currentById.get(originalRow.id);
    if (!currentRow) {
      continue;
    }
    for (const column of columns) {
      const oldValue = originalRow.values[column.key] ?? null;
      const newValue = currentRow.values[column.key] ?? null;
      if (oldValue !== newValue) {
        cells.push({
          row_id: originalRow.id,
          column_key: column.key,
          old_value: oldValue,
          new_value: newValue,
        });
      }
    }
  }
  return {
    cells,
    column_labels: columns
      .filter((column) => (baseline.labels[column.key] || column.label) !== (labels[column.key] || column.label))
      .map((column) => ({
        column_key: column.key,
        old_label: baseline.labels[column.key] || column.label,
        new_label: labels[column.key] || column.label,
      })),
    added_row_ids: rows.filter((row) => !originalById.has(row.id)).map((row) => row.id),
    deleted_row_ids: baseline.rows.filter((row) => !currentById.has(row.id)).map((row) => row.id),
  };
}

function requiredTableCells(columns: TableColumn[], rows: TableRow[]): Set<string> {
  const invalid = new Set<string>();
  for (const row of rows) {
    for (const column of columns) {
      if (!column.required) {
        continue;
      }
      const value = row.values[column.key];
      if (value === null || value === undefined || (typeof value === "string" && !value.trim())) {
        invalid.add(tableCellKey(row.id, column.key));
      }
    }
  }
  return invalid;
}

function tableChangeSummary(changes: TableChanges): string {
  const parts: string[] = [];
  if (changes.cells.length) {
    parts.push(`修改 ${changes.cells.length} 个单元格`);
  }
  if (changes.column_labels.length) {
    parts.push(`修改 ${changes.column_labels.length} 个列名`);
  }
  if (changes.added_row_ids.length) {
    parts.push(`新增 ${changes.added_row_ids.length} 行`);
  }
  if (changes.deleted_row_ids.length) {
    parts.push(`删除 ${changes.deleted_row_ids.length} 行`);
  }
  return parts.length ? parts.join(" · ") : "尚未修改";
}

function tableStatusText({
  changeCount,
  columns,
  correctionMode,
  rows,
  running,
  status,
}: {
  changeCount: number;
  columns: number;
  correctionMode: boolean;
  rows: number;
  running: boolean;
  status: string;
}): string {
  if (running) {
    return `正在生成 · ${columns} 列 ${rows} 行`;
  }
  if (status === "submitted") {
    return "已提交";
  }
  if (status === "cancelled") {
    return "已取消";
  }
  if (correctionMode) {
    return "修正意见";
  }
  return changeCount ? `已修改 ${changeCount} 项` : `${columns} 列 ${rows} 行`;
}

function tableGridHeight(rowCount: number): number {
  return Math.max(152, Math.min(458, 39 + Math.max(1, rowCount) * 40 + 2));
}

function tableChangesFromValue(value: unknown): TableChanges {
  const record = asRecord(value);
  return {
    cells: Array.isArray(record?.cells) ? record.cells.filter((item) => asRecord(item)) as TableChanges["cells"] : [],
    column_labels: Array.isArray(record?.column_labels)
      ? record.column_labels.filter((item) => asRecord(item)) as TableChanges["column_labels"]
      : [],
    added_row_ids: stringList(record?.added_row_ids),
    deleted_row_ids: stringList(record?.deleted_row_ids),
  };
}

function submittedColumnLabels(value: unknown): Record<string, string> {
  if (!Array.isArray(value)) {
    return {};
  }
  return Object.fromEntries(value.flatMap((item) => {
    const record = asRecord(item);
    const key = scalarText(record?.key);
    const label = scalarText(record?.label);
    return key && label ? [[key, label]] : [];
  }));
}

function defaultCellValue(column: TableColumn): TableCellValue {
  if (column.type === "boolean") {
    return false;
  }
  if (column.type === "select" && column.required) {
    return column.options.find((option) => !option.disabled)?.value ?? null;
  }
  return null;
}

function createLocalRowId(): string {
  const id = globalThis.crypto?.randomUUID?.() || `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
  return `local-${id}`;
}

function emptyTableChanges(): TableChanges {
  return { cells: [], column_labels: [], added_row_ids: [], deleted_row_ids: [] };
}

function totalChangeCount(changes: TableChanges): number {
  return changes.cells.length + changes.column_labels.length + changes.added_row_ids.length + changes.deleted_row_ids.length;
}

function tableCellKey(rowId: string, columnKey: string): string {
  return `${rowId}:${columnKey}`;
}

function actionStage(phase: TableActionPhase | null, kind: TableActionKind): TableActionStage {
  return phase?.kind === kind ? phase.stage : "idle";
}

function actionLabel(stage: TableActionStage, idle: string, loading: string, done: string): string {
  return stage === "loading" ? loading : stage === "done" ? done : idle;
}

function tableMotionState(
  status: string,
  correctionMode: boolean,
  changeCount: number,
  localSubmitting: TableActionKind | null,
  error: string | null,
): TableMotionState {
  if (error) {
    return "error";
  }
  if (localSubmitting) {
    return "submitting";
  }
  if (status === "submitted") {
    return "submitted";
  }
  if (status === "cancelled") {
    return "cancelled";
  }
  if (correctionMode || changeCount) {
    return "dirty";
  }
  return "active";
}

function tableMotionScope(messageId: string, parsed: ParsedA2UIMessage): string {
  return [parsed.a2ui?.stream_id, parsed.debug?.streamId, parsed.interactionId, messageId, "table"]
    .filter(Boolean)
    .join(":");
}

function normalizeStatus(value: unknown): string {
  const status = scalarText(value).toLowerCase();
  if (status === "waiting_user_input") {
    return "waiting_input";
  }
  if (status === "missing") {
    return "failed";
  }
  return status || "created";
}

function isStreamingStatus(status: string): boolean {
  return status === "started" || status === "streaming" || status === "finished";
}

function wait(milliseconds: number): Promise<void> {
  return new Promise((resolve) => globalThis.setTimeout(resolve, milliseconds));
}

function finiteNumber(value: unknown): number | null {
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function scalarText(value: unknown): string {
  if (typeof value === "string") {
    return value.trim();
  }
  if (typeof value === "number" && Number.isFinite(value)) {
    return String(value);
  }
  if (typeof value === "boolean") {
    return value ? "true" : "false";
  }
  return "";
}

function stringList(value: unknown): string[] {
  return Array.isArray(value) ? value.map(scalarText).filter(Boolean) : [];
}

function safeJsonStringify(value: unknown): string {
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function errorMessage(reason: unknown): string {
  if (reason instanceof Error && reason.message.trim()) {
    return reason.message;
  }
  return "提交失败";
}
