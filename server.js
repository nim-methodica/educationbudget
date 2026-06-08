import http from "node:http";
import { writeFile, mkdir, stat, mkdtemp, rm } from "node:fs/promises";
import { createReadStream } from "node:fs";
import { execFile } from "node:child_process";
import { inflateRawSync } from "node:zlib";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { getStorageStatus, initializeStorage, readData, saveData } from "./storage.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(globalThis.process?.env?.PORT || 4173);
const DATA_DIR = path.join(__dirname, "data");
const DEFAULT_DB_DIR = path.join(globalThis.process?.env?.LOCALAPPDATA || DATA_DIR, "educationbudget");
const DB_FILE = globalThis.process?.env?.BUDGET_DB_PATH || path.join(DEFAULT_DB_DIR, "budget.sqlite");
const PUBLIC_DIR = path.join(__dirname, "public");
const OUTPUTS_DIR = path.join(__dirname, "outputs");
const UPLOADS_DIR = path.join(__dirname, "uploads");
const VAT_RATE = 0.18;

const contentTypes = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".pdf": "application/pdf",
  ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  ".xlsm": "application/vnd.ms-excel.sheet.macroEnabled.12",
  ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg"
};

function normalizeData(data) {
  data.frameworks ??= [];
  data.defaultFrameworkId ??= data.frameworks[0]?.id ?? null;
  data.monthlyCases ??= [];
  data.users ??= [];
  for (const framework of data.frameworks || []) {
    framework.cumulativeExecution ??= {};
    for (const regulation of framework.regulations || []) {
      if (String(regulation.number) === "92" && regulation.description === "התקנה המרכזית") {
        regulation.description = "מינהל חדשנות וטכנולוגיה";
      }
    }
  }
  removeDuplicateMonthlyCollections(data);
  cleanKnownNonTenderOrderLines(data);
  return data;
}

function cleanKnownNonTenderOrderLines(data) {
  for (const framework of data.frameworks || []) {
    for (const regulation of framework.regulations || []) {
      for (const order of regulation.projectOrders || []) {
        if (order.orderNumber === "25-019") {
          order.lines = (order.lines || []).filter((line) => String(line.code || "").trim() !== "סיכום");
        }
      }
    }
  }
}

function removeDuplicateMonthlyCollections(data) {
  for (const framework of data.frameworks || []) {
    for (const regulation of framework.regulations || []) {
      for (const order of regulation.projectOrders || []) {
        order.collections = (order.collections || []).filter((collection) => {
          const source = String(collection.sourceDocumentName || "");
          const isAprilOutputReport = source.includes("042026");
          return !(isAprilOutputReport && collection.month !== "2026-04");
        });
      }
    }
  }
}

function seedData() {
  const framework = {
    id: "fw-2026",
    year: "תשפ״ו",
    title: "הזמנת מסגרת תשפ״ו",
    orderNumber: "04502640998",
    isDefault: true,
    activeVersionId: "fw-2026-v1",
    versions: [
      {
        id: "fw-2026-v1",
        label: "גרסה ראשונה",
        sourceFile: "דוח ביצוע מתודיקה תוכנית תשפו_אפריל_26.xlsx",
        approvedAt: "2025-09-01",
        createdAt: new Date().toISOString()
      }
    ],
    regulations: [
      {
        id: "reg-92",
        number: "92",
        name: "תקנה 20670192",
        description: "מינהל חדשנות וטכנולוגיה",
        items: [
          { code: "18.2", name: "תוכן טקסטואלי / טקסט עיוני (מתקדם)", unitCost: 825, approvedQuantity: 120 },
          { code: "22.2", name: "סרטון ללא צילום (מתקדם)", unitCost: 6000, approvedQuantity: 30 },
          { code: "33.1", name: "לומדה בסיסית", unitCost: 13000, approvedQuantity: 35 },
          { code: "40", name: "שעת עריכת תוכן", unitCost: 220, approvedQuantity: 160 },
          { code: "41", name: "שעת מומחה תוכן", unitCost: 330, approvedQuantity: 140 },
          { code: "44", name: "ייעוץ מדעי וטכנו-פדגוגי", unitCost: 137.5, approvedQuantity: 300 }
        ],
        projectOrders: [
          {
            id: "po-25-053",
            orderNumber: "25-053",
            projectName: "פיתוחי סטם מתמטיקה נובמבר-ינואר",
            customerUnit: "אגף STEM",
            issuedAt: "2025-12-24",
            expectedEndAt: "2026-03-31",
            status: "active",
            sourceFile: "פיתוחי סטם מתמטיקה נובמבר-ינואר 25-053.pdf",
            closeReason: "",
            lines: [
              { code: "18.2", quantity: 28, unitCost: 825 },
              { code: "22.2", quantity: 11, unitCost: 6000 },
              { code: "33.1", quantity: 17, unitCost: 13000 },
              { code: "40", quantity: 26, unitCost: 220 },
              { code: "41", quantity: 25, unitCost: 330 },
              { code: "44", quantity: 117, unitCost: 137.5 }
            ],
            collections: [
              { id: "col-po-25-053-1", month: "2026-04", status: "approved", invoiceId: "inv-016533", lineCollections: [
                { code: "18.2", quantity: 15, deliverableLinks: ["https://example.com/stem-tony"] },
                { code: "22.2", quantity: 5, deliverableLinks: ["https://example.com/stem-video"] },
                { code: "40", quantity: 10, deliverableLinks: [] }
              ] }
            ]
          }
        ]
      },
      { id: "reg-46", number: "46", name: "תקנה 20670146", description: "מזכירות פדגוגית / מזה״פ", items: [], projectOrders: [] },
      { id: "reg-27", number: "27", name: "תקנה 20670127", description: "ישראל ריאלית ו-STEM", items: [], projectOrders: [] },
      { id: "reg-73", number: "73", name: "תקנה 20670173", description: "בינה מלאכותית", items: [], projectOrders: [] }
    ]
  };
  return {
    vatRate: VAT_RATE,
    defaultFrameworkId: framework.id,
    frameworks: [framework],
    monthlyCases: [
      {
        id: "case-2026-04",
        frameworkId: framework.id,
        month: "2026-04",
        title: "גביית אפריל 2026",
        status: "client-final-approved",
        indexationAmount: 64957.05,
        invoice: { id: "inv-016533", number: "016533", fileName: "1_16533.pdf", subtotal: 863806.78, vat: 155485.22, total: 1019292 },
        projectIds: ["po-25-053"],
        evidenceFiles: [
          { name: "דיווח תפוקות_042026.xlsx", type: "דוח תפוקות" },
          { name: "דיווח שעות אפריל 26.xlsx", type: "דוח שעות" },
          { name: "דיווח על קבלת שירות מתודיה_מרץ_תשפו_30042026.docx", type: "קבלת שירות" }
        ]
      }
    ],
    users: [
      { id: "u-admin", name: "מנהל מערכת", email: "admin@example.local", role: "admin", passwordSet: true },
      { id: "u-viewer", name: "צופה", email: "viewer@example.local", role: "viewer", passwordSet: true }
    ]
  };
}

function money(amount) {
  const withoutVat = round2(amount);
  return { withoutVat, withVat: round2(withoutVat * (1 + VAT_RATE)) };
}

function round2(num) {
  return Math.round((Number(num) || 0) * 100) / 100;
}

function round3(num) {
  return Math.round((Number(num) || 0) * 1000) / 1000;
}

function compareItemCodes(a, b) {
  const left = String(a || "").split(".").map(Number);
  const right = String(b || "").split(".").map(Number);
  const length = Math.max(left.length, right.length);
  for (let index = 0; index < length; index += 1) {
    const delta = (left[index] || 0) - (right[index] || 0);
    if (delta !== 0) return delta;
  }
  return String(a || "").localeCompare(String(b || ""), "he");
}

function summarizeFramework(framework) {
  return {
    ...framework,
    regulations: framework.regulations.map((regulation) => ({
      ...regulation,
      summary: summarizeRegulation(regulation)
    }))
  };
}

function summarizeRegulation(regulation) {
  const calculatedFrameAmount = regulation.items.reduce((sum, item) => sum + item.unitCost * item.approvedQuantity, 0);
  const frameAmount = Number.isFinite(regulation.frameworkAmount) ? regulation.frameworkAmount : calculatedFrameAmount;
  const reserved = regulation.projectOrders.reduce((sum, order) => sum + orderReservedAmount(order), 0);
  const collected = regulation.projectOrders.reduce((sum, order) => sum + collectOrderAmount(order), 0);
  const cumulativeExecution = Number(regulation.cumulativeExecution?.withoutVat || 0);
  return {
    framework: money(frameAmount),
    reserved: money(reserved),
    collected: money(collected),
    cumulativeExecution: money(cumulativeExecution),
    unreserved: money(frameAmount - reserved),
    remainingToCollect: money(frameAmount - cumulativeExecution),
    orderExecutionGap: money(reserved - cumulativeExecution),
    unpaidOrders: money(reserved - collected),
    activeProjects: regulation.projectOrders.filter((order) => order.status !== "closed").length,
    orderCount: regulation.projectOrders.length,
    lowStockItems: getLowStockItems(regulation).length
  };
}

function orderReservedAmount(order) {
  if (Number.isFinite(order.totalWithoutVat)) return order.totalWithoutVat;
  return order.lines.reduce((sum, line) => sum + (line.unitCost || 0) * (line.quantity || 0), 0);
}

function collectOrderAmount(order) {
  const collectedFromLines = (order.collections || [])
    .filter((collection) => collection.status === "approved")
    .reduce((sum, collection) => {
      if (Number.isFinite(collection.amountWithoutVat)) return sum + collection.amountWithoutVat;
      return sum + (collection.lineCollections || []).reduce((lineSum, collectedLine) => {
        if (Number.isFinite(collectedLine.amountWithoutVat)) return lineSum + collectedLine.amountWithoutVat;
        const line = (order.lines || []).find((entry) => entry.code === collectedLine.code);
        return lineSum + (collectedLine.unitCost || line?.unitCost || 0) * collectedLine.quantity;
      }, 0);
    }, 0);
  if (collectedFromLines > 0) return collectedFromLines;
  if (Number.isFinite(order.paidWithoutVatTotal)) return order.paidWithoutVatTotal;
  if (Number.isFinite(order.paidWithVatTotal)) return order.paidWithVatTotal / (1 + VAT_RATE);
  return 0;
}

function getLowStockItems(regulation) {
  return regulation.items
    .map((item) => {
      const reservedQuantity = regulation.projectOrders.reduce((sum, order) => {
        const line = order.lines.find((entry) => entry.code === item.code);
        return sum + (line?.quantity || 0);
      }, 0);
      const remainingQuantity = item.approvedQuantity - reservedQuantity;
      const remainingRatio = item.approvedQuantity ? remainingQuantity / item.approvedQuantity : 1;
      return { ...item, reservedQuantity, remainingQuantity, remainingRatio };
    })
    .filter((item) => item.remainingRatio <= 0.2);
}

async function extractOrderFromUpload(upload) {
  const buffer = decodeDataUrl(upload.dataUrl || "");
  if (!buffer.length) return { ok: false, error: "לא התקבל קובץ לחילוץ." };
  const ext = path.extname(upload.fileName || "").toLowerCase();
  let text = "";
  if (ext === ".pdf") text = await extractPdfText(buffer);
  else if (ext === ".xlsx" || ext === ".xlsm") text = await extractWorkbookText(buffer, ext);
  else text = buffer.toString("utf8");
  const extracted = parseOrderText(text, upload.fileName || "", upload.expectedOrderNumber || "");
  if (!extracted.orderNumber || !extracted.lines.length) {
    return { ok: false, error: "לא הצלחתי לחלץ מהקובץ מספר הזמנה ושורות פריטים. הקליטה נחסמה עד לחילוץ תקין." };
  }
  return { ok: true, extracted };
}

function extractFrameworkUpdateFromUpload(data, upload) {
  const framework = findFramework(data, upload.frameworkId || data.defaultFrameworkId);
  if (!framework) return { ok: false, error: "הזמנת המסגרת לא נמצאה." };
  const buffer = decodeDataUrl(upload.dataUrl || "");
  if (!buffer.length) return { ok: false, error: "לא התקבל קובץ לקריאה." };
  const ext = path.extname(upload.fileName || "").toLowerCase();
  if (ext !== ".xlsx" && ext !== ".xlsm") return { ok: false, error: "עדכון מסגרת נתמך כרגע מקובץ אקסל בלבד." };

  const sheets = extractWorkbookRowsFromXlsx(buffer);
  const changePlan = extractFrameworkChangePlanFromSheets(sheets);
  if (changePlan) {
    return {
      ok: true,
      fileName: upload.fileName || "",
      sheetName: changePlan.sheetName,
      sourceType: "change-plan",
      summary: changePlan.summary,
      cumulative: [],
      changes: compareFrameworkUpdate(framework, changePlan.summary, changePlan.itemsByRegulation, { includeUnchanged: true })
    };
  }

  const sheet = sheets.find((entry) => entry.rows.some((row) => /סה"?כ הסכמים לפי תקנות/.test(row[50] || "")))
    || sheets.find((entry) => entry.rows.some((row) => /תקנה 20670192/.test(row[50] || "") && /כמות/.test(row[50 + 0] || row[50])))
    || sheets.find((entry) => entry.rows.some((row) => row.some((cell) => /סה"?כ הסכמים לפי תקנות/.test(cell))))
    || sheets.find((entry) => entry.rows.some((row) => row.some((cell) => /דוח ביצוע מצטבר/.test(cell))));
  if (!sheet) return { ok: false, error: "לא נמצא בקובץ אזור סיכום תקנות או דוח ביצוע מצטבר." };

  const summary = extractFrameworkSummaryFromRows(sheet.rows);
  const itemsByRegulation = extractFrameworkItemsFromRows(sheet.rows, summary.withoutVatRowIndex);
  const cumulative = extractFrameworkCumulativeAnchors(sheet.rows);
  if (!Object.keys(summary.regulations).length || !Object.values(itemsByRegulation).some((items) => items.length)) {
    return {
      ok: false,
      error: "לא הצלחתי לזהות את סיכום התקנות ופריטי המסגרת בקובץ.",
      diagnostics: {
        sheetName: sheet.name,
        rows: sheet.rows.length,
        summaryRow: summary.withoutVatRowIndex,
        itemCounts: Object.fromEntries(Object.entries(itemsByRegulation).map(([number, items]) => [number, items.length]))
      }
    };
  }

  return {
    ok: true,
    fileName: upload.fileName || "",
    sheetName: sheet.name,
    summary,
    cumulative,
    changes: compareFrameworkUpdate(framework, summary, itemsByRegulation)
  };
}

function extractFrameworkChangePlanFromSheets(sheets) {
  const sheetColumns = {
    "92": { beforeQuantity: 8, beforeAmount: 9, changeQuantity: 10, changeAmount: 11, afterQuantity: 12, afterAmount: 13 },
    "46": { beforeQuantity: 8, beforeAmount: 9, changeQuantity: 10, changeAmount: 11, afterQuantity: 12, afterAmount: 13 },
    "27": { beforeQuantity: 4, beforeAmount: 5, changeQuantity: 6, changeAmount: 7, afterQuantity: 8, afterAmount: 9 },
    "73": { beforeQuantity: 4, beforeAmount: 5, changeQuantity: 6, changeAmount: 7, afterQuantity: 8, afterAmount: 9 }
  };
  const itemsByRegulation = { "92": [], "46": [], "27": [], "73": [] };
  const summary = {
    label: "תוכנית שינויים לפי חוצצי תקנות",
    withoutVatRowIndex: -1,
    withVatRowIndex: -1,
    regulations: {},
    total: { withoutVat: 0, withVat: 0 }
  };
  let foundAny = false;

  Object.entries(sheetColumns).forEach(([number, columns]) => {
    const sheet = sheets.find((entry) => String(entry.name || "").trim() === number);
    if (!sheet) return;
    const items = extractFrameworkChangePlanItems(sheet.rows, columns);
    if (!items.length) return;
    foundAny = true;
    itemsByRegulation[number] = items;
    const quantity = round2(items.reduce((sum, item) => sum + Number(item.approvedQuantity || 0), 0));
    const withoutVat = round2(items.reduce((sum, item) => sum + Number(item.amountWithoutVat || 0), 0));
    summary.regulations[number] = {
      quantity,
      withoutVat,
      withVat: round2(withoutVat * (1 + VAT_RATE))
    };
    summary.total.withoutVat = round2(summary.total.withoutVat + withoutVat);
  });

  summary.total.withVat = round2(summary.total.withoutVat * (1 + VAT_RATE));
  Object.values(itemsByRegulation).forEach((items) => items.sort((a, b) => compareItemCodes(a.code, b.code)));
  return foundAny ? { sheetName: "חוצצי תקנות 92/46/27/73", summary, itemsByRegulation } : null;
}

function extractFrameworkChangePlanItems(rows, columns) {
  const items = [];
  rows.forEach((row) => {
    const code = normalizeItemCode(row[0]);
    const name = String(row[1] || "").trim();
    const unitCost = parseNumber(row[2]);
    if (!code || !name || !Number.isFinite(unitCost) || unitCost <= 0) return;
    if (/סה"?כ|סהכ|סיכום|עלות/.test(name)) return;

    const beforeQuantity = parseNumber(row[columns.beforeQuantity]);
    const beforeAmount = parseNumber(row[columns.beforeAmount]);
    const quantityChange = parseNumber(row[columns.changeQuantity]);
    const amountChange = parseNumber(row[columns.changeAmount]);
    const approvedQuantity = parseNumber(row[columns.afterQuantity]);
    const amountWithoutVat = parseNumber(row[columns.afterAmount]);
    const hasRelevantValue = [beforeQuantity, beforeAmount, quantityChange, amountChange, approvedQuantity, amountWithoutVat]
      .some((value) => Number.isFinite(value) && value !== 0);
    if (!hasRelevantValue) return;

    items.push({
      code,
      name,
      unitCost: round3(unitCost),
      approvedQuantity: round3(approvedQuantity),
      quantityChange: round3(quantityChange),
      quantityBeforeChange: round3(beforeQuantity),
      amountWithoutVat: round2(amountWithoutVat)
    });
  });
  return items;
}

function extractFrameworkSummaryFromRows(rows) {
  const amountColumns = { "92": 51, "46": 53, "27": 55, "73": 57, total: 59 };
  const candidates = rows
    .map((row, index) => ({ index, row, total: parseNumber(row[amountColumns.total]) }))
    .filter((entry) => Number.isFinite(entry.total) && entry.total > 1000000);
  let withoutVat = candidates[0];
  let withVatRow = null;
  for (let i = 0; i < candidates.length - 1; i += 1) {
    const first = candidates[i];
    const second = candidates[i + 1];
    if (Math.abs(second.total / first.total - (1 + VAT_RATE)) < 0.01) {
      withoutVat = first;
      withVatRow = second;
      break;
    }
  }
  const regulations = {};
  Object.entries(amountColumns).forEach(([number, amountColumn]) => {
    if (number === "total") return;
    const amount = round2(parseNumber(withoutVat?.row?.[amountColumn]));
    const quantity = parseNumber(withoutVat?.row?.[amountColumn - 1]);
    const withVat = withVatRow ? round2(parseNumber(withVatRow.row[amountColumn])) : round2(amount * (1 + VAT_RATE));
    if (Number.isFinite(amount)) regulations[number] = { quantity, withoutVat: amount, withVat };
  });
  return {
    label: "סה״כ הסכמים לפי תקנות",
    withoutVatRowIndex: withoutVat?.index ?? -1,
    withVatRowIndex: withVatRow?.index ?? -1,
    regulations,
    total: {
      withoutVat: round2(parseNumber(withoutVat?.row?.[amountColumns.total])),
      withVat: withVatRow ? round2(parseNumber(withVatRow.row[amountColumns.total])) : round2(parseNumber(withoutVat?.row?.[amountColumns.total]) * (1 + VAT_RATE))
    }
  };
}

function extractFrameworkItemsFromRows(rows, stopIndex) {
  const regulationColumns = [
    { number: "92", changeQuantity: 40, quantity: 50, amount: 51 },
    { number: "46", changeQuantity: 42, quantity: 52, amount: 53 },
    { number: "27", changeQuantity: 44, quantity: 54, amount: 55 },
    { number: "73", changeQuantity: 46, quantity: 56, amount: 57 }
  ];
  const itemsByRegulation = { "92": [], "46": [], "27": [], "73": [] };
  const lastIndex = stopIndex > 0 ? stopIndex : rows.length;
  rows.slice(0, lastIndex).forEach((row) => {
    const code = normalizeItemCode(row[0]);
    const name = String(row[1] || "").trim();
    const unitCost = parseNumber(row[2]);
    if (!code || !name || !Number.isFinite(unitCost) || unitCost <= 0) return;
    regulationColumns.forEach((columns) => {
      const quantity = parseNumber(row[columns.quantity]);
      const amount = parseNumber(row[columns.amount]);
      const quantityChange = parseNumber(row[columns.changeQuantity]);
      if ((Number.isFinite(quantity) && quantity > 0) || (Number.isFinite(amount) && amount > 0)) {
        itemsByRegulation[columns.number].push({
          code,
          name,
          unitCost: round2(unitCost),
          approvedQuantity: round2(quantity),
          quantityChange: round2(quantityChange),
          quantityBeforeChange: round2(quantity - quantityChange),
          amountWithoutVat: round2(amount)
        });
      }
    });
  });
  return itemsByRegulation;
}

function extractFrameworkCumulativeAnchors(rows) {
  const anchors = [];
  rows.forEach((row, index) => {
    row.forEach((cell, column) => {
      if (!/דוח ביצוע מצטבר/.test(cell)) return;
      const columns = detectReportColumns(row, column);
      const totals = extractReportTotals(rows, index, columns);
      anchors.push({ label: cell, rowIndex: index, columnIndex: column, columns, totals });
    });
  });
  return anchors;
}

function detectReportColumns(row, anchorColumn) {
  const regs = [];
  for (let column = anchorColumn; column < Math.min(row.length, anchorColumn + 12); column += 1) {
    const match = String(row[column] || "").match(/206701(92|46|27|73)/);
    if (match) regs.push({ number: match[1], quantity: column, amount: column + 1 });
  }
  return regs;
}

function extractReportTotals(rows, anchorIndex, columns) {
  const totals = {};
  const candidates = rows.slice(anchorIndex + 1).filter((row) =>
    columns.some((entry) => parseNumber(row[entry.amount]) > 0)
  );
  const row = candidates[candidates.length - 1] || [];
  columns.forEach((entry) => {
    totals[entry.number] = {
      quantity: parseNumber(row[entry.quantity]),
      withoutVat: round2(parseNumber(row[entry.amount]))
    };
  });
  return totals;
}

function compareFrameworkUpdate(framework, summary, itemsByRegulation, options = {}) {
  const regulationChanges = framework.regulations.map((regulation) => {
    const extracted = summary.regulations[regulation.number] || { withoutVat: 0, withVat: 0 };
    const current = Number(regulation.frameworkAmount || 0);
    return {
      regulationId: regulation.id,
      number: regulation.number,
      name: regulation.name,
      currentWithoutVat: round2(current),
      extractedWithoutVat: round2(extracted.withoutVat),
      currentWithVat: round2(current * (1 + VAT_RATE)),
      extractedWithVat: round2(extracted.withVat),
      deltaWithoutVat: round2(extracted.withoutVat - current)
    };
  });

  const itemChanges = framework.regulations.flatMap((regulation) => {
    const current = new Map((regulation.items || []).map((item) => [item.code, item]));
    const extracted = new Map((itemsByRegulation[regulation.number] || []).map((item) => [item.code, item]));
    const codes = [...new Set([...current.keys(), ...extracted.keys()])].sort(compareItemCodes);
    return codes.map((code) => {
      const before = current.get(code);
      const after = extracted.get(code);
      const status = before && after ? "changed" : after ? "new" : "removed";
      const quantityDelta = round2(Number(after?.approvedQuantity || 0) - Number(before?.approvedQuantity || 0));
      const unitDelta = round2(Number(after?.unitCost || 0) - Number(before?.unitCost || 0));
      const nameChanged = Boolean(before && after && before.name !== after.name);
      const fileQuantityChange = round2(after?.quantityChange || 0);
      const unchanged = status === "changed" && fileQuantityChange === 0 && quantityDelta === 0 && unitDelta === 0 && !nameChanged;
      return {
        regulationNumber: regulation.number,
        regulationId: regulation.id,
        code,
        status: unchanged ? "unchanged" : status,
        currentName: before?.name || "",
        extractedName: after?.name || "",
        currentQuantity: round2(before?.approvedQuantity || 0),
        fileQuantityBeforeChange: round2(after?.quantityBeforeChange || 0),
        fileQuantityChange,
        extractedQuantity: round2(after?.approvedQuantity || 0),
        quantityDelta,
        currentUnitCost: round2(before?.unitCost || 0),
        extractedUnitCost: round2(after?.unitCost || 0),
        unitDelta,
        nameChanged
      };
    }).filter((change) =>
      options.includeUnchanged || change.status !== "unchanged"
    );
  });

  return { regulationChanges, itemChanges };
}

function extractCumulativeExecutionFromUpload(data, upload) {
  const framework = findFramework(data, upload.frameworkId || data.defaultFrameworkId);
  if (!framework) return { ok: false, error: "הזמנת המסגרת לא נמצאה." };
  const buffer = decodeDataUrl(upload.dataUrl || "");
  if (!buffer.length) return { ok: false, error: "לא התקבל קובץ לקריאה." };
  const ext = path.extname(upload.fileName || "").toLowerCase();
  if (ext !== ".xlsx" && ext !== ".xlsm") return { ok: false, error: "ביצוע מצטבר נתמך כרגע מקובץ אקסל בלבד." };
  const sheets = extractWorkbookRowsFromXlsx(buffer);
  const sheet = sheets.find((entry) => entry.rows.some((row) => row.some((cell) => /דוח ביצוע מצטבר/.test(cell))))
    || sheets.find((entry) => entry.rows.some((row) => /תקנה 20670192/.test(row[60] || "") || /תקנה 20670192/.test(row[61] || "")));
  if (!sheet) return { ok: false, error: "לא נמצא בקובץ אזור דוח ביצוע מצטבר." };
  const totals = extractCumulativeExecutionFromRows(sheet.rows);
  if (!Object.keys(totals.regulations).length) {
    return { ok: false, error: "לא הצלחתי לזהות סכומי ביצוע מצטבר לפי תקנות.", diagnostics: { sheetName: sheet.name, rows: sheet.rows.length } };
  }
  const changes = framework.regulations.map((regulation) => {
    const extracted = totals.regulations[regulation.number] || { quantity: 0, withoutVat: 0 };
    const current = Number(regulation.cumulativeExecution?.withoutVat || 0);
    return {
      regulationId: regulation.id,
      number: regulation.number,
      name: regulation.name,
      currentWithoutVat: round2(current),
      extractedWithoutVat: round2(extracted.withoutVat),
      currentWithVat: round2(current * (1 + VAT_RATE)),
      extractedWithVat: round2(extracted.withoutVat * (1 + VAT_RATE)),
      deltaWithoutVat: round2(extracted.withoutVat - current),
      quantity: round3(extracted.quantity)
    };
  });
  return { ok: true, fileName: upload.fileName || "", sheetName: sheet.name, totals, changes };
}

function extractCumulativeExecutionFromRows(rows) {
  const columns = {
    "92": { quantity: 60, amount: 61 },
    "46": { quantity: 62, amount: 63 },
    "27": { quantity: 64, amount: 65 },
    "73": { quantity: 66, amount: 67 }
  };
  const regulations = {};
  Object.entries(columns).forEach(([number, column]) => {
    const matchingRows = rows
      .map((row) => ({ quantity: parseNumber(row[column.quantity]), withoutVat: parseNumber(row[column.amount]) }))
      .filter((entry) => Number.isFinite(entry.withoutVat) && entry.withoutVat > 0);
    const totalRow = matchingRows[matchingRows.length - 1];
    regulations[number] = totalRow
      ? { quantity: round3(totalRow.quantity), withoutVat: round2(totalRow.withoutVat), withVat: round2(totalRow.withoutVat * (1 + VAT_RATE)) }
      : { quantity: 0, withoutVat: 0, withVat: 0 };
  });
  const totalWithoutVat = round2(Object.values(regulations).reduce((sum, row) => sum + Number(row.withoutVat || 0), 0));
  return {
    label: "דוח ביצוע מצטבר",
    regulations,
    total: { withoutVat: totalWithoutVat, withVat: round2(totalWithoutVat * (1 + VAT_RATE)) }
  };
}

async function applyCumulativeExecutionUpdate(data, body) {
  const framework = findFramework(data, body.frameworkId || data.defaultFrameworkId);
  if (!framework) return { ok: false, status: 404, error: "הזמנת המסגרת לא נמצאה." };
  const rows = Array.isArray(body.rows) ? body.rows : [];
  if (!rows.length) return { ok: false, status: 422, error: "לא התקבלו נתוני ביצוע מצטבר." };
  const byNumber = new Map(rows.map((row) => [String(row.number || row.regulationNumber || ""), row]));
  for (const regulation of framework.regulations || []) {
    const row = byNumber.get(String(regulation.number));
    if (!row) continue;
    const withoutVat = round2(row.withoutVat ?? row.extractedWithoutVat);
    regulation.cumulativeExecution = {
      quantity: round3(row.quantity || 0),
      withoutVat,
      withVat: round2(withoutVat * (1 + VAT_RATE)),
      sourceFile: body.sourceFileName || "",
      updatedAt: new Date().toISOString()
    };
  }
  framework.cumulativeExecution = {
    sourceFile: body.sourceFileName || "",
    updatedAt: new Date().toISOString()
  };
  await saveData(data);
  return { ok: true, framework: summarizeFramework(framework) };
}

async function applyFrameworkItemsUpdate(data, body) {
  const framework = findFramework(data, body.frameworkId || data.defaultFrameworkId);
  if (!framework) return { ok: false, status: 404, error: "הזמנת המסגרת לא נמצאה." };
  const rows = Array.isArray(body.rows) ? body.rows : [];
  if (!rows.length) return { ok: false, status: 422, error: "לא התקבלו פריטים לעדכון." };
  const rowsByRegulation = new Map();
  rows.forEach((row) => {
    const regulationNumber = String(row.regulationNumber || "").trim();
    const code = normalizeItemCode(row.code);
    const name = String(row.name || row.extractedName || row.currentName || "").trim();
    const unitCost = round3(row.unitCost ?? row.extractedUnitCost ?? row.currentUnitCost);
    const approvedQuantity = round3(row.approvedQuantity ?? row.extractedQuantity);
    if (!regulationNumber || !code || !name || !Number.isFinite(unitCost) || unitCost < 0 || !Number.isFinite(approvedQuantity)) return;
    if (!rowsByRegulation.has(regulationNumber)) rowsByRegulation.set(regulationNumber, []);
    rowsByRegulation.get(regulationNumber).push({ code, name, unitCost, approvedQuantity });
  });

  for (const regulation of framework.regulations || []) {
    const items = rowsByRegulation.get(regulation.number);
    if (!items) continue;
    regulation.items = items
      .sort((a, b) => compareItemCodes(a.code, b.code))
      .map((item) => ({
        ...item,
        approvedQuantity: round3(item.approvedQuantity),
        unitCost: round3(item.unitCost)
      }));
    regulation.frameworkAmount = round2(regulation.items.reduce((sum, item) => sum + item.unitCost * item.approvedQuantity, 0));
  }

  framework.versions ??= [];
  framework.activeVersionId = `fw-version-${Date.now()}`;
  framework.versions.push({
    id: framework.activeVersionId,
    label: body.sourceFileName ? `עדכון פריטים ${body.sourceFileName}` : "עדכון פריטי מסגרת",
    sourceFile: body.sourceFileName || "",
    approvedAt: new Date().toISOString().slice(0, 10),
    createdAt: new Date().toISOString()
  });
  await saveData(data);
  return { ok: true, framework: summarizeFramework(framework) };
}

async function applyCollectionDocument(data, caseId, upload) {
  const monthlyCase = data.monthlyCases.find((entry) => entry.id === caseId);
  if (!monthlyCase) return { ok: false, status: 404, error: "תיק הגביה לא נמצא." };
  const documentId = `doc-${Date.now()}`;
  const buffer = decodeDataUrl(upload.dataUrl || "");
  const originalName = upload.fileName || "מסמך";
  const ext = path.extname(originalName).toLowerCase();
  const storedName = `${documentId}${ext || ".bin"}`;
  const caseUploadDir = path.join(UPLOADS_DIR, caseId);
  await mkdir(caseUploadDir, { recursive: true });
  await writeFile(path.join(caseUploadDir, storedName), buffer);
  const document = {
    id: documentId,
    name: originalName,
    type: normalizeDocumentType(upload.documentType || detectDocumentTypeFromFileName(originalName) || "אחר"),
    size: Number(upload.size || 0),
    uploadedAt: new Date().toISOString(),
    storedName,
    url: `/api/monthly-cases/${encodeURIComponent(caseId)}/documents/${encodeURIComponent(documentId)}/file`
  };
  monthlyCase.evidenceFiles = monthlyCase.evidenceFiles || [];
  monthlyCase.evidenceFiles.push(document);

  let extraction = { appliedRows: [], unmatchedRows: [], addedOrderLines: [], totalAmountWithoutVat: 0 };
  if (document.type === "דוח תפוקות") {
    extraction = extractCollectionRowsFromUpload(data, monthlyCase, upload);
    applyCollectionRows(data, monthlyCase, extraction.appliedRows, document.name);
  }

  await saveData(data);
  return { ok: true, monthlyCase, document, extraction };
}

function detectDocumentTypeFromFileName(fileName) {
  const name = String(fileName || "").toLowerCase();
  if (!name) return "";
  if (/תפוק|deliver|output/.test(name)) return "דוח תפוקות";
  if (/שעות|hour|timesheet/.test(name)) return "דוח שעות";
  if (/ביצוע|execution|performance/.test(name)) return "דוח ביצוע";
  if (/חשבונית|invoice|16533|16584/.test(name)) return "חשבונית";
  if (/קבלת.?שירות|service/.test(name)) return "קבלת שירות חתומה";
  if (/אישור|לקוח|approval|approved/.test(name)) return "אישור לקוח";
  return "";
}

function normalizeDocumentType(type) {
  const aliases = {
    "קבלת שירות": "קבלת שירות חתומה"
  };
  return aliases[type] || type || "אחר";
}

function extractCollectionRowsFromUpload(data, monthlyCase, upload) {
  const framework = findFramework(data, monthlyCase.frameworkId);
  if (!framework) return { appliedRows: [], unmatchedRows: [{ reason: "הזמנת המסגרת לא נמצאה." }], totalAmountWithoutVat: 0 };
  const buffer = decodeDataUrl(upload.dataUrl || "");
  const ext = path.extname(upload.fileName || "").toLowerCase();
  if (!buffer.length) return { appliedRows: [], unmatchedRows: [{ reason: "לא התקבל קובץ." }], totalAmountWithoutVat: 0 };
  if (ext !== ".xlsx" && ext !== ".xlsm") {
    return { appliedRows: [], unmatchedRows: [{ reason: "בשלב זה חילוץ גביה נתמך מקובצי Excel בלבד." }], totalAmountWithoutVat: 0 };
  }
  const sheets = extractWorkbookRowsFromXlsx(buffer);
  const orders = framework.regulations.flatMap((regulation) =>
    regulation.projectOrders.map((order) => ({ framework, regulation, order }))
  );
  const appliedRows = [];
  const unmatchedRows = [];
  const addedOrderLines = [];
  sheets.forEach((sheet) => {
    const sheetText = `${sheet.name} ${sheet.rows.slice(0, 12).flat().join(" ")}`;
    const sheetOrder = findOrderInText(orders, sheetText);
    const header = findCollectionHeader(sheet.rows);
    if (header.index < 0) return;
    const rowsToScan = header.index >= 0 ? sheet.rows.slice(header.index + 1) : sheet.rows;
    let currentOrder = sheetOrder;
    rowsToScan.forEach((row, rowIndex) => {
      const rowText = row.join(" ");
      const rowOrder = findOrderInText(orders, rowText);
      if (rowOrder) currentOrder = rowOrder;
      const orderEntry = rowOrder || currentOrder || findOrderByUniqueCode(orders, row);
      const code = findCollectionCode(row, header, orderEntry, orders);
      const quantity = findCollectionQuantity(row, header, code);
      if (!code && !quantity) return;
      if (!orderEntry) {
        unmatchedRows.push({ sheet: sheet.name, row: rowIndex + 1, code, quantity, reason: "לא זוהתה הזמנה לשורה." });
        return;
      }
      let orderLine = orderEntry.order.lines.find((line) => line.code === code);
      if (!orderLine) {
        const frameworkItem = findFrameworkItemByCode(orderEntry.framework, code);
        const unitCostFromRow = findCollectionUnitCost(row, header);
        const orderQuantityFromRow = findCollectionOrderQuantity(row, header);
        const unitCost = Number(unitCostFromRow || frameworkItem?.unitCost || 0);
        const orderQuantity = Number(orderQuantityFromRow || quantity || 0);
        if (Number.isFinite(unitCost) && unitCost > 0 && Number.isFinite(orderQuantity) && orderQuantity > 0) {
          orderLine = {
            code,
            quantity: orderQuantity,
            unitCost,
            inferredFromCollection: true,
            inferredItemName: findCollectionItemName(row, header) || frameworkItem?.name || ""
          };
          orderEntry.order.lines.push(orderLine);
          addedOrderLines.push({
            orderNumber: orderEntry.order.orderNumber,
            projectName: orderEntry.order.projectName,
            code,
            itemName: orderLine.inferredItemName,
            quantity: orderLine.quantity,
            unitCost: orderLine.unitCost
          });
        } else {
          unmatchedRows.push({
            sheet: sheet.name,
            row: rowIndex + 1,
            orderNumber: orderEntry.order.orderNumber,
            projectName: orderEntry.order.projectName,
            code,
            itemName: frameworkItem?.name || findCollectionItemName(row, header) || "",
            quantity,
            reason: "הסעיף קיים בדוח אבל חסרים נתוני כמות או עלות כדי להוסיף אותו להזמנה."
          });
          return;
        }
      }
      if (!Number.isFinite(quantity) || quantity <= 0) return;
      const unitCost = Number(orderLine.unitCost || orderEntry.regulation.items.find((item) => item.code === code)?.unitCost || 0);
      const amountFromReport = findCollectionAmount(row);
      const deliverableLinks = row.filter((cell) => /^https?:\/\//i.test(String(cell || "")));
      appliedRows.push({
        orderId: orderEntry.order.id,
        orderNumber: orderEntry.order.orderNumber,
        projectName: orderEntry.order.projectName,
        regulationId: orderEntry.regulation.id,
        regulationNumber: orderEntry.regulation.number,
        code,
        quantity,
        unitCost,
        amountWithoutVat: Number.isFinite(amountFromReport) && amountFromReport > 0 ? round2(amountFromReport) : round2(quantity * unitCost),
        deliverableLinks
      });
    });
  });
  return {
    appliedRows,
    unmatchedRows,
    addedOrderLines,
    totalAmountWithoutVat: round2(appliedRows.reduce((sum, row) => sum + row.amountWithoutVat, 0))
  };
}

function findOrderByUniqueCode(orders, row) {
  const codes = row.map(normalizeItemCode).filter(Boolean);
  if (!codes.length) return null;
  const matches = orders.filter(({ order }) => codes.some((code) => order.lines.some((line) => line.code === code)));
  return matches.length === 1 ? matches[0] : null;
}

function applyCollectionRows(data, monthlyCase, rows, sourceDocumentName) {
  const rowsByOrder = new Map();
  const normalizedRows = normalizeCollectionRows(data, rows);
  normalizedRows.forEach((row) => {
    if (!rowsByOrder.has(row.orderId)) rowsByOrder.set(row.orderId, []);
    rowsByOrder.get(row.orderId).push(row);
  });
  data.frameworks.forEach((framework) => {
    framework.regulations.forEach((regulation) => {
      regulation.projectOrders.forEach((order) => {
        order.collections = (order.collections || []).filter((collection) => collection.monthlyCaseId !== monthlyCase.id);
        if (!rowsByOrder.has(order.id)) return;
        const lineCollections = rowsByOrder.get(order.id).map((row) => ({
          code: row.code,
          quantity: row.quantity,
          unitCost: row.unitCost,
          amountWithoutVat: row.amountWithoutVat,
          deliverableLinks: row.deliverableLinks || []
        }));
        order.collections.push({
          id: `col-${order.id}-${monthlyCase.id}-${Date.now()}`,
          month: monthlyCase.month,
          status: "approved",
          monthlyCaseId: monthlyCase.id,
          sourceDocumentName,
          amountWithoutVat: round2(lineCollections.reduce((sum, line) => sum + Number(line.amountWithoutVat || 0), 0)),
          lineCollections
        });
      });
    });
  });
  const oldMonthlyOrderIds = new Set(data.frameworks.flatMap((framework) =>
    framework.regulations.flatMap((regulation) =>
      regulation.projectOrders
        .filter((order) => (order.collections || []).some((collection) => collection.monthlyCaseId === monthlyCase.id))
        .map((order) => order.id)
    )
  ));
  const projectIds = new Set((monthlyCase.projectIds || []).filter((id) => oldMonthlyOrderIds.has(id)));
  normalizedRows.forEach((row) => projectIds.add(row.orderId));
  monthlyCase.projectIds = [...projectIds];
}

function normalizeCollectionRows(data, rows) {
  const orderLines = new Map();
  data.frameworks.forEach((framework) => {
    framework.regulations.forEach((regulation) => {
      regulation.projectOrders.forEach((order) => {
        order.lines.forEach((line) => {
          orderLines.set(`${order.id}::${line.code}`, line);
        });
      });
    });
  });
  const byLine = new Map();
  rows.forEach((row) => {
    const key = `${row.orderId}::${row.code}`;
    const current = byLine.get(key);
    const quantity = Number(row.quantity || 0);
    if (current) {
      current.quantity += quantity;
      current.amountWithoutVat = round2(Number(current.amountWithoutVat || 0) + Number(row.amountWithoutVat || 0));
      current.deliverableLinks = [...new Set([...(current.deliverableLinks || []), ...(row.deliverableLinks || [])])];
    } else {
      byLine.set(key, { ...row, quantity });
    }
  });
  return [...byLine.values()].map((row) => {
    const orderLine = orderLines.get(`${row.orderId}::${row.code}`);
    const maxQuantity = Number(orderLine?.quantity || row.quantity || 0);
    const quantity = Math.min(Number(row.quantity || 0), maxQuantity);
    return {
      ...row,
      quantity,
      amountWithoutVat: Number.isFinite(Number(row.amountWithoutVat)) && Number(row.amountWithoutVat) > 0
        ? round2(Number(row.amountWithoutVat))
        : round2(quantity * Number(row.unitCost || orderLine?.unitCost || 0))
    };
  }).filter((row) => row.quantity > 0);
}

function extractWorkbookRowsFromXlsx(buffer) {
  const files = readZipEntries(buffer);
  const workbookXml = files.get("xl/workbook.xml")?.toString("utf8") || "";
  const relsXml = files.get("xl/_rels/workbook.xml.rels")?.toString("utf8") || "";
  const sharedStrings = parseSharedStrings(files.get("xl/sharedStrings.xml")?.toString("utf8") || "");
  const sheetNames = parseWorkbookSheets(workbookXml);
  const relTargets = parseWorkbookRels(relsXml);
  return sheetNames.map((sheet, index) => {
    const target = relTargets.get(sheet.rid) || `worksheets/sheet${index + 1}.xml`;
    const sheetPath = `xl/${target.replace(/^\//, "").replace(/^xl\//, "")}`;
    const sheetXml = files.get(sheetPath)?.toString("utf8") || "";
    return { name: sheet.name, rows: parseSheetRowsWithColumns(sheetXml, sharedStrings) };
  }).filter((sheet) => sheet.rows.length);
}

function parseSheetRowsWithColumns(xml, sharedStrings) {
  return [...xml.matchAll(/<row\b[\s\S]*?<\/row>/g)].map((rowMatch) => {
    const values = [];
    [...rowMatch[0].matchAll(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)].forEach((cellMatch) => {
      const attrs = cellMatch[1];
      const body = cellMatch[2] || "";
      const ref = attrs.match(/\br="([A-Z]+)\d+"/)?.[1] || "";
      const colIndex = ref ? columnLettersToIndex(ref) : values.length;
      const rawValue = body.match(/<v>([\s\S]*?)<\/v>/)?.[1] || body.match(/<t[^>]*>([\s\S]*?)<\/t>/)?.[1] || "";
      const type = attrs.match(/\bt="([^"]+)"/)?.[1] || "";
      let value = decodeXml(rawValue);
      if (type === "s") value = sharedStrings[Number(value)] || "";
      if (value !== "") values[colIndex] = value;
    });
    return values.map((value) => String(value || "").trim());
  }).filter((row) => row.some(Boolean));
}

function columnLettersToIndex(letters) {
  return [...letters].reduce((sum, letter) => sum * 26 + letter.charCodeAt(0) - 64, 0) - 1;
}

function findCollectionHeader(rows) {
  let best = { index: -1, order: -1, code: -1, quantity: -1 };
  rows.forEach((row, index) => {
    const code = row.findIndex((cell) => /מספר פריט|סעיף/.test(cell));
    const order = row.findIndex((cell) => /הזמנת עבודה|הזמנה/.test(cell));
    const quantity = row.findIndex((cell) => /כמות/.test(cell) && !/בהזמנה|הסכם/.test(cell));
    if (code >= 0 && order >= 0 && best.index === -1) best = { index, order, code, quantity };
  });
  return best;
}

function findOrderInText(orders, text) {
  const normalized = String(text || "");
  return orders.find(({ order }) => order.orderNumber && normalized.includes(order.orderNumber))
    || orders.find(({ order }) => order.projectName && normalized.includes(order.projectName))
    || orders
      .map((entry) => ({ entry, score: fuzzyHebrewScore(entry.order.projectName, normalized) }))
      .filter((item) => item.score >= 3)
      .sort((a, b) => b.score - a.score)[0]?.entry;
}

function fuzzyHebrewScore(source, target) {
  const words = new Set(String(source || "")
    .split(/[^\p{L}\p{N}]+/u)
    .map((word) => word.trim())
    .filter((word) => word.length >= 3));
  const targetText = String(target || "");
  let score = 0;
  words.forEach((word) => {
    if (targetText.includes(word)) score += 1;
  });
  return score;
}

function findCollectionCode(row, header, orderEntry, orders) {
  const fromHeader = header.code >= 0 ? normalizeItemCode(row[header.code]) : "";
  if (fromHeader) return fromHeader;
  const candidates = orderEntry
    ? orderEntry.order.lines.map((line) => line.code)
    : [...new Set(orders.flatMap(({ order }) => order.lines.map((line) => line.code)))];
  const byCode = candidates.find((code) => row.some((cell) => normalizeItemCode(cell) === code));
  if (byCode) return byCode;
  if (orderEntry) {
    const rowText = normalizeLooseText(row.join(" "));
    const matchedLine = orderEntry.order.lines.find((line) => {
      const item = orderEntry.regulation.items.find((entry) => entry.code === line.code)
        || findFrameworkItemByCode(orderEntry.framework, line.code);
      return item?.name && looseNameScore(item.name, rowText) >= 2;
    });
    if (matchedLine) return matchedLine.code;
  }
  return "";
}

function findCollectionQuantity(row, header, code) {
  const quantityFromColumnJ = parseNumber(row[9]);
  if (Number.isFinite(quantityFromColumnJ) && quantityFromColumnJ > 0) return quantityFromColumnJ;
  return 0;
}

function findCollectionAmount(row) {
  const amountFromColumnN = parseNumber(row[13]);
  if (Number.isFinite(amountFromColumnN) && amountFromColumnN > 0) return amountFromColumnN;
  return 0;
}

function findCollectionQuantityFallback(row, header, code) {
  if (header.quantity >= 0) {
    const value = parseNumber(row[header.quantity]);
    if (Number.isFinite(value) && value > 0) return value;
  }
  const codeIndex = row.findIndex((cell) => normalizeItemCode(cell) === code);
  const nearby = row.slice(Math.max(0, codeIndex), codeIndex + 5).map(parseNumber)
    .filter((value) => Number.isFinite(value) && value > 0 && value < 100000);
  return nearby.find((value) => value !== parseNumber(code)) || 0;
}

function findCollectionOrderQuantity(row, header) {
  const quantityFromColumnG = parseNumber(row[6]);
  if (Number.isFinite(quantityFromColumnG) && quantityFromColumnG > 0) return quantityFromColumnG;
  const quantityIndex = header.quantity >= 0 ? header.quantity : row.findIndex((cell) => /כמות/.test(String(cell || "")));
  const value = quantityIndex >= 0 ? parseNumber(row[quantityIndex]) : 0;
  return Number.isFinite(value) && value > 0 ? value : 0;
}

function findCollectionUnitCost(row, header) {
  const costFromColumnL = parseNumber(row[11]);
  if (Number.isFinite(costFromColumnL) && costFromColumnL > 0) return costFromColumnL;
  const value = row.map(parseNumber).find((number) => Number.isFinite(number) && number > 0 && number >= 100);
  return value || 0;
}

function findCollectionItemName(row, header) {
  const preferred = String(row[4] || "").trim();
  if (preferred && !normalizeItemCode(preferred) && !/סך|סה"כ/.test(preferred)) return preferred;
  const codeIndex = header.code >= 0 ? header.code : row.findIndex((cell) => normalizeItemCode(cell));
  const beforeCode = row.slice(0, Math.max(0, codeIndex)).reverse().find((cell) => {
    const text = String(cell || "").trim();
    return text && !normalizeItemCode(text) && !/^\d+(?:\.\d+)?$/.test(text);
  });
  return String(beforeCode || "").trim();
}

function normalizeItemCode(value) {
  const text = String(value || "").trim();
  const match = text.match(/(?:^|\s)(\d{1,2}(?:\.\d+)?)(?=\s|$|[^\d.])/);
  if (!match) return "";
  const numeric = Number(match[1]);
  if (!Number.isFinite(numeric)) return match[1];
  return String(Math.round(numeric * 1000) / 1000).replace(/\.0+$/, "");
}

function normalizeLooseText(value) {
  return String(value || "")
    .replace(/[״"׳']/g, "")
    .replace(/[^\p{L}\p{N}.]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function looseNameScore(sourceName, targetText) {
  const target = normalizeLooseText(targetText);
  return normalizeLooseText(sourceName)
    .split(" ")
    .filter((word) => word.length >= 3)
    .reduce((score, word) => score + (target.includes(word) ? 1 : 0), 0);
}

function decodeDataUrl(dataUrl) {
  const base64 = String(dataUrl).includes(",") ? String(dataUrl).split(",").pop() : dataUrl;
  return Buffer.from(base64 || "", "base64");
}

async function extractPdfText(buffer) {
  try {
    globalThis.DOMMatrix ||= class DOMMatrix {
      constructor() {
        this.a = 1; this.b = 0; this.c = 0; this.d = 1; this.e = 0; this.f = 0;
      }
      multiply() { return this; }
      translate() { return this; }
      scale() { return this; }
      rotate() { return this; }
      inverse() { return this; }
    };
    globalThis.ImageData ||= class ImageData {};
    globalThis.Path2D ||= class Path2D {};
    const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
    const doc = await pdfjs.getDocument({ data: new Uint8Array(buffer), disableWorker: true }).promise;
    const pages = [];
    for (let pageNumber = 1; pageNumber <= doc.numPages; pageNumber += 1) {
      const page = await doc.getPage(pageNumber);
      const content = await page.getTextContent();
      pages.push(groupPdfTextItemsIntoRows(content.items));
    }
    return pages.join("\n");
  } catch {
    return extractTextWithPython(buffer, ".pdf", `import fitz, sys\ndoc = fitz.open(sys.argv[1])\nprint("\\n".join(page.get_text("text") for page in doc))`);
  }
}

function groupPdfTextItemsIntoRows(items) {
  const rows = [];
  items.forEach((item) => {
    const text = String(item.str || "").trim();
    if (!text) return;
    const x = Number(item.transform?.[4] || 0);
    const y = Number(item.transform?.[5] || 0);
    let row = rows.find((entry) => Math.abs(entry.y - y) <= 3);
    if (!row) {
      row = { y, cells: [] };
      rows.push(row);
    }
    row.cells.push({ x, text });
  });
  return rows
    .sort((a, b) => b.y - a.y)
    .map((row) => row.cells
      .sort((a, b) => b.x - a.x)
      .map((cell) => cell.text)
      .join(" | "))
    .join("\n");
}

async function extractWorkbookText(buffer, ext) {
  try {
    return extractWorkbookTextFromXlsx(buffer);
  } catch {
    return extractTextWithPython(buffer, ext, `import openpyxl, sys\nwb = openpyxl.load_workbook(sys.argv[1], data_only=True)\nrows=[]\nfor ws in wb.worksheets:\n rows.append("SHEET " + ws.title)\n for row in ws.iter_rows(values_only=True):\n  values=[str(v) for v in row if v is not None]\n  if values: rows.append(" | ".join(values))\nprint("\\n".join(rows))`);
  }
}

function extractWorkbookTextFromXlsx(buffer) {
  const files = readZipEntries(buffer);
  const workbookXml = files.get("xl/workbook.xml")?.toString("utf8") || "";
  const relsXml = files.get("xl/_rels/workbook.xml.rels")?.toString("utf8") || "";
  const sharedStrings = parseSharedStrings(files.get("xl/sharedStrings.xml")?.toString("utf8") || "");
  const sheetNames = parseWorkbookSheets(workbookXml);
  const relTargets = parseWorkbookRels(relsXml);
  const rows = [];
  sheetNames.forEach((sheet, index) => {
    const target = relTargets.get(sheet.rid) || `worksheets/sheet${index + 1}.xml`;
    const sheetPath = `xl/${target.replace(/^\//, "").replace(/^xl\//, "")}`;
    const sheetXml = files.get(sheetPath)?.toString("utf8");
    if (!sheetXml) return;
    rows.push(`SHEET ${sheet.name}`);
    parseSheetRows(sheetXml, sharedStrings).forEach((row) => {
      if (row.length) rows.push(row.join(" | "));
    });
  });
  return rows.join("\n");
}

function readZipEntries(buffer) {
  const entries = new Map();
  let offset = 0;
  while (offset < buffer.length - 30) {
    if (buffer.readUInt32LE(offset) !== 0x04034b50) {
      offset += 1;
      continue;
    }
    const method = buffer.readUInt16LE(offset + 8);
    const compressedSize = buffer.readUInt32LE(offset + 18);
    const uncompressedSize = buffer.readUInt32LE(offset + 22);
    const nameLength = buffer.readUInt16LE(offset + 26);
    const extraLength = buffer.readUInt16LE(offset + 28);
    const name = buffer.slice(offset + 30, offset + 30 + nameLength).toString("utf8");
    const dataStart = offset + 30 + nameLength + extraLength;
    const dataEnd = dataStart + compressedSize;
    const compressed = buffer.slice(dataStart, dataEnd);
    let data = Buffer.alloc(0);
    if (method === 0) data = compressed;
    else if (method === 8) data = inflateRawSync(compressed);
    if (data.length || uncompressedSize === 0) entries.set(name, data);
    offset = dataEnd;
  }
  return entries;
}

function parseSharedStrings(xml) {
  return [...xml.matchAll(/<si[\s\S]*?<\/si>/g)].map((match) => {
    const text = [...match[0].matchAll(/<t[^>]*>([\s\S]*?)<\/t>/g)].map((part) => decodeXml(part[1])).join("");
    return text;
  });
}

function parseWorkbookSheets(xml) {
  return [...xml.matchAll(/<sheet\b[^>]*name="([^"]+)"[^>]*(?:r:id="([^"]+)")[^>]*\/?>/g)]
    .map((match) => ({ name: decodeXml(match[1]), rid: match[2] }));
}

function parseWorkbookRels(xml) {
  const rels = new Map();
  [...xml.matchAll(/<Relationship\b[^>]*Id="([^"]+)"[^>]*Target="([^"]+)"[^>]*\/?>/g)]
    .forEach((match) => rels.set(match[1], match[2]));
  return rels;
}

function parseSheetRows(xml, sharedStrings) {
  return [...xml.matchAll(/<row\b[\s\S]*?<\/row>/g)].map((rowMatch) => {
    const values = [];
    [...rowMatch[0].matchAll(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)].forEach((cellMatch) => {
      const attrs = cellMatch[1];
      const body = cellMatch[2] || "";
      const rawValue = body.match(/<v>([\s\S]*?)<\/v>/)?.[1] || body.match(/<t[^>]*>([\s\S]*?)<\/t>/)?.[1] || "";
      const type = attrs.match(/\bt="([^"]+)"/)?.[1] || "";
      let value = decodeXml(rawValue);
      if (type === "s") value = sharedStrings[Number(value)] || "";
      if (value !== "") values.push(value);
    });
    return values;
  });
}

function decodeXml(value) {
  return String(value || "")
    .replace(/&quot;/g, "\"")
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");
}

async function extractTextWithPython(buffer, ext, script) {
  const tempRoot = globalThis.process?.env?.BUDGET_TMP_DIR || path.join(__dirname, ".tmp");
  await mkdir(tempRoot, { recursive: true });
  const dir = await mkdtemp(path.join(tempRoot, "budget-order-"));
  const file = path.join(dir, `upload${ext}`);
  await writeFile(file, buffer);
  try {
    return await new Promise((resolve, reject) => {
      execFile("py", ["-c", script, file], { maxBuffer: 20 * 1024 * 1024 }, (error, stdout, stderr) => {
        if (error) reject(new Error(stderr || error.message));
        else resolve(stdout);
      });
    });
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

function parseOrderText(text, fileName, expectedOrderNumber = "") {
  const normalized = String(text || "").replace(/\r/g, "\n");
  const scopedText = isolateOrderBlock(normalized, expectedOrderNumber) || normalized;
  const orderNumber = expectedOrderNumber || findFirstMatch(scopedText, [
    /(?:מספר\s+הזמנה|הזמנת\s+רכש\s+מספר|הזמנה)\D{0,20}(\d{10}|\d{2}-\d{3})/,
    /\b(\d{2}-\d{3})\b/,
    /\b(45\d{8})\b/
  ]) || findFirstMatch(fileName, [/\b(\d{2}-\d{3})\b/, /\b(45\d{8})\b/]);
  return {
    orderNumber: orderNumber || "",
    regulationNumber: detectOrderRegulationNumber(scopedText, fileName) || detectOrderRegulationNumber(normalized, fileName),
    projectName: guessProjectName(scopedText, fileName),
    customerUnit: findFirstMatch(scopedText, [/(?:יחידה\s+מזמינה|אגף|מינהל)\s*[:\-]?\s*([^\n|]{2,80})/]) || "",
    issuedAt: normalizeDate(findFirstMatch(scopedText, [/(?:תאריך\s+הזמנה|תאריך)\D{0,12}(\d{1,2}[./-]\d{1,2}[./-]\d{2,4})/])),
    expectedEndAt: "",
    lines: parseOrderLines(scopedText)
  };
}

function detectOrderRegulationNumber(text, fileName = "") {
  const source = `${String(text || "")}\n${String(fileName || "")}`;
  const fullNumber = source.match(/206701\s*(92|46|27|73)\b/);
  if (fullNumber?.[1]) return fullNumber[1];
  const labelledNumber = source.match(/תקנה[^\d]{0,16}(92|46|27|73)\b/);
  if (labelledNumber?.[1]) return labelledNumber[1];
  if (/(?:STEM|סטם)/i.test(source)) return "27";
  return "";
}

function isolateOrderBlock(text, orderNumber) {
  if (!orderNumber) return "";
  const rows = String(text || "").split("\n");
  const candidates = [];
  rows.forEach((row, rowIndex) => {
    if (!row.includes(orderNumber)) return;
    const block = [row];
    for (let index = rowIndex + 1; index < rows.length; index += 1) {
      const nextRow = rows[index];
      if (/^SHEET\s+/.test(nextRow)) break;
      const hasNextOrderNumber = nextRow.split("|").some((cell) => /^\s*\d{2}-\d{3}\s*$/.test(cell));
      if (hasNextOrderNumber) break;
      block.push(nextRow);
    }
    const score = block.reduce((sum, entry) => {
      const firstCell = entry.split("|")[0]?.trim() || "";
      return sum + (/^\d{1,2}(?:\.\d+)?$/.test(firstCell) ? 2 : 0) + (entry.includes("סעיף") ? 1 : 0);
    }, 0);
    candidates.push({ block, score });
  });
  candidates.sort((a, b) => b.score - a.score);
  return candidates[0]?.score > 0 ? candidates[0].block.join("\n") : "";
}

function parseOrderLines(text) {
  const lines = [];
  const seen = new Set();
  for (const line of parseDelimitedOrderLines(text)) {
    const key = `${line.code}-${line.quantity}-${line.unitCost}`;
    if (!seen.has(key)) {
      seen.add(key);
      lines.push(line);
    }
  }
  const rowPattern = /(^|\n)\s*(\d{1,2}(?:\.\d+)?)\s+(.{2,120}?)\s+(\d+(?:[,.]\d+)?)\s+(\d{1,3}(?:,\d{3})*(?:\.\d+)?|\d+(?:\.\d+)?)\s*(?:₪|ש"ח|NIS)?/g;
  let match;
  while ((match = rowPattern.exec(text)) !== null) {
    const code = match[2];
    const name = cleanOrderItemName(match[3]) || knownTenderItemName(code);
    const quantity = parseNumber(match[4]);
    const unitCost = parseNumber(match[5]);
    const key = `${code}-${quantity}-${unitCost}`;
    if (!seen.has(key) && quantity > 0 && unitCost > 0) {
      seen.add(key);
      lines.push({ code, name, quantity: normalizeKnownOrderQuantity(code, quantity, unitCost), unitCost });
    }
  }
  return lines;
}

function parseDelimitedOrderLines(text) {
  return String(text || "")
    .split("\n")
    .map((row) => row.split("|").map((cell) => cell.trim()).filter(Boolean))
    .filter((cells) => /^\d{1,2}(?:\.\d+)?$/.test(cells[0] || ""))
    .map((cells) => {
      const code = cells[0];
      const name = cleanOrderItemName(cells.slice(1).find((cell) => {
        const text = String(cell || "").trim();
        return isLikelyOrderItemName(text);
      }) || "") || knownTenderItemName(code);
      const numeric = cells.slice(1).map(parseNumber).filter((value) => Number.isFinite(value) && value > 0);
      if (numeric.length < 2) return null;
      let quantity;
      let unitCost;
      if (numeric.length >= 3 && Math.abs((numeric[0] * numeric[1]) - numeric[2]) <= Math.max(1, numeric[2] * 0.03)) {
        quantity = numeric[0];
        unitCost = numeric[1];
      } else if (numeric.length >= 3) {
        quantity = numeric[numeric.length - 2];
        unitCost = numeric[numeric.length - 3];
      } else if (numeric[1] > numeric[0] * 10) {
        quantity = numeric[0];
        unitCost = numeric[1] / numeric[0];
      } else {
        quantity = numeric[1];
        unitCost = numeric[0];
      }
      return { code, name, quantity: normalizeKnownOrderQuantity(code, quantity, unitCost), unitCost };
    })
    .filter(Boolean);
}

function cleanOrderItemName(value) {
  const text = String(value || "")
    .replace(/\s+/g, " ")
    .replace(/^(?:סעיף|פריט|שם פריט)\s*[:\-]?\s*/i, "")
    .trim();
  return isLikelyOrderItemName(text) ? text : "";
}

function knownTenderItemName(code) {
  const knownItems = {
    "2": "אחזקת מערכת",
    "15.3": "הפעלת משדר מאולפן וידאו (מורכבת)"
  };
  return knownItems[String(code || "").trim()] || "";
}

function normalizeOrderLineInput(line) {
  const code = String(line.code || "");
  const result = {
    code,
    name: cleanOrderItemName(line.name || line.inferredItemName || "") || knownTenderItemName(code),
    quantity: Number(line.quantity || 0),
    unitCost: Number(line.unitCost || 0)
  };
  const utilizedQuantity = Number(line.utilizedQuantity ?? line.collectedQuantity);
  if (Number.isFinite(utilizedQuantity)) {
    result.utilizedQuantity = utilizedQuantity;
  }
  return result;
}

function canonicalizeOrderLinesForRegulation(lines, regulation) {
  const itemByCode = new Map((regulation?.items || []).map((item) => [String(item.code), item]));
  return (lines || []).map((line) => {
    const normalized = normalizeOrderLineInput(line);
    const item = itemByCode.get(String(normalized.code));
    if (!item) return normalized;
    return {
      ...normalized,
      name: item.name || normalized.name,
      unitCost: Number(item.unitCost || normalized.unitCost || 0)
    };
  });
}

function normalizeKnownOrderQuantity(code, quantity, unitCost) {
  if (String(code || "").trim() === "2" && Math.abs(Number(unitCost) - 25300) <= 1 && Math.abs(Number(quantity) - 0.04) <= 0.005) {
    return 973 / 25300;
  }
  return quantity;
}

function isLikelyOrderItemName(value) {
  const text = String(value || "").trim();
  const hebrewLetters = (text.match(/[א-ת]/g) || []).length;
  return text
    && hebrewLetters >= 3
    && !["רכיב", "פריט"].includes(text)
    && !/^שם\b/.test(text)
    && !/קובץ|רכובץ/.test(text)
    && !Number.isFinite(parseNumber(text))
    && !normalizeItemCode(text)
    && !/סעיף|כמות|עלות|סכום|מע"?מ|סה"?כ|מחיר|יחידה/.test(text);
}

function findFirstMatch(value, patterns) {
  for (const pattern of patterns) {
    const match = String(value || "").match(pattern);
    if (match?.[1]) return match[1].trim();
  }
  return "";
}

function guessProjectName(text, fileName) {
  return findFirstMatch(text, [/(?:שם\s+פרויקט|תיאור)\s*[:\-]?\s*([^\n|]{4,100})/])
    || path.basename(fileName || "", path.extname(fileName || "")).replace(/[_-]+/g, " ").trim();
}

function normalizeDate(value) {
  if (!value) return "";
  const parts = value.split(/[./-]/).map(Number);
  if (parts.length !== 3) return "";
  const [day, month, rawYear] = parts;
  const year = rawYear < 100 ? 2000 + rawYear : rawYear;
  return `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

function parseNumber(value) {
  return Number(String(value || "").replace(/,/g, ""));
}

function findFramework(data, id) {
  return data.frameworks.find((framework) => framework.id === id);
}

function findRegulation(framework, id) {
  return framework?.regulations.find((regulation) => regulation.id === id || regulation.number === id);
}

function enrichOrder(order, regulation, framework = null) {
  const itemMap = new Map(regulation.items.map((item) => [item.code, item]));
  const lines = order.lines.map((line) => {
    const approved = itemMap.get(line.code) || findFrameworkItemByCode(framework, line.code);
    const collectedQuantity = order.collections
      .filter((collection) => collection.status === "approved")
      .flatMap((collection) => collection.lineCollections)
      .filter((entry) => entry.code === line.code)
      .reduce((sum, entry) => sum + entry.quantity, 0);
    const unitCost = line.unitCost || approved?.unitCost || 0;
    return {
      ...line,
      name: approved?.name || line.name || line.inferredItemName || knownTenderItemName(line.code) || "שם חסר בקובץ",
      unitCost,
      orderedAmount: money(line.quantity * unitCost),
      collectedQuantity,
      remainingQuantity: line.quantity - collectedQuantity,
      collectedAmount: money(collectedQuantity * unitCost),
      remainingAmount: money((line.quantity - collectedQuantity) * unitCost),
      missingFromFramework: !approved
    };
  });
  const reserved = orderReservedAmount({ ...order, lines });
  const collected = collectOrderAmount({ ...order, lines });
  return {
    ...order,
    lines,
    summary: {
      reserved: money(reserved),
      collected: money(collected),
      remainingToCollect: money(reserved - collected),
      canSuggestClose: order.status !== "closed" && reserved > 0 && reserved - collected <= 0
    }
  };
}

function findFrameworkItemByCode(framework, code) {
  if (!framework) return null;
  return framework.regulations
    .flatMap((regulation) => regulation.items || [])
    .find((item) => item.code === code) || null;
}

async function parseJsonBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const raw = Buffer.concat(chunks).toString("utf8");
  return raw ? JSON.parse(raw) : {};
}

async function handleApi(req, res, url) {
  const data = await readData();
  const parts = url.pathname.split("/").filter(Boolean);

  if (req.method === "GET" && url.pathname === "/api/state") {
    return json(res, {
      vatRate: data.vatRate,
      defaultFrameworkId: data.defaultFrameworkId,
      frameworks: data.frameworks.map(summarizeFramework),
      monthlyCases: data.monthlyCases,
      users: data.users
    });
  }

  if (req.method === "GET" && url.pathname === "/api/storage") {
    return json(res, getStorageStatus());
  }

  if (req.method === "PATCH" && parts[1] === "frameworks" && parts[3] === "default") {
    const framework = findFramework(data, parts[2]);
    if (!framework) return notFound(res);
    data.defaultFrameworkId = framework.id;
    await saveData(data);
    return json(res, { ok: true });
  }

  if (req.method === "POST" && url.pathname === "/api/extract-order") {
    const body = await parseJsonBody(req);
    const result = await extractOrderFromUpload(body);
    return json(res, result, result.ok ? 200 : 422);
  }

  if (req.method === "POST" && url.pathname === "/api/extract-framework-update") {
    const body = await parseJsonBody(req);
    const result = extractFrameworkUpdateFromUpload(data, body);
    return json(res, result, result.ok ? 200 : 422);
  }

  if (req.method === "POST" && url.pathname === "/api/apply-framework-update") {
    const body = await parseJsonBody(req);
    const result = await applyFrameworkItemsUpdate(data, body);
    return json(res, result, result.ok ? 200 : result.status || 422);
  }

  if (req.method === "POST" && url.pathname === "/api/extract-cumulative-execution") {
    const body = await parseJsonBody(req);
    const result = extractCumulativeExecutionFromUpload(data, body);
    return json(res, result, result.ok ? 200 : 422);
  }

  if (req.method === "POST" && url.pathname === "/api/apply-cumulative-execution") {
    const body = await parseJsonBody(req);
    const result = await applyCumulativeExecutionUpdate(data, body);
    return json(res, result, result.ok ? 200 : result.status || 422);
  }

  if (req.method === "POST" && url.pathname === "/api/exports") {
    const body = await parseJsonBody(req);
    const fileName = safeExportFileName(body.fileName || `export-${Date.now()}.csv`);
    const content = String(body.content || "");
    if (!content.trim()) return badRequest(res, "No export content");
    await mkdir(OUTPUTS_DIR, { recursive: true });
    const filePath = path.join(OUTPUTS_DIR, fileName);
    await writeFile(filePath, content, "utf8");
    return json(res, { ok: true, fileName, filePath });
  }

  if (req.method === "POST" && url.pathname === "/api/frameworks") {
    const body = await parseJsonBody(req);
    const id = `fw-${Date.now()}`;
    const framework = {
      id,
      year: body.year || "שנה חדשה",
      title: body.title || "הזמנת מסגרת חדשה",
      orderNumber: body.orderNumber || "",
      isDefault: false,
      activeVersionId: `${id}-v1`,
      versions: [{ id: `${id}-v1`, label: "גרסה ראשונה", sourceFile: body.sourceFile || "", approvedAt: body.approvedAt || "", createdAt: new Date().toISOString() }],
      regulations: [
        { id: `${id}-reg-92`, number: "92", name: "תקנה 20670192", description: "מינהל חדשנות וטכנולוגיה", items: [], projectOrders: [] },
        { id: `${id}-reg-46`, number: "46", name: "תקנה 20670146", description: "מזכירות פדגוגית / מזה״פ", items: [], projectOrders: [] },
        { id: `${id}-reg-27`, number: "27", name: "תקנה 20670127", description: "ישראל ריאלית ו-STEM", items: [], projectOrders: [] },
        { id: `${id}-reg-73`, number: "73", name: "תקנה 20670173", description: "בינה מלאכותית", items: [], projectOrders: [] }
      ]
    };
    data.frameworks.push(framework);
    await saveData(data);
    return json(res, { ok: true, framework });
  }

  if (req.method === "POST" && parts[1] === "frameworks" && parts[3] === "versions") {
    const framework = findFramework(data, parts[2]);
    if (!framework) return notFound(res);
    const body = await parseJsonBody(req);
    const version = { id: `${framework.id}-v${framework.versions.length + 1}`, label: body.label || `גרסה ${framework.versions.length + 1}`, sourceFile: body.sourceFile || "", approvedAt: body.approvedAt || "", createdAt: new Date().toISOString() };
    framework.versions.push(version);
    framework.activeVersionId = version.id;
    await saveData(data);
    return json(res, { ok: true, version });
  }

  if (req.method === "GET" && parts[1] === "frameworks" && parts[3] === "regulations" && parts.length === 5) {
    const framework = findFramework(data, parts[2]);
    const regulation = findRegulation(framework, parts[4]);
    if (!regulation) return notFound(res);
    return json(res, {
      ...regulation,
      summary: summarizeRegulation(regulation),
      lowStockItems: getLowStockItems(regulation),
      projectOrders: regulation.projectOrders.map((order) => enrichOrder(order, regulation, framework))
    });
  }

  if (req.method === "POST" && parts[1] === "frameworks" && parts[3] === "regulations" && parts[5] === "orders") {
    const framework = findFramework(data, parts[2]);
    const regulation = findRegulation(framework, parts[4]);
    if (!regulation) return notFound(res);
    const body = await parseJsonBody(req);
    const order = {
      id: `po-${Date.now()}`,
      orderNumber: body.orderNumber || "",
      projectName: body.projectName || "פרויקט חדש",
      customerUnit: body.customerUnit || "",
      issuedAt: body.issuedAt || "",
      expectedEndAt: body.expectedEndAt || "",
      status: "active",
      sourceFile: body.sourceFile || "",
      closeReason: "",
      lines: canonicalizeOrderLinesForRegulation(body.lines || [], regulation),
      collections: []
    };
    regulation.projectOrders.push(order);
    await saveData(data);
    return json(res, { ok: true, order: enrichOrder(order, regulation, framework), lowStockItems: getLowStockItems(regulation) });
  }

  if (req.method === "PATCH" && parts[1] === "orders" && parts.length === 3) {
    const body = await parseJsonBody(req);
    for (const framework of data.frameworks) {
      for (const regulation of framework.regulations) {
        const order = regulation.projectOrders.find((entry) => entry.id === parts[2]);
        if (order) {
          order.orderNumber = body.orderNumber || order.orderNumber;
          order.projectName = body.projectName || order.projectName;
          order.customerUnit = body.customerUnit || "";
          order.issuedAt = body.issuedAt || "";
          order.expectedEndAt = body.expectedEndAt || "";
          order.sourceFile = body.sourceFile || order.sourceFile || "";
          order.lines = canonicalizeOrderLinesForRegulation(body.lines || [], regulation);
          order.totalWithoutVat = Number.isFinite(Number(body.totalWithoutVat))
            ? Number(body.totalWithoutVat)
            : order.lines.reduce((sum, line) => sum + line.quantity * line.unitCost, 0);
          await saveData(data);
          return json(res, { ok: true, order: enrichOrder(order, regulation, framework), regulation: { id: regulation.id } });
        }
      }
    }
    return notFound(res);
  }

  if (req.method === "DELETE" && parts[1] === "orders" && parts.length === 3) {
    for (const framework of data.frameworks) {
      for (const regulation of framework.regulations) {
        const orderIndex = regulation.projectOrders.findIndex((entry) => entry.id === parts[2]);
        if (orderIndex >= 0) {
          const [order] = regulation.projectOrders.splice(orderIndex, 1);
          await saveData(data);
          return json(res, { ok: true, deletedOrderId: order.id, regulationId: regulation.id });
        }
      }
    }
    return notFound(res);
  }

  if (req.method === "PATCH" && parts[1] === "orders" && parts[3] === "close") {
    const body = await parseJsonBody(req);
    for (const framework of data.frameworks) {
      for (const regulation of framework.regulations) {
        const order = regulation.projectOrders.find((entry) => entry.id === parts[2]);
        if (order) {
          order.status = "closed";
          order.closeReason = body.reason || "נסגר ידנית";
          await saveData(data);
          return json(res, { ok: true, order: enrichOrder(order, regulation, framework) });
        }
      }
    }
    return notFound(res);
  }
  if (req.method === "POST" && url.pathname === "/api/monthly-cases") {
    const body = await parseJsonBody(req);
    const monthlyCase = {
      id: `case-${Date.now()}`,
      frameworkId: body.frameworkId || data.defaultFrameworkId,
      month: body.month || "",
      title: body.title || "תיק גביה חדש",
      status: "prepare-reports",
      indexationAmount: Number(body.indexationAmount || 0),
      invoice: null,
      projectIds: body.projectIds || [],
      evidenceFiles: []
    };
    data.monthlyCases.push(monthlyCase);
    await saveData(data);
    return json(res, { ok: true, monthlyCase });
  }

  if (req.method === "POST" && parts[1] === "monthly-cases" && parts[3] === "documents") {
    const body = await parseJsonBody(req);
    const result = await applyCollectionDocument(data, parts[2], body);
    return json(res, result, result.ok ? 200 : (result.status || 422));
  }

  if (req.method === "GET" && parts[1] === "monthly-cases" && parts[3] === "documents" && parts[5] === "file") {
    return serveMonthlyCaseDocument(data, res, parts[2], parts[4]);
  }

  if (req.method === "PATCH" && parts[1] === "monthly-cases" && parts[3] === "documents" && parts[4]) {
    const body = await parseJsonBody(req);
    const monthlyCase = data.monthlyCases.find((entry) => entry.id === parts[2]);
    const document = monthlyCase?.evidenceFiles?.find((entry) => entry.id === parts[4]);
    if (!document) return notFound(res);
    document.type = normalizeDocumentType(body.documentType || document.type);
    await saveData(data);
    return json(res, { ok: true, document });
  }

  if (req.method === "PATCH" && parts[1] === "monthly-cases" && parts[2]) {
    const body = await parseJsonBody(req);
    const monthlyCase = data.monthlyCases.find((entry) => entry.id === parts[2]);
    if (!monthlyCase) return notFound(res);
    monthlyCase.month = body.month || monthlyCase.month;
    monthlyCase.title = body.title || monthlyCase.title;
    monthlyCase.status = normalizeMonthlyStatus(body.status || monthlyCase.status);
    monthlyCase.indexationAmount = Number(body.indexationAmount || 0);
    await saveData(data);
    return json(res, { ok: true, monthlyCase });
  }

  if (req.method === "POST" && url.pathname === "/api/users") {
    const body = await parseJsonBody(req);
    const id = body.id || `u-${Date.now()}`;
    const existing = data.users.find((user) => user.id === id);
    const user = {
      id,
      name: body.name || "",
      email: body.email || "",
      role: body.role === "viewer" ? "viewer" : "admin",
      passwordSet: Boolean(body.password || existing?.passwordSet)
    };
    if (existing) Object.assign(existing, user);
    else data.users.push(user);
    await saveData(data);
    return json(res, { ok: true, user });
  }

  if (req.method === "DELETE" && parts[1] === "users" && parts[2]) {
    data.users = data.users.filter((user) => user.id !== parts[2]);
    await saveData(data);
    return json(res, { ok: true });
  }

  return notFound(res);
}

function json(res, payload, status = 200) {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(payload));
}

function notFound(res) {
  json(res, { error: "Not found" }, 404);
}

function badRequest(res, message) {
  json(res, { error: message }, 400);
}

function normalizeMonthlyStatus(status) {
  const aliases = {
    "expectation-alignment": "prepare-reports",
    "draft-reports": "prepare-reports",
    "internal-approved": "client-final-approved",
    "invoice-uploaded": "invoice-issued",
    "service-accepted": "client-final-approved",
    "merkava-uploaded": "invoice-uploaded-to-merkava"
  };
  return aliases[status] || status || "prepare-reports";
}

function safeExportFileName(fileName) {
  const cleaned = String(fileName)
    .replace(/[<>:"/\\|?*\u0000-\u001F]/g, "-")
    .replace(/\s+/g, " ")
    .trim();
  return cleaned.endsWith(".csv") ? cleaned : `${cleaned || "export"}.csv`;
}

async function serveStatic(req, res, url) {
  const requested = url.pathname === "/" ? "/index.html" : decodeURIComponent(url.pathname);
  const filePath = path.normalize(path.join(PUBLIC_DIR, requested));
  if (!filePath.startsWith(PUBLIC_DIR)) return badRequest(res, "Invalid path");
  try {
    await stat(filePath);
    const ext = path.extname(filePath);
    res.writeHead(200, { "Content-Type": contentTypes[ext] || "application/octet-stream" });
    const stream = createReadStream(filePath);
    stream.on("error", () => notFound(res));
    stream.pipe(res);
  } catch {
    notFound(res);
  }
}

async function serveMonthlyCaseDocument(data, res, caseId, documentId) {
  const monthlyCase = data.monthlyCases.find((entry) => entry.id === caseId);
  const document = monthlyCase?.evidenceFiles?.find((entry) => entry.id === documentId);
  if (!document?.storedName) return notFound(res);
  const caseUploadDir = path.join(UPLOADS_DIR, caseId);
  const filePath = path.normalize(path.join(caseUploadDir, document.storedName));
  if (!filePath.startsWith(caseUploadDir)) return badRequest(res, "Invalid path");
  try {
    await stat(filePath);
    const ext = path.extname(document.name || document.storedName).toLowerCase();
    const viewableInline = [".pdf", ".png", ".jpg", ".jpeg", ".gif", ".webp"].includes(ext);
    const disposition = viewableInline ? "inline" : "attachment";
    res.writeHead(200, {
      "Content-Type": contentTypes[ext] || "application/octet-stream",
      "Content-Disposition": `${disposition}; filename*=UTF-8''${encodeURIComponent(document.name || document.storedName)}`
    });
    const stream = createReadStream(filePath);
    stream.on("error", () => notFound(res));
    stream.pipe(res);
  } catch {
    notFound(res);
  }
}

await initializeStorage({ dataDir: DATA_DIR, dbFile: DB_FILE, normalizeData, seedData });

http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host}`);
    if (url.pathname.startsWith("/api/")) {
      await handleApi(req, res, url);
    } else {
      await serveStatic(req, res, url);
    }
  } catch (error) {
    console.error(error);
    json(res, { error: error.message || "Server error" }, 500);
  }
}).listen(PORT, () => {
  console.log(`Budget manager is running at http://localhost:${PORT}`);
});




