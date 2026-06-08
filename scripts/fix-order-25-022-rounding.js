import Database from "better-sqlite3";
import fs from "node:fs";
import path from "node:path";

const workspace = process.cwd();
const dbFile = path.join(process.env.LOCALAPPDATA || "", "educationbudget", "budget.sqlite");
const jsonFile = path.join(workspace, "data", "app-data.json");
const backupDir = path.join(workspace, "data", "backups");
const orderNumber = "25-022";

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
        if (order.orderNumber === orderNumber) return order;
      }
    }
  }
  return null;
}

function main() {
  fs.mkdirSync(backupDir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  fs.copyFileSync(dbFile, path.join(backupDir, `budget-before-${orderNumber}-rounding-${stamp}.sqlite`));
  fs.copyFileSync(jsonFile, path.join(backupDir, `app-data-before-${orderNumber}-rounding-${stamp}.json`));

  const data = readState();
  const order = findOrder(data);
  if (!order) throw new Error(`Order ${orderNumber} was not found`);

  const line = (order.lines || []).find((item) => String(item.code) === "44");
  if (!line) throw new Error(`Order ${orderNumber} does not contain line 44`);

  line.unitCost = 137.5;
  const lineSum = order.lines.reduce((sum, item) => sum + Number(item.quantity || 0) * Number(item.unitCost || 0), 0);
  if (lineSum !== 29975) throw new Error(`Unexpected line sum after fix: ${lineSum}`);

  order.totalWithoutVat = 29975;
  order.paidWithoutVatTotal = 29975;
  order.paidWithVatTotal = 35370.5;
  order.remainingWithoutVatFromTracking = 0;
  order.remainingWithVatFromTracking = 0;

  writeState(data);
  console.log(JSON.stringify({
    orderNumber,
    updated: true,
    fixedLine: { code: "44", unitCost: 137.5, quantity: line.quantity },
    lineSum,
    totalWithoutVat: order.totalWithoutVat
  }, null, 2));
}

main();
