import Database from "better-sqlite3";
import fs from "node:fs";
import path from "node:path";

const workspace = process.cwd();
const dbFile = path.join(process.env.LOCALAPPDATA || "", "educationbudget", "budget.sqlite");
const jsonFile = path.join(workspace, "data", "app-data.json");
const backupDir = path.join(workspace, "data", "backups");

const orderNumber = "25-007";
const sourceFile = "עותק של פיתוח תרחישי כישורי חיים לקיו 25-007.pdf";
const totalWithoutVat = 616000;
const vatRate = 0.18;
const totalWithVat = totalWithoutVat * (1 + vatRate);

const lines = [
  { code: "3.1", name: "פיתוח רכיבים בסיסי", quantity: 9, unitCost: 10000 },
  { code: "3.2", name: "פיתוח רכיבים מתקדם", quantity: 7, unitCost: 17000 },
  { code: "3.3", name: "פיתוח רכיבים מורכב", quantity: 13, unitCost: 23000 },
  { code: "23.3", name: "סרטון מצולם מורכב", quantity: 6, unitCost: 18000 }
];

function readState() {
  const db = new Database(dbFile);
  const row = db.prepare("SELECT json FROM app_state WHERE id = 1").get();
  db.close();
  if (!row?.json) throw new Error(`No app_state row found in ${dbFile}`);
  return JSON.parse(row.json);
}

function writeState(data) {
  const json = JSON.stringify(data, null, 2);
  const compactJson = JSON.stringify(data);
  const db = new Database(dbFile);
  const now = new Date().toISOString();
  db.prepare(`
    INSERT INTO app_state (id, json, updated_at)
    VALUES (1, ?, ?)
    ON CONFLICT(id) DO UPDATE SET json = excluded.json, updated_at = excluded.updated_at
  `).run(json, now);
  db.close();
  fs.writeFileSync(jsonFile, json, "utf8");
  return compactJson.length;
}

function findOrder(data) {
  for (const framework of data.frameworks || []) {
    for (const regulation of framework.regulations || []) {
      for (const order of regulation.projectOrders || []) {
        if (order.orderNumber === orderNumber) return { framework, regulation, order };
      }
    }
  }
  return null;
}

function main() {
  if (!fs.existsSync(dbFile)) throw new Error(`SQLite database not found: ${dbFile}`);
  if (!fs.existsSync(jsonFile)) throw new Error(`JSON mirror not found: ${jsonFile}`);

  fs.mkdirSync(backupDir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  fs.copyFileSync(dbFile, path.join(backupDir, `budget-before-${orderNumber}-${stamp}.sqlite`));
  fs.copyFileSync(jsonFile, path.join(backupDir, `app-data-before-${orderNumber}-${stamp}.json`));

  const data = readState();
  const found = findOrder(data);
  if (!found) throw new Error(`Order ${orderNumber} was not found`);

  const { order } = found;
  const previous = {
    totalWithoutVat: order.totalWithoutVat,
    paidWithoutVatTotal: order.paidWithoutVatTotal,
    paidWithVatTotal: order.paidWithVatTotal,
    remainingWithoutVatFromTracking: order.remainingWithoutVatFromTracking,
    remainingWithVatFromTracking: order.remainingWithVatFromTracking,
    lines: order.lines
  };

  order.projectName = "פיתוח תרחישי כישורי חיים לקיו";
  order.customerUnit = "בינה מלאכותית";
  order.issuedAt = "2025-10-21";
  order.expectedEndAt = "2026-01-31";
  order.sourceFile = sourceFile;
  order.totalWithoutVat = totalWithoutVat;
  order.lines = lines;

  // The tracking workbook marks this order as paid/closed. Keep that business state,
  // but align the paid and remaining amounts with the corrected PDF order value.
  order.paidWithoutVatTotal = totalWithoutVat;
  order.paidWithVatTotal = totalWithVat;
  order.remainingWithoutVatFromTracking = 0;
  order.remainingWithVatFromTracking = 0;
  order.paymentTrackingSource = `${sourceFile} / תוקן לפי PDF`;

  const lineSum = lines.reduce((sum, line) => sum + line.quantity * line.unitCost, 0);
  if (lineSum !== totalWithoutVat) {
    throw new Error(`Line sum mismatch: ${lineSum} != ${totalWithoutVat}`);
  }

  writeState(data);

  console.log(JSON.stringify({
    orderNumber,
    updated: true,
    previous,
    current: {
      totalWithoutVat: order.totalWithoutVat,
      totalWithVat,
      lineCount: order.lines.length,
      lineSum,
      sourceFile: order.sourceFile
    }
  }, null, 2));
}

main();
