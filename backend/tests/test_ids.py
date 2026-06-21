from __future__ import annotations

import re

from backend.app.core.ids import new_id


def test_new_id_uses_date_prefix_and_hex_suffix() -> None:
    value = new_id()

    assert re.fullmatch(r"\d{8}-[0-9a-f]{32}", value)
    assert not value.startswith(("ses_", "trace_", "evt_", "call_", "blob_", "provider_"))
