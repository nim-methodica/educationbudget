import Database from "better-sqlite3";
import { mkdir, readFile, readdir, stat, unlink, writeFile } from "node:fs/promises";
import path from "node:path";

let db;
let paths;
let normalize;
let seed;
let usingSqlite = false;
let lastBackupMs = 0;
const AUTO_BACKUP_INTERVAL_MS = 5 * 60 * 1000;
const MAX_BACKUPS = 80;
let storageStatus = {
  mode: "uninitialized",
  dbFile: "",
  jsonFile: "",
  backupDir: "",
  lastBackupFile: "",
  lastBackupAt: "",
  error: ""
};

export async function initializeStorage({ dataDir, dbFile, normalizeData, seedData }) {
  paths = {
    dataDir,
    dbFile: dbFile || path.join(dataDir, "budget.sqlite"),
    jsonFile: path.join(dataDir, "app-data.json"),
    backupDir: path.join(dataDir, "backups")
  };
  normalize = normalizeData;
  seed = seedData;

  await mkdir(dataDir, { recursive: true });
  await mkdir(paths.backupDir, { recursive: true });
  try {
    await mkdir(path.dirname(paths.dbFile), { recursive: true });
    db = new Database(paths.dbFile);
    db.pragma("foreign_keys = ON");
    createSchema();

    const hasState = db.prepare("SELECT 1 FROM app_state WHERE id = 1").get();
    usingSqlite = true;
    storageStatus = {
      mode: "sqlite",
      dbFile: paths.dbFile,
      jsonFile: paths.jsonFile,
      backupDir: paths.backupDir,
      lastBackupFile: storageStatus.lastBackupFile || "",
      lastBackupAt: storageStatus.lastBackupAt || "",
      error: ""
    };
    if (!hasState) {
      const initialData = await readJsonStateOrSeed();
      await saveData(initialData);
    } else if (await isJsonStateNewerThanDatabase()) {
      const initialData = await readJsonStateOrSeed();
      await saveData(initialData);
    }
  } catch (error) {
    db = null;
    usingSqlite = false;
    storageStatus = {
      mode: "json-fallback",
      dbFile: paths.dbFile,
      jsonFile: paths.jsonFile,
      backupDir: paths.backupDir,
      lastBackupFile: storageStatus.lastBackupFile || "",
      lastBackupAt: storageStatus.lastBackupAt || "",
      error: error.message
    };
    console.warn(`SQLite storage is unavailable, falling back to JSON: ${error.message}`);
    await ensureJsonState();
  }
}

export function getStorageStatus() {
  return { ...storageStatus };
}

export async function listBackups() {
  await mkdir(paths.backupDir, { recursive: true });
  const files = await readdir(paths.backupDir);
  const rows = await Promise.all(files
    .filter((file) => /^app-data-\d{8}-\d{6}-(?:auto|manual)\.json$/.test(file))
    .map(async (file) => {
      const filePath = path.join(paths.backupDir, file);
      const stats = await stat(filePath);
      return {
        file,
        filePath,
        size: stats.size,
        createdAt: stats.mtime.toISOString()
      };
    }));
  return rows.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

export async function createDataBackup(data, reason = "manual", options = {}) {
  const nowMs = Date.now();
  if (options.throttle && nowMs - lastBackupMs < AUTO_BACKUP_INTERVAL_MS) {
    return {
      skipped: true,
      reason: "throttled",
      lastBackupFile: storageStatus.lastBackupFile,
      lastBackupAt: storageStatus.lastBackupAt
    };
  }

  await mkdir(paths.backupDir, { recursive: true });
  const safeReason = reason === "auto" ? "auto" : "manual";
  const iso = new Date().toISOString();
  const timestamp = `${iso.slice(0, 10).replace(/-/g, "")}-${iso.slice(11, 19).replace(/:/g, "")}`;
  const file = `app-data-${timestamp}-${safeReason}.json`;
  const filePath = path.join(paths.backupDir, file);
  await writeFile(filePath, JSON.stringify(normalize(data), null, 2), "utf8");
  lastBackupMs = nowMs;
  storageStatus.lastBackupFile = filePath;
  storageStatus.lastBackupAt = new Date(nowMs).toISOString();
  await pruneBackups();
  return { skipped: false, file, filePath, createdAt: storageStatus.lastBackupAt };
}

export async function readData() {
  if (!usingSqlite) return readJsonStateOrSeed();

  const row = db.prepare("SELECT json FROM app_state WHERE id = 1").get();
  if (!row) {
    const initialData = await readJsonStateOrSeed();
    await saveData(initialData);
    return normalize(initialData);
  }
  return normalize(JSON.parse(row.json));
}

export async function saveData(data) {
  const normalized = normalize(data);
  if (!usingSqlite) {
    await writeFile(paths.jsonFile, JSON.stringify(normalized, null, 2), "utf8");
    await createDataBackup(normalized, "auto", { throttle: true });
    return;
  }

  const now = new Date().toISOString();
  const json = JSON.stringify(normalized);

  db.exec("BEGIN IMMEDIATE");
  try {
    db.prepare(`
      INSERT INTO app_state (id, json, updated_at)
      VALUES (1, ?, ?)
      ON CONFLICT(id) DO UPDATE SET json = excluded.json, updated_at = excluded.updated_at
    `).run(json, now);
    refreshIndexes(normalized);
    db.exec("COMMIT");
  } catch (error) {
    try {
      db.exec("ROLLBACK");
    } catch {}
    if (isReadonlyDatabaseError(error)) {
      usingSqlite = false;
      storageStatus = {
        mode: "json-fallback",
        dbFile: paths.dbFile,
        jsonFile: paths.jsonFile,
        backupDir: paths.backupDir,
        lastBackupFile: storageStatus.lastBackupFile || "",
        lastBackupAt: storageStatus.lastBackupAt || "",
        error: error.message
      };
      await writeFile(paths.jsonFile, JSON.stringify(normalized, null, 2), "utf8");
      await createDataBackup(normalized, "auto", { throttle: true });
      return;
    }
    throw error;
  }

  await writeFile(paths.jsonFile, JSON.stringify(normalized, null, 2), "utf8").catch(() => {});
  await createDataBackup(normalized, "auto", { throttle: true }).catch(() => {});
}

async function pruneBackups() {
  const backups = await listBackups();
  const stale = backups.slice(MAX_BACKUPS);
  await Promise.all(stale.map((backup) => unlink(backup.filePath).catch(() => {})));
}

function isReadonlyDatabaseError(error) {
  return /readonly database|SQLITE_READONLY/i.test(String(error?.message || error));
}

async function isJsonStateNewerThanDatabase() {
  try {
    const [jsonStats, dbStats] = await Promise.all([
      stat(paths.jsonFile),
      stat(paths.dbFile)
    ]);
    return jsonStats.mtimeMs > dbStats.mtimeMs;
  } catch {
    return false;
  }
}

function createSchema() {
  db.exec(`
    CREATE TABLE IF NOT EXISTS app_state (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      json TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS frameworks (
      id TEXT PRIMARY KEY,
      title TEXT,
      year TEXT,
      order_number TEXT,
      is_default INTEGER NOT NULL DEFAULT 0,
      active_version_id TEXT
    );

    CREATE TABLE IF NOT EXISTS regulations (
      id TEXT PRIMARY KEY,
      framework_id TEXT NOT NULL,
      number TEXT,
      name TEXT,
      description TEXT,
      framework_amount REAL NOT NULL DEFAULT 0,
      FOREIGN KEY (framework_id) REFERENCES frameworks(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS framework_items (
      framework_id TEXT NOT NULL,
      regulation_id TEXT NOT NULL,
      code TEXT NOT NULL,
      name TEXT,
      unit_cost REAL NOT NULL DEFAULT 0,
      approved_quantity REAL NOT NULL DEFAULT 0,
      PRIMARY KEY (framework_id, regulation_id, code),
      FOREIGN KEY (framework_id) REFERENCES frameworks(id) ON DELETE CASCADE,
      FOREIGN KEY (regulation_id) REFERENCES regulations(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS project_orders (
      id TEXT PRIMARY KEY,
      framework_id TEXT NOT NULL,
      regulation_id TEXT NOT NULL,
      order_number TEXT,
      project_name TEXT,
      status TEXT,
      total_without_vat REAL NOT NULL DEFAULT 0,
      source_file TEXT,
      FOREIGN KEY (framework_id) REFERENCES frameworks(id) ON DELETE CASCADE,
      FOREIGN KEY (regulation_id) REFERENCES regulations(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS monthly_cases (
      id TEXT PRIMARY KEY,
      month TEXT,
      title TEXT,
      status TEXT
    );

    CREATE TABLE IF NOT EXISTS documents (
      id TEXT PRIMARY KEY,
      case_id TEXT NOT NULL,
      type TEXT,
      name TEXT,
      url TEXT,
      amount REAL,
      created_at TEXT,
      FOREIGN KEY (case_id) REFERENCES monthly_cases(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY,
      name TEXT,
      email TEXT,
      role TEXT
    );
  `);
}

async function readJsonStateOrSeed() {
  try {
    await stat(paths.jsonFile);
    return normalize(JSON.parse(await readFile(paths.jsonFile, "utf8")));
  } catch {
    return normalize(seed());
  }
}

async function ensureJsonState() {
  try {
    await stat(paths.jsonFile);
  } catch {
    await writeFile(paths.jsonFile, JSON.stringify(normalize(seed()), null, 2), "utf8");
  }
}

function refreshIndexes(data) {
  db.exec(`
    DELETE FROM documents;
    DELETE FROM monthly_cases;
    DELETE FROM project_orders;
    DELETE FROM framework_items;
    DELETE FROM regulations;
    DELETE FROM frameworks;
    DELETE FROM users;
  `);

  const insertFramework = db.prepare(`
    INSERT INTO frameworks (id, title, year, order_number, is_default, active_version_id)
    VALUES (?, ?, ?, ?, ?, ?)
  `);
  const insertRegulation = db.prepare(`
    INSERT INTO regulations (id, framework_id, number, name, description, framework_amount)
    VALUES (?, ?, ?, ?, ?, ?)
  `);
  const insertItem = db.prepare(`
    INSERT INTO framework_items (framework_id, regulation_id, code, name, unit_cost, approved_quantity)
    VALUES (?, ?, ?, ?, ?, ?)
  `);
  const insertOrder = db.prepare(`
    INSERT INTO project_orders (id, framework_id, regulation_id, order_number, project_name, status, total_without_vat, source_file)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const insertCase = db.prepare(`
    INSERT INTO monthly_cases (id, month, title, status)
    VALUES (?, ?, ?, ?)
  `);
  const insertDocument = db.prepare(`
    INSERT INTO documents (id, case_id, type, name, url, amount, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `);
  const insertUser = db.prepare(`
    INSERT INTO users (id, name, email, role)
    VALUES (?, ?, ?, ?)
  `);

  for (const framework of data.frameworks || []) {
    insertFramework.run(
      framework.id,
      framework.title || "",
      framework.year || "",
      framework.orderNumber || "",
      framework.isDefault ? 1 : 0,
      framework.activeVersionId || ""
    );
    for (const regulation of framework.regulations || []) {
      insertRegulation.run(
        regulation.id,
        framework.id,
        String(regulation.number || ""),
        regulation.name || "",
        regulation.description || "",
        Number(regulation.frameworkAmount || 0)
      );
      for (const item of regulation.items || []) {
        insertItem.run(
          framework.id,
          regulation.id,
          String(item.code || ""),
          item.name || "",
          Number(item.unitCost || 0),
          Number(item.approvedQuantity || 0)
        );
      }
      for (const order of regulation.projectOrders || []) {
        insertOrder.run(
          order.id,
          framework.id,
          regulation.id,
          order.orderNumber || "",
          order.projectName || "",
          order.status || "",
          Number(order.totalWithoutVat || 0),
          order.sourceFile || ""
        );
      }
    }
  }

  for (const monthlyCase of data.monthlyCases || []) {
    insertCase.run(monthlyCase.id, monthlyCase.month || "", monthlyCase.title || "", monthlyCase.status || "");
    for (const document of monthlyCase.documents || []) {
      insertDocument.run(
        document.id,
        monthlyCase.id,
        document.type || "",
        document.name || "",
        document.url || "",
        document.amount === undefined ? null : Number(document.amount || 0),
        document.createdAt || ""
      );
    }
  }

  for (const user of data.users || []) {
    insertUser.run(user.id, user.name || "", user.email || "", user.role || "");
  }
}
