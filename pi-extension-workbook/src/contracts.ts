import type { WorkbookLimits } from "./core/limits.ts";
import type { VbaOperation } from "./backends/excel-vba.ts";

export const WORKBOOK_CONTRACT_VERSION = "1.0" as const;

export type WorkbookFormat = "xlsx" | "xlsm";
export type WorkbookBackendId = "ooxml-safe" | "excel-native" | "aspose";

export type CellScalar = string | number | boolean | null;

export type FontPatch = {
  name?: string;
  size?: number;
  bold?: boolean;
  italic?: boolean;
  underline?: boolean | "single" | "double" | "singleAccounting" | "doubleAccounting";
  strike?: boolean;
  outline?: boolean;
  shadow?: boolean;
  condense?: boolean;
  extend?: boolean;
  verticalAlign?: "baseline" | "superscript" | "subscript";
  family?: number;
  charset?: number;
  scheme?: "major" | "minor" | "none";
  color?: string;
};

export type CellStylePatch = {
  font?: FontPatch;
  fill?: {
    pattern?: "none" | "solid" | "mediumGray" | "darkGray" | "lightGray" | "darkHorizontal" | "darkVertical" | "darkDown" | "darkUp" | "darkGrid" | "darkTrellis" | "lightHorizontal" | "lightVertical" | "lightDown" | "lightUp" | "lightGrid" | "lightTrellis" | "gray125" | "gray0625";
    foreground?: string;
    background?: string;
  };
  border?: Partial<Record<"left" | "right" | "top" | "bottom" | "diagonal" | "vertical" | "horizontal", { style?: string; color?: string }>> & {
    diagonalUp?: boolean;
    diagonalDown?: boolean;
  };
  alignment?: {
    horizontal?: "general" | "left" | "center" | "right" | "fill" | "justify" | "centerContinuous" | "distributed";
    vertical?: "top" | "center" | "bottom" | "justify" | "distributed";
    wrapText?: boolean;
    shrinkToFit?: boolean;
    justifyLastLine?: boolean;
    readingOrder?: 0 | 1 | 2;
    indent?: number;
    relativeIndent?: number;
    textRotation?: number;
  };
  numberFormat?: string;
  protection?: {
    locked?: boolean;
    hidden?: boolean;
  };
};

export type RichTextRun = { text: string; font?: FontPatch };
export type ConditionalRule = {
  type: "expression" | "cellIs";
  formulas: string[];
  operator?: "between" | "notBetween" | "equal" | "notEqual" | "greaterThan" | "lessThan" | "greaterThanOrEqual" | "lessThanOrEqual";
  priority?: number;
  stopIfTrue?: boolean;
  style?: CellStylePatch;
};

export type WorkbookOperation =
  | { type: "setValue"; sheet: string; range: string; value: CellScalar }
  | { type: "setFormula"; sheet: string; range: string; formula: string }
  | { type: "setRichText"; sheet: string; range: string; runs: RichTextRun[] }
  | { type: "clear"; sheet: string; range: string; mode?: "contents" | "all" }
  | { type: "copyRange"; sourceSheet?: string; sheet: string; sourceRange: string; targetRange: string; include?: "all" | "values" | "styles" }
  | { type: "fillRange"; sheet: string; sourceCell: string; targetRange: string; include?: "all" | "values" | "styles" }
  | { type: "copyFormat"; sourceSheet: string; sourceRange: string; sheet: string; targetRange: string }
  | { type: "setStyle"; sheet: string; range: string; style: CellStylePatch }
  | { type: "setRowHeight"; sheet: string; startRow: number; endRow?: number; height: number }
  | { type: "setRowProperties"; sheet: string; startRow: number; endRow?: number; height?: number; hidden?: boolean; outlineLevel?: number; collapsed?: boolean }
  | { type: "setColumnWidth"; sheet: string; startColumn: string | number; endColumn?: string | number; width: number }
  | { type: "setColumnProperties"; sheet: string; startColumn: string | number; endColumn?: string | number; width?: number; hidden?: boolean; outlineLevel?: number; collapsed?: boolean; bestFit?: boolean }
  | { type: "autoFit"; sheet: string; range?: string; rows?: boolean; columns?: boolean; minColumnWidth?: number; maxColumnWidth?: number }
  | { type: "insertRows" | "deleteRows"; sheet: string; startRow: number; count: number }
  | { type: "insertColumns" | "deleteColumns"; sheet: string; startColumn: string | number; count: number }
  | { type: "merge"; sheet: string; range: string }
  | { type: "unmerge"; sheet: string; range: string }
  | { type: "setFreezePanes"; sheet: string; rows?: number; columns?: number }
  | { type: "setSheetProperties"; sheet: string; name?: string; position?: number; state?: "visible" | "hidden" | "veryHidden"; tabColor?: string; showGridLines?: boolean; zoomScale?: number }
  | { type: "createSheet"; name: string; position?: number; state?: "visible" | "hidden" | "veryHidden"; tabColor?: string }
  | { type: "deleteSheet"; sheet: string }
  | { type: "setConditionalFormatting"; sheet: string; range: string; mode?: "replace" | "append"; rules: ConditionalRule[] }
  | { type: "clearConditionalFormatting"; sheet: string; range: string }
  | { type: "setDataValidation"; sheet: string; range: string; validationType: "none" | "whole" | "decimal" | "list" | "date" | "time" | "textLength" | "custom"; operator?: "between" | "notBetween" | "equal" | "notEqual" | "greaterThan" | "lessThan" | "greaterThanOrEqual" | "lessThanOrEqual"; formula1?: string; formula2?: string; allowBlank?: boolean; showInputMessage?: boolean; showErrorMessage?: boolean; promptTitle?: string; prompt?: string; errorTitle?: string; error?: string; errorStyle?: "stop" | "warning" | "information" }
  | { type: "clearDataValidation"; sheet: string; range: string }
  | { type: "setAutoFilter"; sheet: string; range: string }
  | { type: "clearAutoFilter"; sheet: string }
  | { type: "setSort"; sheet: string; range: string; key: string; descending?: boolean; caseSensitive?: boolean }
  | { type: "setDefinedName"; name: string; formula: string; sheet?: string; hidden?: boolean; comment?: string }
  | { type: "deleteDefinedName"; name: string; sheet?: string }
  | { type: "setHyperlink"; sheet: string; range: string; target: string; display?: string; tooltip?: string }
  | { type: "removeHyperlink"; sheet: string; range: string }
  | { type: "setComment"; sheet: string; cell: string; author: string; text: string }
  | { type: "removeComment"; sheet: string; cell: string }
  | { type: "addTable"; sheet: string; range: string; name: string; displayName?: string; styleName?: string; showFirstColumn?: boolean; showLastColumn?: boolean; showRowStripes?: boolean; showColumnStripes?: boolean }
  | { type: "removeTable"; sheet: string; name: string }
  | { type: "addImage"; sheet: string; range: string; name: string; pngBase64: string; altText?: string }
  | { type: "addChart"; sheet: string; range: string; name: string; chartType: "column" | "bar" | "line" | "pie" | "area"; categoryRange: string; valueRange: string; title?: string; style?: number }
  | { type: "updateChart"; sheet: string; name: string; categoryRange?: string; valueRange?: string; title?: string; style?: number }
  | { type: "setPrintSettings"; sheet: string; printArea?: string; printTitlesRows?: string; printTitlesColumns?: string; orientation?: "portrait" | "landscape"; paperSize?: number; fitToWidth?: number; fitToHeight?: number; scale?: number; marginLeft?: number; marginRight?: number; marginTop?: number; marginBottom?: number; marginHeader?: number; marginFooter?: number; header?: string; footer?: string; horizontalCentered?: boolean; verticalCentered?: boolean; rowBreaks?: number[]; columnBreaks?: number[] }
  | { type: "setThemeColor"; slot: "dark1" | "light1" | "dark2" | "light2" | "accent1" | "accent2" | "accent3" | "accent4" | "accent5" | "accent6" | "hyperlink" | "followedHyperlink"; color: string }
  | { type: "setSheetProtection"; sheet: string; enabled: boolean; password?: string; selectLockedCells?: boolean; selectUnlockedCells?: boolean; formatCells?: boolean; formatColumns?: boolean; formatRows?: boolean; insertColumns?: boolean; insertRows?: boolean; deleteColumns?: boolean; deleteRows?: boolean; sort?: boolean; autoFilter?: boolean; pivotTables?: boolean }
  | { type: "setWorkbookProtection"; enabled: boolean; password?: string; lockStructure?: boolean; lockWindows?: boolean }
  | { type: "setCalculationSettings"; mode: "manual" | "auto" | "autoNoTable"; iterate?: boolean; iterateCount?: number; iterateDelta?: number; fullCalcOnLoad?: boolean; forceFullCalc?: boolean };

export type EngineCapability = {
  operation: string;
  supported: boolean;
  fidelity: "exact" | "bounded" | "read-only" | "unsupported";
  reason?: string;
};

export type EngineCapabilities = {
  engine: WorkbookBackendId;
  available: boolean;
  formats: WorkbookFormat[];
  inspect: boolean;
  read: boolean;
  render: boolean;
  edit: boolean;
  diff: boolean;
  validate: boolean;
  operations: EngineCapability[];
  constraints: string[];
};

export type WorkbookInspectRequest = {
  path: string;
  limits?: Partial<WorkbookLimits>;
};

export type WorkbookReadRequest = WorkbookInspectRequest & {
  sheet: string;
  range?: string;
  includeFormulas?: boolean;
  includeStyles?: boolean;
  maxCells?: number;
};

export type WorkbookRenderRequest = WorkbookReadRequest & {
  outputDir?: string;
  scale?: number;
};

export type WorkbookEditRequest = WorkbookInspectRequest & {
  schemaVersion: typeof WORKBOOK_CONTRACT_VERSION;
  operations: WorkbookOperation[];
  outputPath?: string;
  dryRun?: boolean;
  overwrite?: boolean;
  expectedSha256?: string;
};

export type WorkbookDiffRequest = {
  beforePath: string;
  afterPath: string;
  sheet?: string;
  range?: string;
  maxChanges?: number;
  limits?: Partial<WorkbookLimits>;
};

export type WorkbookValidateRequest = WorkbookInspectRequest & {
  baselinePath?: string;
};

export type WorkbookVbaReadRequest = {
  path: string;
  includeCode?: boolean;
  modules?: string[];
  maxCodeChars?: number;
};

export type WorkbookVbaEditRequest = {
  path: string;
  expectedSha256?: string;
  outputPath?: string;
  dryRun?: boolean;
  allowSignatureRemoval?: boolean;
  operations: VbaOperation[];
};

export type WorkbookEngine = {
  readonly id: WorkbookBackendId;
  probe(): Promise<EngineCapabilities>;
  inspect(request: WorkbookInspectRequest, signal?: AbortSignal): Promise<unknown>;
  read(request: WorkbookReadRequest, signal?: AbortSignal): Promise<unknown>;
  render(request: WorkbookRenderRequest, signal?: AbortSignal): Promise<unknown>;
  edit(request: WorkbookEditRequest, signal?: AbortSignal): Promise<unknown>;
  diff(request: WorkbookDiffRequest, signal?: AbortSignal): Promise<unknown>;
  validate(request: WorkbookValidateRequest, signal?: AbortSignal): Promise<unknown>;
};
