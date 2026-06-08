import Database from "better-sqlite3";
import fs from "node:fs";
import path from "node:path";

const workspace = process.cwd();
const dbFile = path.join(process.env.LOCALAPPDATA || "", "educationbudget", "budget.sqlite");
const jsonFile = path.join(workspace, "data", "app-data.json");
const backupDir = path.join(workspace, "data", "backups");

const regulationNumber = "46";
const withVat = 822950;
const vatRate = 0.18;
const withoutVat = Math.round((withVat / (1 + vatRate)) * 100) / 100;

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
  fs.copyFileSync(dbFile, path.join(backupDir, `budget-before-reg-46-amount-${stamp}.sqlite`));
  fs.copyFileSync(jsonFile, path.join(backupDir, `app-data-before-reg-46-amount-${stamp}.json`));

  const data = readState();
  let updated = null;

  for (const framework of data.frameworks || []) {
    for (const regulation of framework.regulations || []) {
      if (String(regulation.number) === regulationNumber) {
        updated = {
          previousWithoutVat: regulation.frameworkAmount,
          previousWithVat: Math.round(Number(regulation.frameworkAmount || 0) * (1 + vatRate) * 100) / 100,
          currentWithoutVat: withoutVat,
          currentWithVat: withVat
        };
        regulation.frameworkAmount = withoutVat;
      }
    }
  }

  if (!updated) throw new Error(`Regulation ${regulationNumber} was not found`);

  writeState(data);
  console.log(JSON.stringify({ regulationNumber, updated }, null, 2));
}

main();
