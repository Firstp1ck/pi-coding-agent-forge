import { StringEnum } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { WORKBOOK_CONTRACT_VERSION } from "./contracts.ts";
import { VBA_LIMITS } from "./vba/limits.ts";

const WorkbookPath = Type.String({ minLength: 1, description: "Workbook path. Leading @, ~, relative, and absolute paths are supported." });
const Sheet = Type.String({ minLength: 1, maxLength: 31, description: "Worksheet name (not a numeric index)." });
const Range = Type.String({ minLength: 1, description: "A1 range such as A1:D20." });
const Cell = Type.String({ minLength: 1, description: "A single A1 cell reference." });
const HexColor = Type.String({ pattern: "^(?:[A-Fa-f0-9]{6}|[A-Fa-f0-9]{8})$", description: "RGB or ARGB hexadecimal color without #." });
const Scalar = Type.Union([Type.String(), Type.Number(), Type.Boolean(), Type.Null()]);
const RowNumber = Type.Integer({ minimum: 1, maximum: 1048576 });
const Column = Type.Union([Type.String({ pattern: "^[A-Za-z]{1,3}$" }), Type.Integer({ minimum: 1, maximum: 16384 })]);
const Password = Type.String({ maxLength: 255, description: "Sensitive password input. It is hashed in memory and is never returned or logged." });

const FontPatch = Type.Object({
  name: Type.Optional(Type.String({ minLength: 1, maxLength: 255 })),
  size: Type.Optional(Type.Number({ exclusiveMinimum: 0, maximum: 409 })),
  bold: Type.Optional(Type.Boolean()),
  italic: Type.Optional(Type.Boolean()),
  underline: Type.Optional(Type.Union([Type.Boolean(), StringEnum(["single", "double", "singleAccounting", "doubleAccounting"] as const)])),
  strike: Type.Optional(Type.Boolean()),
  outline: Type.Optional(Type.Boolean()),
  shadow: Type.Optional(Type.Boolean()),
  condense: Type.Optional(Type.Boolean()),
  extend: Type.Optional(Type.Boolean()),
  verticalAlign: Type.Optional(StringEnum(["baseline", "superscript", "subscript"] as const)),
  family: Type.Optional(Type.Integer({ minimum: 0, maximum: 14 })),
  charset: Type.Optional(Type.Integer({ minimum: 0, maximum: 255 })),
  scheme: Type.Optional(StringEnum(["major", "minor", "none"] as const)),
  color: Type.Optional(HexColor),
}, { additionalProperties: false });

const BorderSide = Type.Object({
  style: Type.Optional(StringEnum(["none", "hair", "dotted", "dashDotDot", "dashDot", "dashed", "thin", "mediumDashDotDot", "slantDashDot", "mediumDashDot", "mediumDashed", "medium", "thick", "double"] as const)),
  color: Type.Optional(HexColor),
}, { additionalProperties: false });

const FillPattern = StringEnum(["none", "solid", "mediumGray", "darkGray", "lightGray", "darkHorizontal", "darkVertical", "darkDown", "darkUp", "darkGrid", "darkTrellis", "lightHorizontal", "lightVertical", "lightDown", "lightUp", "lightGrid", "lightTrellis", "gray125", "gray0625"] as const);

const StylePatch = Type.Object({
  font: Type.Optional(FontPatch),
  fill: Type.Optional(Type.Object({
    pattern: Type.Optional(FillPattern),
    foreground: Type.Optional(HexColor),
    background: Type.Optional(HexColor),
  }, { additionalProperties: false })),
  border: Type.Optional(Type.Object({
    left: Type.Optional(BorderSide),
    right: Type.Optional(BorderSide),
    top: Type.Optional(BorderSide),
    bottom: Type.Optional(BorderSide),
    diagonal: Type.Optional(BorderSide),
    vertical: Type.Optional(BorderSide),
    horizontal: Type.Optional(BorderSide),
    diagonalUp: Type.Optional(Type.Boolean()),
    diagonalDown: Type.Optional(Type.Boolean()),
  }, { additionalProperties: false })),
  alignment: Type.Optional(Type.Object({
    horizontal: Type.Optional(StringEnum(["general", "left", "center", "right", "fill", "justify", "centerContinuous", "distributed"] as const)),
    vertical: Type.Optional(StringEnum(["top", "center", "bottom", "justify", "distributed"] as const)),
    wrapText: Type.Optional(Type.Boolean()),
    shrinkToFit: Type.Optional(Type.Boolean()),
    justifyLastLine: Type.Optional(Type.Boolean()),
    readingOrder: Type.Optional(Type.Integer({ minimum: 0, maximum: 2 })),
    indent: Type.Optional(Type.Integer({ minimum: 0, maximum: 250 })),
    relativeIndent: Type.Optional(Type.Integer({ minimum: -15, maximum: 15 })),
    textRotation: Type.Optional(Type.Integer({ minimum: 0, maximum: 180 })),
  }, { additionalProperties: false })),
  numberFormat: Type.Optional(Type.String({ maxLength: 1024 })),
  protection: Type.Optional(Type.Object({
    locked: Type.Optional(Type.Boolean()),
    hidden: Type.Optional(Type.Boolean()),
  }, { additionalProperties: false })),
}, { additionalProperties: false });

const SheetRange = { sheet: Sheet, range: Range };
const ConditionalRule = Type.Object({
  type: StringEnum(["expression", "cellIs"] as const),
  formulas: Type.Array(Type.String({ minLength: 1 }), { minItems: 1, maxItems: 2 }),
  operator: Type.Optional(StringEnum(["between", "notBetween", "equal", "notEqual", "greaterThan", "lessThan", "greaterThanOrEqual", "lessThanOrEqual"] as const)),
  priority: Type.Optional(Type.Integer({ minimum: 1, maximum: 65535 })),
  stopIfTrue: Type.Optional(Type.Boolean()),
  style: Type.Optional(StylePatch),
}, { additionalProperties: false });

const OperationSchema = Type.Union([
  Type.Object({ type: Type.Literal("setValue"), ...SheetRange, value: Scalar }, { additionalProperties: false }),
  Type.Object({ type: Type.Literal("setFormula"), ...SheetRange, formula: Type.String({ minLength: 1 }) }, { additionalProperties: false }),
  Type.Object({ type: Type.Literal("setRichText"), ...SheetRange, runs: Type.Array(Type.Object({ text: Type.String(), font: Type.Optional(FontPatch) }, { additionalProperties: false }), { minItems: 1, maxItems: 1000 }) }, { additionalProperties: false }),
  Type.Object({ type: Type.Literal("clear"), ...SheetRange, mode: Type.Optional(StringEnum(["contents", "all"] as const)) }, { additionalProperties: false }),
  Type.Object({ type: Type.Literal("copyRange"), sourceSheet: Type.Optional(Sheet), sheet: Sheet, sourceRange: Range, targetRange: Range, include: Type.Optional(StringEnum(["all", "values", "styles"] as const)) }, { additionalProperties: false }),
  Type.Object({ type: Type.Literal("fillRange"), sheet: Sheet, sourceCell: Range, targetRange: Range, include: Type.Optional(StringEnum(["all", "values", "styles"] as const)) }, { additionalProperties: false }),
  Type.Object({ type: Type.Literal("copyFormat"), sourceSheet: Sheet, sourceRange: Range, sheet: Sheet, targetRange: Range }, { additionalProperties: false }),
  Type.Object({ type: Type.Literal("setStyle"), ...SheetRange, style: StylePatch }, { additionalProperties: false }),
  Type.Object({ type: Type.Literal("setRowHeight"), sheet: Sheet, startRow: RowNumber, endRow: Type.Optional(RowNumber), height: Type.Number({ exclusiveMinimum: 0, maximum: 409 }) }, { additionalProperties: false }),
  Type.Object({ type: Type.Literal("setRowProperties"), sheet: Sheet, startRow: RowNumber, endRow: Type.Optional(RowNumber), height: Type.Optional(Type.Number({ exclusiveMinimum: 0, maximum: 409 })), hidden: Type.Optional(Type.Boolean()), outlineLevel: Type.Optional(Type.Integer({ minimum: 0, maximum: 7 })), collapsed: Type.Optional(Type.Boolean()) }, { additionalProperties: false }),
  Type.Object({ type: Type.Literal("setColumnWidth"), sheet: Sheet, startColumn: Column, endColumn: Type.Optional(Column), width: Type.Number({ minimum: 0, maximum: 255 }) }, { additionalProperties: false }),
  Type.Object({ type: Type.Literal("setColumnProperties"), sheet: Sheet, startColumn: Column, endColumn: Type.Optional(Column), width: Type.Optional(Type.Number({ minimum: 0, maximum: 255 })), hidden: Type.Optional(Type.Boolean()), outlineLevel: Type.Optional(Type.Integer({ minimum: 0, maximum: 7 })), collapsed: Type.Optional(Type.Boolean()), bestFit: Type.Optional(Type.Boolean()) }, { additionalProperties: false }),
  Type.Object({ type: Type.Literal("autoFit"), sheet: Sheet, range: Type.Optional(Range), rows: Type.Optional(Type.Boolean()), columns: Type.Optional(Type.Boolean()), minColumnWidth: Type.Optional(Type.Number({ minimum: 0, maximum: 255 })), maxColumnWidth: Type.Optional(Type.Number({ minimum: 0, maximum: 255 })) }, { additionalProperties: false }),
  Type.Object({ type: Type.Literal("insertRows"), sheet: Sheet, startRow: RowNumber, count: Type.Integer({ minimum: 1, maximum: 10000 }) }, { additionalProperties: false }),
  Type.Object({ type: Type.Literal("deleteRows"), sheet: Sheet, startRow: RowNumber, count: Type.Integer({ minimum: 1, maximum: 10000 }) }, { additionalProperties: false }),
  Type.Object({ type: Type.Literal("insertColumns"), sheet: Sheet, startColumn: Column, count: Type.Integer({ minimum: 1, maximum: 1000 }) }, { additionalProperties: false }),
  Type.Object({ type: Type.Literal("deleteColumns"), sheet: Sheet, startColumn: Column, count: Type.Integer({ minimum: 1, maximum: 1000 }) }, { additionalProperties: false }),
  Type.Object({ type: Type.Literal("merge"), ...SheetRange }, { additionalProperties: false }),
  Type.Object({ type: Type.Literal("unmerge"), ...SheetRange }, { additionalProperties: false }),
  Type.Object({ type: Type.Literal("setFreezePanes"), sheet: Sheet, rows: Type.Optional(Type.Integer({ minimum: 0, maximum: 1048575 })), columns: Type.Optional(Type.Integer({ minimum: 0, maximum: 16383 })) }, { additionalProperties: false }),
  Type.Object({ type: Type.Literal("setSheetProperties"), sheet: Sheet, name: Type.Optional(Sheet), position: Type.Optional(Type.Integer({ minimum: 0, maximum: 1023 })), state: Type.Optional(StringEnum(["visible", "hidden", "veryHidden"] as const)), tabColor: Type.Optional(HexColor), showGridLines: Type.Optional(Type.Boolean()), zoomScale: Type.Optional(Type.Integer({ minimum: 10, maximum: 400 })) }, { additionalProperties: false }),
  Type.Object({ type: Type.Literal("createSheet"), name: Sheet, position: Type.Optional(Type.Integer({ minimum: 0, maximum: 1023 })), state: Type.Optional(StringEnum(["visible", "hidden", "veryHidden"] as const)), tabColor: Type.Optional(HexColor) }, { additionalProperties: false }),
  Type.Object({ type: Type.Literal("deleteSheet"), sheet: Sheet }, { additionalProperties: false }),
  Type.Object({ type: Type.Literal("setConditionalFormatting"), ...SheetRange, mode: Type.Optional(StringEnum(["replace", "append"] as const)), rules: Type.Array(ConditionalRule, { minItems: 1, maxItems: 100 }) }, { additionalProperties: false }),
  Type.Object({ type: Type.Literal("clearConditionalFormatting"), ...SheetRange }, { additionalProperties: false }),
  Type.Object({ type: Type.Literal("setDataValidation"), ...SheetRange, validationType: StringEnum(["none", "whole", "decimal", "list", "date", "time", "textLength", "custom"] as const), operator: Type.Optional(StringEnum(["between", "notBetween", "equal", "notEqual", "greaterThan", "lessThan", "greaterThanOrEqual", "lessThanOrEqual"] as const)), formula1: Type.Optional(Type.String()), formula2: Type.Optional(Type.String()), allowBlank: Type.Optional(Type.Boolean()), showInputMessage: Type.Optional(Type.Boolean()), showErrorMessage: Type.Optional(Type.Boolean()), promptTitle: Type.Optional(Type.String({ maxLength: 32 })), prompt: Type.Optional(Type.String({ maxLength: 255 })), errorTitle: Type.Optional(Type.String({ maxLength: 32 })), error: Type.Optional(Type.String({ maxLength: 255 })), errorStyle: Type.Optional(StringEnum(["stop", "warning", "information"] as const)) }, { additionalProperties: false }),
  Type.Object({ type: Type.Literal("clearDataValidation"), ...SheetRange }, { additionalProperties: false }),
  Type.Object({ type: Type.Literal("setAutoFilter"), ...SheetRange }, { additionalProperties: false }),
  Type.Object({ type: Type.Literal("clearAutoFilter"), sheet: Sheet }, { additionalProperties: false }),
  Type.Object({ type: Type.Literal("setSort"), ...SheetRange, key: Range, descending: Type.Optional(Type.Boolean()), caseSensitive: Type.Optional(Type.Boolean()) }, { additionalProperties: false }),
  Type.Object({ type: Type.Literal("setDefinedName"), name: Type.String({ minLength: 1, maxLength: 255 }), formula: Type.String({ minLength: 1 }), sheet: Type.Optional(Sheet), hidden: Type.Optional(Type.Boolean()), comment: Type.Optional(Type.String({ maxLength: 255 })) }, { additionalProperties: false }),
  Type.Object({ type: Type.Literal("deleteDefinedName"), name: Type.String({ minLength: 1, maxLength: 255 }), sheet: Type.Optional(Sheet) }, { additionalProperties: false }),
  Type.Object({ type: Type.Literal("setHyperlink"), ...SheetRange, target: Type.String({ minLength: 1, maxLength: 4096 }), display: Type.Optional(Type.String({ maxLength: 32767 })), tooltip: Type.Optional(Type.String({ maxLength: 255 })) }, { additionalProperties: false }),
  Type.Object({ type: Type.Literal("removeHyperlink"), ...SheetRange }, { additionalProperties: false }),
  Type.Object({ type: Type.Literal("setComment"), sheet: Sheet, cell: Cell, author: Type.String({ minLength: 1, maxLength: 255 }), text: Type.String({ maxLength: 32767 }) }, { additionalProperties: false }),
  Type.Object({ type: Type.Literal("removeComment"), sheet: Sheet, cell: Cell }, { additionalProperties: false }),
  Type.Object({ type: Type.Literal("addTable"), ...SheetRange, name: Type.String({ pattern: "^[A-Za-z_\\\\][A-Za-z0-9_.]*$", maxLength: 255 }), displayName: Type.Optional(Type.String({ minLength: 1, maxLength: 255 })), styleName: Type.Optional(Type.String({ maxLength: 255 })), showFirstColumn: Type.Optional(Type.Boolean()), showLastColumn: Type.Optional(Type.Boolean()), showRowStripes: Type.Optional(Type.Boolean()), showColumnStripes: Type.Optional(Type.Boolean()) }, { additionalProperties: false }),
  Type.Object({ type: Type.Literal("removeTable"), sheet: Sheet, name: Type.String({ minLength: 1, maxLength: 255 }) }, { additionalProperties: false }),
  Type.Object({ type: Type.Literal("addImage"), ...SheetRange, name: Type.String({ minLength: 1, maxLength: 255 }), pngBase64: Type.String({ minLength: 12, maxLength: 16777216, pattern: "^[A-Za-z0-9+/]+={0,2}$" }), altText: Type.Optional(Type.String({ maxLength: 1024 })) }, { additionalProperties: false }),
  Type.Object({ type: Type.Literal("addChart"), ...SheetRange, name: Type.String({ minLength: 1, maxLength: 255 }), chartType: StringEnum(["column", "bar", "line", "pie", "area"] as const), categoryRange: Range, valueRange: Range, title: Type.Optional(Type.String({ maxLength: 255 })), style: Type.Optional(Type.Integer({ minimum: 1, maximum: 48 })) }, { additionalProperties: false }),
  Type.Object({ type: Type.Literal("updateChart"), sheet: Sheet, name: Type.String({ minLength: 1, maxLength: 255 }), categoryRange: Type.Optional(Range), valueRange: Type.Optional(Range), title: Type.Optional(Type.String({ maxLength: 255 })), style: Type.Optional(Type.Integer({ minimum: 1, maximum: 48 })) }, { additionalProperties: false }),
  Type.Object({ type: Type.Literal("setPrintSettings"), sheet: Sheet, printArea: Type.Optional(Range), printTitlesRows: Type.Optional(Type.String()), printTitlesColumns: Type.Optional(Type.String()), orientation: Type.Optional(StringEnum(["portrait", "landscape"] as const)), paperSize: Type.Optional(Type.Integer({ minimum: 1, maximum: 118 })), fitToWidth: Type.Optional(Type.Integer({ minimum: 0, maximum: 32767 })), fitToHeight: Type.Optional(Type.Integer({ minimum: 0, maximum: 32767 })), scale: Type.Optional(Type.Integer({ minimum: 10, maximum: 400 })), marginLeft: Type.Optional(Type.Number({ minimum: 0 })), marginRight: Type.Optional(Type.Number({ minimum: 0 })), marginTop: Type.Optional(Type.Number({ minimum: 0 })), marginBottom: Type.Optional(Type.Number({ minimum: 0 })), marginHeader: Type.Optional(Type.Number({ minimum: 0 })), marginFooter: Type.Optional(Type.Number({ minimum: 0 })), header: Type.Optional(Type.String({ maxLength: 255 })), footer: Type.Optional(Type.String({ maxLength: 255 })), horizontalCentered: Type.Optional(Type.Boolean()), verticalCentered: Type.Optional(Type.Boolean()), rowBreaks: Type.Optional(Type.Array(RowNumber, { maxItems: 1000 })), columnBreaks: Type.Optional(Type.Array(Type.Integer({ minimum: 1, maximum: 16384 }), { maxItems: 1000 })) }, { additionalProperties: false }),
  Type.Object({ type: Type.Literal("setThemeColor"), slot: StringEnum(["dark1", "light1", "dark2", "light2", "accent1", "accent2", "accent3", "accent4", "accent5", "accent6", "hyperlink", "followedHyperlink"] as const), color: HexColor }, { additionalProperties: false }),
  Type.Object({ type: Type.Literal("setSheetProtection"), sheet: Sheet, enabled: Type.Boolean(), password: Type.Optional(Password), selectLockedCells: Type.Optional(Type.Boolean()), selectUnlockedCells: Type.Optional(Type.Boolean()), formatCells: Type.Optional(Type.Boolean()), formatColumns: Type.Optional(Type.Boolean()), formatRows: Type.Optional(Type.Boolean()), insertColumns: Type.Optional(Type.Boolean()), insertRows: Type.Optional(Type.Boolean()), deleteColumns: Type.Optional(Type.Boolean()), deleteRows: Type.Optional(Type.Boolean()), sort: Type.Optional(Type.Boolean()), autoFilter: Type.Optional(Type.Boolean()), pivotTables: Type.Optional(Type.Boolean()) }, { additionalProperties: false }),
  Type.Object({ type: Type.Literal("setWorkbookProtection"), enabled: Type.Boolean(), password: Type.Optional(Password), lockStructure: Type.Optional(Type.Boolean()), lockWindows: Type.Optional(Type.Boolean()) }, { additionalProperties: false }),
  Type.Object({ type: Type.Literal("setCalculationSettings"), mode: StringEnum(["manual", "auto", "autoNoTable"] as const), iterate: Type.Optional(Type.Boolean()), iterateCount: Type.Optional(Type.Integer({ minimum: 1, maximum: 10000 })), iterateDelta: Type.Optional(Type.Number({ exclusiveMinimum: 0 })), fullCalcOnLoad: Type.Optional(Type.Boolean()), forceFullCalc: Type.Optional(Type.Boolean()) }, { additionalProperties: false }),
]);

const LimitsSchema = Type.Optional(Type.Object({
  maxArchiveBytes: Type.Optional(Type.Integer({ minimum: 1 })),
  maxEntries: Type.Optional(Type.Integer({ minimum: 1 })),
  maxEntryBytes: Type.Optional(Type.Integer({ minimum: 1 })),
  maxUncompressedBytes: Type.Optional(Type.Integer({ minimum: 1 })),
  maxCompressionRatio: Type.Optional(Type.Number({ exclusiveMinimum: 0 })),
  maxXmlBytes: Type.Optional(Type.Integer({ minimum: 1 })),
  maxSharedStrings: Type.Optional(Type.Integer({ minimum: 1 })),
  maxStyles: Type.Optional(Type.Integer({ minimum: 1 })),
  maxCellsPerRead: Type.Optional(Type.Integer({ minimum: 1 })),
  maxCellsPerEdit: Type.Optional(Type.Integer({ minimum: 1 })),
  maxRenderedCells: Type.Optional(Type.Integer({ minimum: 1 })),
  maxVisibleOutputChars: Type.Optional(Type.Integer({ minimum: 1000 })),
}, { additionalProperties: false }));

export const InspectSchema = Type.Object({ path: WorkbookPath, limits: LimitsSchema }, { additionalProperties: false });
export const ReadSchema = Type.Object({
  path: WorkbookPath,
  sheet: Sheet,
  range: Type.Optional(Range),
  includeFormulas: Type.Optional(Type.Boolean()),
  includeStyles: Type.Optional(Type.Boolean()),
  maxCells: Type.Optional(Type.Integer({ minimum: 1, maximum: 100000 })),
  limits: LimitsSchema,
}, { additionalProperties: false });
export const RenderSchema = Type.Object({
  ...ReadSchema.properties,
  outputDir: Type.Optional(Type.String()),
  scale: Type.Optional(Type.Number({ minimum: 0.5, maximum: 3 })),
}, { additionalProperties: false });
export const EditSchema = Type.Object({
  path: WorkbookPath,
  schemaVersion: Type.Optional(Type.Literal(WORKBOOK_CONTRACT_VERSION, { default: WORKBOOK_CONTRACT_VERSION })),
  operations: Type.Array(OperationSchema, { minItems: 1, maxItems: 1000 }),
  outputPath: Type.Optional(Type.String()),
  dryRun: Type.Optional(Type.Boolean({ default: true })),
  overwrite: Type.Optional(Type.Boolean()),
  expectedSha256: Type.Optional(Type.String({ pattern: "^[a-fA-F0-9]{64}$" })),
  limits: LimitsSchema,
}, { additionalProperties: false });
export const DiffSchema = Type.Object({
  beforePath: WorkbookPath,
  afterPath: WorkbookPath,
  sheet: Type.Optional(Sheet),
  range: Type.Optional(Range),
  maxChanges: Type.Optional(Type.Integer({ minimum: 1, maximum: 10000 })),
  limits: LimitsSchema,
}, { additionalProperties: false });
export const ValidateSchema = Type.Object({ path: WorkbookPath, baselinePath: Type.Optional(WorkbookPath), limits: LimitsSchema }, { additionalProperties: false });

const VbaModuleName = Type.String({ pattern: "^[A-Za-z][A-Za-z0-9_]{0,30}$", maxLength: 31 });
const VbaCode = Type.String({ maxLength: VBA_LIMITS.maxModuleCodeBytes, pattern: "^[\\t\\r\\n\\x20-\\x7E]*$" });
const VbaOperationSchema = Type.Union([
  Type.Object({ type: Type.Literal("addModule"), name: VbaModuleName, kind: StringEnum(["standard", "class"] as const), code: VbaCode }, { additionalProperties: false }),
  Type.Object({ type: Type.Literal("replaceModuleCode"), name: VbaModuleName, code: VbaCode }, { additionalProperties: false }),
  Type.Object({ type: Type.Literal("removeModule"), name: VbaModuleName }, { additionalProperties: false }),
]);
export const VbaReadSchema = Type.Object({
  path: WorkbookPath,
  includeCode: Type.Optional(Type.Boolean({ default: false })),
  modules: Type.Optional(Type.Array(VbaModuleName, { minItems: 1, maxItems: 1000, uniqueItems: true })),
  maxCodeChars: Type.Optional(Type.Integer({ minimum: 1, maximum: VBA_LIMITS.maxReadCodeChars, default: 20000 })),
}, { additionalProperties: false });
export const VbaEditSchema = Type.Object({
  path: WorkbookPath,
  expectedSha256: Type.Optional(Type.String({ pattern: "^[a-fA-F0-9]{64}$" })),
  outputPath: Type.Optional(WorkbookPath),
  dryRun: Type.Optional(Type.Boolean({ default: true })),
  allowSignatureRemoval: Type.Optional(Type.Boolean({ default: false })),
  operations: Type.Array(VbaOperationSchema, { minItems: 1, maxItems: VBA_LIMITS.maxOperations }),
}, { additionalProperties: false });
