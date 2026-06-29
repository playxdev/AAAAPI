from pathlib import Path

# โฟลเดอร์ที่ไฟล์ Python อยู่
root = Path(__file__).resolve().parent

deleted = 0

for item in root.rglob("*:Zone.Identifier"):
    try:
        item.unlink()
        print(f"Deleted: {item}")
        deleted += 1
    except Exception as e:
        print(f"Failed: {item} ({e})")

print(f"\nDone. Deleted {deleted} Zone.Identifier files.")