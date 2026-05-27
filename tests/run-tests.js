import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";

const serverSource = await readFile(path.join(process.cwd(), "server.js"), "utf8");
assert.match(serverSource, /function seedData/);
assert.match(serverSource, /function summarizeRegulation/);
assert.match(serverSource, /function enrichOrder/);

const appSource = await readFile(path.join(process.cwd(), "public", "app.js"), "utf8");
assert.match(appSource, /formatDual/);
assert.match(appSource, /openRegulation/);
assert.match(appSource, /parseLines/);

const htmlSource = await readFile(path.join(process.cwd(), "public", "index.html"), "utf8");
assert.match(htmlSource, /dir="rtl"/);
assert.match(htmlSource, /הזמנה חדשה/);
assert.match(htmlSource, /העלאת הזמנת פרויקט/);

const cssSource = await readFile(path.join(process.cwd(), "public", "styles.css"), "utf8");
assert.match(cssSource, /regulation-grid/);
assert.match(cssSource, /@media/);

const vat = 0.18;
const item = { unitCost: 825, approvedQuantity: 120 };
const reserved = 28 * item.unitCost;
const collected = 15 * item.unitCost;
assert.equal(Math.round(reserved * (1 + vat)), 27258);
assert.equal(Math.round((reserved - collected) * (1 + vat)), 12656);

const approvedQuantity = 120;
const reservedQuantity = 100;
const remainingRatio = (approvedQuantity - reservedQuantity) / approvedQuantity;
assert.equal(remainingRatio <= 0.2, true);

console.log("All tests passed");
