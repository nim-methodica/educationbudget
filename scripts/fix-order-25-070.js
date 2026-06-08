import Database from "better-sqlite3";
import { mkdirSync, copyFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, "..");
const dbFile = path.join(process.env.LOCALAPPDATA || path.join(rootDir, "data"), "educationbudget", "budget.sqlite");
const jsonFile = path.join(rootDir, "data", "app-data.json");
const backupDir = path.join(rootDir, "data", "backups");
const stamp = new Date().toISOString().replace(/[:.]/g, "-");

const allowedLineCodes = new Set(["20.2", "22.2", "23.2", "27.1", "27.2", "33.1", "41"]);

mkdirSync(backupDir, { recursive: true });
copyFileSync(dbFile, path.join(backupDir, `budget-before-fix-25-070-${stamp}.sqlite`));

const db = new Database(dbFile);
const row = db.prepare("SELECT json FROM app_state WHERE id = 1").get();
if (!row) throw new Error("לא נמצא מצב מערכת ב-SQLite");

const data = JSON.parse(row.json);
let fixedOrder = null;

for (const framework of data.frameworks || []) {
  for (const regulation of framework.regulations || []) {
    for (const order of regulation.projectOrders || []) {
      if (order.orderNumber !== "25-070") continue;

      const beforeLines = order.lines || [];
      const afterLines = beforeLines.filter((line) => allowedLineCodes.has(String(line.code)));
      const afterTotal = round2(afterLines.reduce((sum, line) => {
        return sum + Number(line.quantity || 0) * Number(line.unitCost || 0);
      }, 0));

      order.lines = afterLines;
      order.totalWithoutVat = afterTotal;
      order.remainingWithoutVatFromTracking = round2(afterTotal - Number(order.paidWithoutVatTotal || 0));
      order.remainingWithVatFromTracking = round2(order.remainingWithoutVatFromTracking * (1 + Number(data.vatRate || 0.18)));

      fixedOrder = {
        id: order.id,
        orderNumber: order.orderNumber,
        beforeLineCount: beforeLines.length,
        afterLineCount: afterLines.length,
        removedLineCodes: beforeLines
          .map((line) => String(line.code))
          .filter((code) => !allowedLineCodes.has(code)),
        totalWithoutVat: order.totalWithoutVat,
        lineSum: afterTotal
      };
    }
  }
}

if (!fixedOrder) throw new Error("הזמנה 25-070 לא נמצאה במערכת");

const normalized = JSON.stringify(data, null, 2);
writeFileSync(path.join(backupDir, `app-data-before-fix-25-070-${stamp}.json`), row.json, "utf8");
db.prepare(`
  UPDATE app_state
  SET json = ?, updated_at = ?
  WHERE id = 1
`).run(normalized, new Date().toISOString());
writeFileSync(jsonFile, normalized, "utf8");

console.log(JSON.stringify({ ok: true, dbFile, jsonFile, fixedOrder }, null, 2));

function round2(value) {
  return Math.round((Number(value || 0) + Number.EPSILON) * 100) / 100;
}
