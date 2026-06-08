# -*- coding: utf-8 -*-
import argparse
import json
import os
import re
import shutil
import sqlite3
from datetime import datetime
from pathlib import Path

import fitz


WORKSPACE = Path.cwd()
DB_FILE = Path(os.environ.get("LOCALAPPDATA", "")) / "educationbudget" / "budget.sqlite"
JSON_FILE = WORKSPACE / "data" / "app-data.json"
INCOMING_DIR = WORKSPACE / "incoming-orders"
BACKUP_DIR = WORKSPACE / "data" / "backups"
VAT_RATE = 0.18

HE_SECTION = "\u05e1\u05e2\u05d9\u05e3"
HE_TOTAL = "\u05e1\u05d4\"\u05db"
HE_REGULATION = "\u05ea\u05e7\u05e0\u05d4"
HE_ORDER_SUMMARY = "\u05e1\u05d9\u05db\u05d5\u05dd"

FALLBACK_ITEM_NAMES = {
    "27.1": "יישומון בסיסי",
    "35": "הוספת כתוביות בשפות נוספות במקום כתוביות קיימות או בתוספת לכתוביות קיימות",
}


def clean_number(value):
    if value is None:
        return None
    if isinstance(value, (int, float)):
        return float(value)
    text = str(value).replace("\u200f", "").replace("\u200e", "")
    text = text.replace("₪", "").replace(",", "").strip()
    match = re.search(r"-?\d+(?:\.\d+)?", text)
    return float(match.group(0)) if match else None


def is_code(value):
    return bool(re.fullmatch(r"\d+(?:\.\d+)?", str(value).strip()))


def normalize_code(value):
    text = str(value).strip()
    return text[:-2] if re.fullmatch(r"\d+\.0", text) else text


def normalize_date(value):
    value = str(value).strip()
    for pattern in ("%d/%m/%Y", "%d.%m.%Y", "%d.%m.%y", "%d/%m/%y"):
        try:
            return datetime.strptime(value, pattern).date().isoformat()
        except ValueError:
            pass
    return ""


def next_after_label(tokens, label_prefix):
    for index, token in enumerate(tokens):
        if token.startswith(label_prefix):
            if ":" in token:
                rest = token.split(":", 1)[1].strip()
                if rest:
                    return rest
            if index + 1 < len(tokens):
                return tokens[index + 1].strip()
    return ""


def extract_project_name(tokens):
    for index, token in enumerate(tokens):
        if token.startswith("שם הפרויקט"):
            parts = []
            if ":" in token:
                rest = token.split(":", 1)[1].strip()
                if rest:
                    parts.append(rest)
            cursor = index + 1
            while cursor < len(tokens):
                current = tokens[cursor]
                if current.startswith("תאריך") or current == "סוג הזמנה":
                    break
                parts.append(current)
                cursor += 1
            return " ".join(part for part in parts if part).strip()
    return ""


def parse_pdf(pdf_file):
    document = fitz.open(pdf_file)
    text = "\n".join(page.get_text("text") for page in document)
    tokens = [line.strip() for line in text.splitlines() if line.strip()]

    order_number = ""
    for token in tokens:
        if re.fullmatch(r"25-\d{3}", token):
            order_number = token
            break
    if not order_number:
        match = re.search(r"25-\d{3}", pdf_file.name)
        order_number = match.group(0) if match else ""

    regulation = ""
    for token in tokens:
        if token.startswith(HE_REGULATION):
            regulation = "".join(re.findall(r"\d+", token))

    lines = []
    for header_index, token in enumerate(tokens):
        if token != HE_SECTION:
            continue
        cursor = header_index + 1
        while cursor < len(tokens) and tokens[cursor] != HE_TOTAL:
            cursor += 1
        if cursor >= len(tokens):
            continue
        cursor += 1
        while cursor + 3 < len(tokens) and is_code(tokens[cursor]):
            unit_cost = clean_number(tokens[cursor + 1])
            quantity = clean_number(tokens[cursor + 2])
            total = clean_number(tokens[cursor + 3])
            if unit_cost is None or quantity is None or total is None:
                break
            lines.append({
                "code": normalize_code(tokens[cursor]),
                "quantity": quantity,
                "unitCost": unit_cost,
                "total": total,
            })
            cursor += 4
        if lines:
            break

    return {
        "file": pdf_file.name,
        "orderNumber": order_number,
        "projectName": extract_project_name(tokens),
        "customerUnit": next_after_label(tokens, "יחידה מזמינה"),
        "issuedAt": normalize_date(next_after_label(tokens, "תאריך הוצאת הזמנה")),
        "expectedEndAt": normalize_date(next_after_label(tokens, "מועד מתוכנן לסיום ביצוע")),
        "regulation": regulation,
        "lines": lines,
        "totalWithoutVat": sum(line["total"] for line in lines),
    }


def read_state():
    connection = sqlite3.connect(DB_FILE)
    try:
        row = connection.execute("SELECT json FROM app_state WHERE id = 1").fetchone()
    finally:
        connection.close()
    if not row:
        raise RuntimeError(f"No app_state row found in {DB_FILE}")
    return json.loads(row[0])


def write_state(data):
    payload = json.dumps(data, ensure_ascii=False, indent=2)
    now = datetime.utcnow().isoformat(timespec="milliseconds") + "Z"
    connection = sqlite3.connect(DB_FILE)
    try:
        connection.execute(
            """
            INSERT INTO app_state (id, json, updated_at)
            VALUES (1, ?, ?)
            ON CONFLICT(id) DO UPDATE SET json = excluded.json, updated_at = excluded.updated_at
            """,
            (payload, now),
        )
        connection.commit()
    finally:
        connection.close()
    JSON_FILE.write_text(payload, encoding="utf-8")


def build_item_name_lookup(data):
    lookup = {}
    for framework in data.get("frameworks", []):
        for regulation in framework.get("regulations", []):
            reg_number = str(regulation.get("number", ""))
            for item in regulation.get("items", []):
                lookup[(reg_number, str(item.get("code", "")))] = item.get("name", "")
    return lookup


def iter_orders(data):
    for framework in data.get("frameworks", []):
        for regulation in framework.get("regulations", []):
            for order in regulation.get("projectOrders", []):
                yield framework, regulation, order


def update_order(data, parsed, item_names):
    for framework, regulation, order in iter_orders(data):
        if order.get("orderNumber") != parsed["orderNumber"]:
            continue

        reg_number = str(regulation.get("number", ""))
        imported_lines = []
        for line in parsed["lines"]:
            code = line["code"]
            imported_lines.append({
                "code": code,
                "name": item_names.get((reg_number, code)) or FALLBACK_ITEM_NAMES.get(code, ""),
                "quantity": line["quantity"],
                "unitCost": line["unitCost"],
            })

        previous_total = order.get("totalWithoutVat", 0)
        previous_line_count = len(order.get("lines", []))
        total_without_vat = round(parsed["totalWithoutVat"], 2)
        total_with_vat = round(total_without_vat * (1 + VAT_RATE), 2)

        if parsed["projectName"]:
            order["projectName"] = parsed["projectName"]
        if parsed["customerUnit"]:
            order["customerUnit"] = parsed["customerUnit"]
        if parsed["issuedAt"]:
            order["issuedAt"] = parsed["issuedAt"]
        if parsed["expectedEndAt"]:
            order["expectedEndAt"] = parsed["expectedEndAt"]
        order["sourceFile"] = parsed["file"]
        order["totalWithoutVat"] = total_without_vat
        order["lines"] = imported_lines

        if order.get("status") == "closed":
            order["paidWithoutVatTotal"] = total_without_vat
            order["paidWithVatTotal"] = total_with_vat
            order["remainingWithoutVatFromTracking"] = 0
            order["remainingWithVatFromTracking"] = 0
        else:
            paid_without_vat = float(order.get("paidWithoutVatTotal") or 0)
            paid_with_vat = float(order.get("paidWithVatTotal") or 0)
            order["remainingWithoutVatFromTracking"] = round(total_without_vat - paid_without_vat, 2)
            order["remainingWithVatFromTracking"] = round(total_with_vat - paid_with_vat, 2)

        order["paymentTrackingSource"] = f"{parsed['file']} / imported from PDF"

        return {
            "orderNumber": parsed["orderNumber"],
            "file": parsed["file"],
            "previousTotal": previous_total,
            "currentTotal": total_without_vat,
            "previousLineCount": previous_line_count,
            "currentLineCount": len(imported_lines),
        }
    return None


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--dry-run", action="store_true")
    args = parser.parse_args()

    if not DB_FILE.exists():
        raise RuntimeError(f"SQLite database not found: {DB_FILE}")
    if not JSON_FILE.exists():
        raise RuntimeError(f"JSON mirror not found: {JSON_FILE}")
    if not INCOMING_DIR.exists():
        raise RuntimeError(f"Incoming orders folder not found: {INCOMING_DIR}")

    data = read_state()
    item_names = build_item_name_lookup(data)

    parsed_files = [parse_pdf(pdf_file) for pdf_file in sorted(INCOMING_DIR.glob("*.pdf"))]
    parsed_files = [parsed for parsed in parsed_files if parsed["orderNumber"]]

    updates = []
    missing = []
    extraction_errors = []
    for parsed in parsed_files:
        if not parsed["lines"]:
            extraction_errors.append(parsed["file"])
            continue
        result = update_order(data, parsed, item_names)
        if result:
            updates.append(result)
        else:
            missing.append(parsed["orderNumber"])

    if not args.dry_run:
        BACKUP_DIR.mkdir(parents=True, exist_ok=True)
        stamp = datetime.now().isoformat(timespec="seconds").replace(":", "-")
        shutil.copy2(DB_FILE, BACKUP_DIR / f"budget-before-import-incoming-{stamp}.sqlite")
        shutil.copy2(JSON_FILE, BACKUP_DIR / f"app-data-before-import-incoming-{stamp}.json")
        write_state(data)

    print(json.dumps({
        "dryRun": args.dry_run,
        "pdfFiles": len(parsed_files),
        "updatedOrders": updates,
        "missingOrdersInSystem": missing,
        "extractionErrors": extraction_errors,
    }, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
