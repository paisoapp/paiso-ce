"""The local storage driver (app/core/storage.py)."""
import pytest

pytestmark = pytest.mark.unit


async def _exercise(storage):
    key = "attachments/1/2/abc.txt"
    assert await storage.get(key) is None
    await storage.put(key, b"hello")
    assert await storage.get(key) == b"hello"
    assert await storage.exists(key)

    await storage.put("attachments/1/3/other.txt", b"x")
    await storage.delete_prefix("attachments/1/")
    assert await storage.get(key) is None
    assert not await storage.exists("attachments/1/3/other.txt")

    await storage.delete("nonexistent/key")  # no-op, no raise


async def test_local_disk_storage(tmp_path):
    from app.core.storage import LocalDiskStorage

    await _exercise(LocalDiskStorage(tmp_path))


async def test_local_disk_storage_rejects_traversal(tmp_path):
    from app.core.storage import LocalDiskStorage

    with pytest.raises(ValueError):
        await LocalDiskStorage(tmp_path).get("../../etc/passwd")


async def test_storage_rejects_prefix_escape(tmp_path):
    """A key that stays under the root but hops out of its folder via `..`
    (e.g. thumbnails/../logos/x) is refused."""
    from app.core.storage import LocalDiskStorage

    storage = LocalDiskStorage(tmp_path)
    for bad in ("thumbnails/../logos/acct_1.png", "a/../../b", "/etc/hostname"):
        with pytest.raises(ValueError):
            await storage.get(bad)
        with pytest.raises(ValueError):
            await storage.put(bad, b"x")
        with pytest.raises(ValueError):
            await storage.delete(bad)

