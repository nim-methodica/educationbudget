import fs from "node:fs/promises";
import path from "node:path";
import { SpreadsheetFile, Workbook } from "@oai/artifact-tool";

const VAT_RATE = 0.18;
const data = JSON.parse(await fs.readFile("data/app-data.json", "utf8"));
const framework = data.frameworks.find((entry) => entry.id === "fw-2026") || data.frameworks[0];
const outputDir = path.resolve("outputs");
const outputPath = path.join(outputDir, "בקרת-הזמנות-ושורות.xlsx");

function money(amount) {
  return Math.round(Number(amount || 0) * 100) / 100;
}

function withVat(amount) {
  return money(amount * (1 + VAT_RATE));
}

function isSummaryLine(line) {
  const code = String(line?.code || "").trim();
  const name = String(line?.name || "").trim();
  return code === "סיכום" || code.includes("×¡") || name.includes("סכום הזמנת פרויקט");
}

function statusFor(row) {
  if (row.summaryOnly) return "דורש פירוט";
  if (row.lineCount === 0) return "ללא שורות";
  if (row.missingItems) return "ממתין לעדכון פריטי מסגרת";
  if (Math.abs(row.diff) > 1) return "פער סכום";
  return "תקין";
}

const orderRows = [];
const lineRows = [];

for (const regulation of framework.regulations) {
  const itemByCode = new Map((regulation.items || []).map((item) => [String(item.code), item]));
  for (const order of regulation.projectOrders || []) {
    const lines = order.lines || [];
    const lineTotal = money(lines.reduce((sum, line) => sum + Number(line.quantity || 0) * Number(line.unitCost || 0), 0));
    const orderTotal = money(Number.isFinite(order.totalWithoutVat) ? order.totalWithoutVat : lineTotal);
    const paid = money(Number.isFinite(order.paidWithoutVatTotal)
      ? order.paidWithoutVatTotal
      : Number.isFinite(order.paidWithVatTotal)
        ? order.paidWithVatTotal / (1 + VAT_RATE)
        : 0);
    const missingCodes = [...new Set(lines
      .filter((line) => !isSummaryLine(line) && !itemByCode.has(String(line.code)))
      .map((line) => String(line.code)))];
    const summaryOnly = lines.length === 1 && isSummaryLine(lines[0]);
    const row = {
      regulation: regulation.number,
      regulationName: regulation.name,
      orderNumber: order.orderNumber,
      projectName: order.projectName,
      status: order.status === "closed" ? "סגורה" : "פעילה",
      lineCount: lines.length,
      summaryOnly,
      missingItems: missingCodes.length,
      missingCodes: missingCodes.join(", "),
      orderTotal,
      orderTotalVat: withVat(orderTotal),
      lineTotal,
      lineTotalVat: withVat(lineTotal),
      diff: money(lineTotal - orderTotal),
      paid,
      paidVat: withVat(paid),
      remaining: money(orderTotal - paid),
      remainingVat: withVat(orderTotal - paid),
      sourceFile: order.sourceFile || ""
    };
    row.auditStatus = statusFor(row);
    orderRows.push(row);

    lines.forEach((line) => {
      const item = itemByCode.get(String(line.code));
      const amount = money(Number(line.quantity || 0) * Number(line.unitCost || 0));
      lineRows.push({
        regulation: regulation.number,
        orderNumber: order.orderNumber,
        projectName: order.projectName,
        code: String(line.code || ""),
        itemName: item?.name || line.name || "",
        quantity: Number(line.quantity || 0),
        unitCost: Number(line.unitCost || 0),
        unitCostVat: withVat(Number(line.unitCost || 0)),
        amount,
        amountVat: withVat(amount),
        missing: !isSummaryLine(line) && !item,
        summaryLine: isSummaryLine(line)
      });
    });
  }
}

orderRows.sort((a, b) => String(a.orderNumber).localeCompare(String(b.orderNumber), "he"));
lineRows.sort((a, b) => String(a.orderNumber).localeCompare(String(b.orderNumber), "he") || String(a.code).localeCompare(String(b.code), "he", { numeric: true }));

const byRegulation = [...new Map(framework.regulations.map((reg) => [reg.number, reg])).values()].map((regulation) => {
  const rows = orderRows.filter((row) => row.regulation === regulation.number);
  const frameworkWithoutVat = money(regulation.summary?.framework?.withoutVat || (regulation.items || []).reduce((sum, item) => sum + Number(item.unitCost || 0) * Number(item.approvedQuantity || 0), 0));
  const reserved = money(rows.reduce((sum, row) => sum + row.orderTotal, 0));
  const paid = money(rows.reduce((sum, row) => sum + row.paid, 0));
  return {
    regulation: regulation.number,
    name: regulation.name,
    frameworkWithoutVat,
    frameworkWithVat: withVat(frameworkWithoutVat),
    reservedWithoutVat: reserved,
    reservedWithVat: withVat(reserved),
    paidWithoutVat: paid,
    paidWithVat: withVat(paid),
    remainingWithoutVat: money(frameworkWithoutVat - paid),
    remainingWithVat: withVat(frameworkWithoutVat - paid),
    orderCount: rows.length,
    detailedOrders: rows.filter((row) => row.auditStatus === "תקין").length,
    issueCount: rows.filter((row) => row.auditStatus !== "תקין").length
  };
});

const wb = Workbook.create();
const summary = wb.worksheets.add("סיכום");
const orders = wb.worksheets.add("בקרת הזמנות");
const lines = wb.worksheets.add("שורות הזמנה");

function writeSheet(sheet, title, headers, rows) {
  sheet.showGridLines = false;
  sheet.getRangeByIndexes(0, 0, 1, headers.length).merge();
  sheet.getRangeByIndexes(0, 0, 1, headers.length).values = [[title]];
  sheet.getRangeByIndexes(0, 0, 1, headers.length).format = {
    fill: "#0F766E",
    font: { bold: true, color: "#FFFFFF", size: 16 },
    horizontalAlignment: "Right"
  };
  sheet.getRangeByIndexes(2, 0, 1, headers.length).values = [headers.map((entry) => entry.label)];
  sheet.getRangeByIndexes(2, 0, 1, headers.length).format = {
    fill: "#E6F2EF",
    font: { bold: true, color: "#12332E" },
    horizontalAlignment: "Right",
    wrapText: true
  };
  if (rows.length) {
    sheet.getRangeByIndexes(3, 0, rows.length, headers.length).values = rows.map((row) => headers.map((entry) => row[entry.key]));
  }
  const used = sheet.getRangeByIndexes(2, 0, Math.max(rows.length + 1, 2), headers.length);
  used.format = { horizontalAlignment: "Right", verticalAlignment: "Top", wrapText: true };
  headers.forEach((header, index) => {
    sheet.getRangeByIndexes(0, index, Math.max(rows.length + 4, 6), 1).format.columnWidthPx = header.width || 120;
  });
  sheet.freezePanes.freezeRows(3);
}

writeSheet(summary, `בקרת תקנות - ${framework.orderNumber} · ${framework.title}`, [
  { key: "regulation", label: "תקנה", width: 80 },
  { key: "name", label: "שם תקנה", width: 180 },
  { key: "frameworkWithoutVat", label: "מסגרת ללא מע״מ", width: 130 },
  { key: "frameworkWithVat", label: "מסגרת כולל מע״מ", width: 130 },
  { key: "reservedWithoutVat", label: "ניצול ללא מע״מ", width: 130 },
  { key: "reservedWithVat", label: "ניצול כולל מע״מ", width: 130 },
  { key: "paidWithoutVat", label: "שולם ללא מע״מ", width: 130 },
  { key: "paidWithVat", label: "שולם כולל מע״מ", width: 130 },
  { key: "remainingWithoutVat", label: "נותר לגבות ללא מע״מ", width: 150 },
  { key: "remainingWithVat", label: "נותר לגבות כולל מע״מ", width: 150 },
  { key: "orderCount", label: "מס׳ הזמנות", width: 95 },
  { key: "detailedOrders", label: "הזמנות תקינות", width: 110 },
  { key: "issueCount", label: "דורשות בדיקה", width: 110 }
], byRegulation);

writeSheet(orders, "בקרת הזמנות", [
  { key: "orderNumber", label: "הזמנה", width: 90 },
  { key: "regulation", label: "תקנה", width: 70 },
  { key: "projectName", label: "שם פרויקט", width: 310 },
  { key: "status", label: "סטטוס", width: 80 },
  { key: "auditStatus", label: "בדיקה", width: 120 },
  { key: "lineCount", label: "שורות", width: 70 },
  { key: "orderTotal", label: "סכום הזמנה ללא מע״מ", width: 140 },
  { key: "orderTotalVat", label: "סכום הזמנה כולל מע״מ", width: 140 },
  { key: "lineTotal", label: "סכום שורות ללא מע״מ", width: 140 },
  { key: "lineTotalVat", label: "סכום שורות כולל מע״מ", width: 140 },
  { key: "diff", label: "פער ללא מע״מ", width: 110 },
  { key: "paid", label: "שולם ללא מע״מ", width: 120 },
  { key: "paidVat", label: "שולם כולל מע״מ", width: 120 },
  { key: "remaining", label: "יתרה ללא מע״מ", width: 120 },
  { key: "remainingVat", label: "יתרה כולל מע״מ", width: 120 },
  { key: "missingCodes", label: "סעיפים חסרים", width: 130 },
  { key: "sourceFile", label: "קובץ מקור", width: 240 }
], orderRows);

writeSheet(lines, "שורות הזמנה", [
  { key: "orderNumber", label: "הזמנה", width: 90 },
  { key: "regulation", label: "תקנה", width: 70 },
  { key: "projectName", label: "שם פרויקט", width: 300 },
  { key: "code", label: "סעיף", width: 80 },
  { key: "itemName", label: "שם פריט", width: 280 },
  { key: "quantity", label: "כמות", width: 90 },
  { key: "unitCost", label: "עלות יחידה ללא מע״מ", width: 140 },
  { key: "unitCostVat", label: "עלות יחידה כולל מע״מ", width: 140 },
  { key: "amount", label: "סכום ללא מע״מ", width: 130 },
  { key: "amountVat", label: "סכום כולל מע״מ", width: 130 },
  { key: "missing", label: "ממתין לעדכון מסגרת", width: 130 },
  { key: "summaryLine", label: "שורת סיכום", width: 100 }
], lineRows);

for (const sheet of [summary, orders, lines]) {
  const used = sheet.getUsedRange();
  used.format.font = { name: "Assistant" };
}

await fs.mkdir(outputDir, { recursive: true });
try {
  const preview = await wb.render({ sheetName: "בקרת הזמנות", autoCrop: "all", scale: 1, format: "png" });
  await fs.writeFile(path.join(outputDir, "בקרת-הזמנות-ושורות-preview.png"), new Uint8Array(await preview.arrayBuffer()));
} catch {
  // Preview rendering is optional; the workbook export below is the deliverable.
}

const exported = await SpreadsheetFile.exportXlsx(wb);
await exported.save(outputPath);

const issues = orderRows.filter((row) => row.auditStatus !== "תקין");
await fs.writeFile(path.join(outputDir, "audit-orders-summary.json"), JSON.stringify({ byRegulation, issueCount: issues.length, issues }, null, 2), "utf8");
console.log(JSON.stringify({
  outputPath,
  orderCount: orderRows.length,
  lineCount: lineRows.length,
  issueCount: issues.length,
  issues: issues.map((row) => ({ orderNumber: row.orderNumber, auditStatus: row.auditStatus, diff: row.diff, missingCodes: row.missingCodes }))
}, null, 2));
