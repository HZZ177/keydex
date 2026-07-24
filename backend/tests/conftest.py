from __future__ import annotations

import pytest

from backend.tests.async_checkpoint import close_test_checkpoint_stores


@pytest.fixture(autouse=True)
async def _close_async_checkpoint_test_stores():
    yield
    await close_test_checkpoint_stores()
