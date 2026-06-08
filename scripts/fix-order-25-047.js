import Database from "better-sqlite3";
import fs from "node:fs";
import path from "node:path";

const workspace = process.cwd();
const dbFile = path.join(process.env.LOCALAPPDATA || "", "educationbudget", "budget.sqlite");
const jsonFile = path.join(workspace, "data", "app-data.json");
const backupDir = path.join(workspace, "data", "backups");

const orderNumber = "25-047";
const sourceFile = "פיתוח תוכן במדעים 720  - אנרגיה 25-047.pdf";
const totalWithoutVat = 1137325;
const vatRate = 0.18;
const totalWithVat = totalWithoutVat * (1 + vatRate);

const lines = [
  { code: "18.2", name: "תוכן טקסטואלי /טקסט עיוני (מתקדם)", quantity: 15, unitCost: 825 },
  { code: "22.2", name: "סרטון ללא צילום (מתקדם)", quantity: 9, unitCost: 6000 },
  { code: "23.2", name: "סרטון מצולם מתקדם", quantity: 23, unitCost: 12000 },
  { code: "23.3", name: "סרטון מצולם מורכב", quantity: 4, unitCost: 18000 },
  { code: "25.1", name: "סרטון אנימציה בסיסי", quantity: 1, unitCost: 7000 },
  { code: "27.1", name: "יישומון בסיסי", quantity: 163, unitCost: 1750 },
  { code: "27.2", name: "יישומון מתקדם", quantity: 6, unitCost: 6000 },
  { code: "33.1", name: "לומדה בסיסית", quantity: 23, unitCost: 13000 },
  { code: "34.2", name: "אינפוגרפיקה מתקדמת", quantity: 3, unitCost: 4400 },
  { code: "41", name: "שעת מומחה תוכן, ייעוץ מדעי וייעוץ טכנו-פדגוגי מדעי", quantity: 250, unitCost: 330 }
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
  const db = new Database(dbFile);
  const now = new Date().toISOString();
  db.prepare(`
    INSERT INTO app_state (id, json, updated_at)
    VALUES (1, ?, ?)
    ON CONFLICT(id) DO UPDATE SET json = excluded.json, updated_at = excluded.updated_at
  `).run(json, now);
  db.close();
  fs.writeFileSync(jsonFile, json, "utf8");
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

  const lineSum = lines.reduce((sum, line) => sum + line.quantity * line.unitCost, 0);
  if (lineSum !== totalWithoutVat) {
    throw new Error(`Line sum mismatch: ${lineSum} != ${totalWithoutVat}`);
  }

  order.projectName = "פיתוח תוכן במדעים 720 - אנרגיה";
  order.customerUnit = "למידה מותאמת אישית 720";
  order.issuedAt = "2025-12-24";
  order.expectedEndAt = "2026-03-01";
  order.sourceFile = sourceFile;
  order.totalWithoutVat = totalWithoutVat;
  order.lines = lines;

  // The tracking workbook marks this order as paid/closed. Keep that state,
  // but align the money fields with the PDF order value.
  order.paidWithoutVatTotal = totalWithoutVat;
  order.paidWithVatTotal = totalWithVat;
  order.remainingWithoutVatFromTracking = 0;
  order.remainingWithVatFromTracking = 0;
  order.paymentTrackingSource = `${sourceFile} / תוקן לפי PDF`;

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
