from pathlib import Path

from backend.app.core.ids import new_id


class BlobStore:
    def __init__(self, root: Path | str) -> None:
        self.root = Path(root)
        self.root.mkdir(parents=True, exist_ok=True)

    def put_text(self, category: str, text: str, suffix: str = ".txt") -> str:
        safe_category = category.replace("/", "_").replace("\\", "_")
        category_root = self.root / safe_category
        category_root.mkdir(parents=True, exist_ok=True)
        blob_id = new_id()
        path = category_root / f"{blob_id}{suffix}"
        path.write_text(text, encoding="utf-8")
        return f"{safe_category}/{path.name}"

    def read_text(self, blob_ref: str) -> str:
        path = (self.root / blob_ref).resolve()
        if not path.is_relative_to(self.root.resolve()):
            raise ValueError("blob_ref is outside blob root")
        return path.read_text(encoding="utf-8")
