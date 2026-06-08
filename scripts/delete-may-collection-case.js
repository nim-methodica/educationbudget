import Database from "better-sqlite3";
import fs from "node:fs";
import path from "node:path";

const workspace = process.cwd();
const dbFile = path.join(process.env.LOCALAPPDATA || "", "educationbudget", "budget.sqlite");
const jsonFile = path.join(workspace, "data", "app-data.json");
const backupDir = path.join(workspace, "data", "backups");
const monthToDelete = "2026-05";

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

function main() {
  if (!fs.existsSync(dbFile)) throw new Error(`SQLite database not found: ${dbFile}`);
  if (!fs.existsSync(jsonFile)) throw new Error(`JSON mirror not found: ${jsonFile}`);

  fs.mkdirSync(backupDir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  fs.copyFileSync(dbFile, path.join(backupDir, `budget-before-delete-may-${stamp}.sqlite`));
  fs.copyFileSync(jsonFile, path.join(backupDir, `app-data-before-delete-may-${stamp}.json`));

  const data = readState();
  const mayCaseIds = new Set(
    (data.monthlyCases || [])
      .filter((monthlyCase) => monthlyCase.month === monthToDelete)
      .map((monthlyCase) => monthlyCase.id)
  );

  const beforeCases = data.monthlyCases?.length || 0;
  data.monthlyCases = (data.monthlyCases || []).filter((monthlyCase) => monthlyCase.month !== monthToDelete);
  const deletedCases = beforeCases - data.monthlyCases.length;

  const deletedCollections = [];
  for (const framework of data.frameworks || []) {
    for (const regulation of framework.regulations || []) {
      for (const order of regulation.projectOrders || []) {
        const before = order.collections || [];
        order.collections = before.filter((collection) => {
          const shouldDelete =
            collection.month === monthToDelete ||
            (collection.monthlyCaseId && mayCaseIds.has(collection.monthlyCaseId));
          if (shouldDelete) {
            deletedCollections.push({
              orderNumber: order.orderNumber,
              collectionId: collection.id,
              month: collection.month,
              sourceDocumentName: collection.sourceDocumentName || ""
            });
          }
          return !shouldDelete;
        });
      }
    }
  }

  writeState(data);

  console.log(JSON.stringify({
    deletedMonth: monthToDelete,
    deletedCases,
    deletedCaseIds: [...mayCaseIds],
    deletedCollections,
    remainingMonthlyCases: data.monthlyCases.map((monthlyCase) => ({
      id: monthlyCase.id,
      month: monthlyCase.month,
      title: monthlyCase.title
    }))
  }, null, 2));
}

main();
