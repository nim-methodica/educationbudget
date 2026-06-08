# אחסון וגיבוי נתונים

המערכת שומרת את מצב הנתונים המלא במקום אחד, ומחזיקה גם עותק JSON מקומי לגיבוי ולשחזור.

## איפה הנתונים נשמרים

- SQLite מקומי: `C:\Users\Nimrod\AppData\Local\educationbudget\budget.sqlite`
- עותק JSON מקומי: `data/app-data.json`
- גיבויים אוטומטיים וידניים: `data/backups`

אם SQLite לא זמין, המערכת עוברת אוטומטית לשמירה בקובץ JSON כדי לא לעצור עבודה.

## גיבויים

בכל שמירה משמעותית המערכת יוצרת גיבוי אוטומטי, לכל היותר פעם בחמש דקות.
בנוסף אפשר ליצור גיבוי ידני דרך השרת:

```powershell
Invoke-RestMethod -Method Post -Uri "http://localhost:4238/api/backups"
```

בדיקת מצב האחסון והגיבוי:

```text
http://localhost:4238/api/storage
```

רשימת גיבויים:

```text
http://localhost:4238/api/backups
```

## לפני פעולות רגישות

לפני עדכון מסגרת, קליטת הרבה הזמנות או שינוי גביה משמעותי, מומלץ ליצור גיבוי ידני.
