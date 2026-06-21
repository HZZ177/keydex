from datetime import datetime
from uuid import uuid4


def new_id() -> str:
    return f"{datetime.now().strftime('%Y%m%d')}-{uuid4().hex}"
