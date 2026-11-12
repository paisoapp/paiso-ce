"""Asset thumbnail reference safety.

A client controls an asset's metadata_json, and ``custom_thumbnail`` becomes a
storage key. These guard that a path-traversal value can never escape the
thumbnails/ prefix — neither when stored nor when read/deleted.
"""
import pytest

from app.api.assets import _safe_thumb_name, _sanitize_meta, _thumb_key
from fastapi import HTTPException

pytestmark = pytest.mark.unit


@pytest.mark.parametrize("good", [
    "7_16_abcd1234.png",
    "1_2_deadbeef.jpg",
    "logo.webp",
])
def test_safe_names_pass(good):
    assert _safe_thumb_name(good) == good
    assert _thumb_key(good) == f"thumbnails/{good}"


@pytest.mark.parametrize("bad", [
    "../logos/acct_229.png",
    "../../etc/hostname",
    "a/b.png",
    "..",
    "foo/../bar.png",
    "\\windows\\x.png",
    "",
    None,
    123,
])
def test_unsafe_names_are_rejected(bad):
    assert _safe_thumb_name(bad) is None


@pytest.mark.parametrize("bad", [
    "../logos/acct_229.png",
    "../../etc/hostname",
    "a/b.png",
])
def test_thumb_key_refuses_unsafe(bad):
    with pytest.raises(HTTPException) as e:
        _thumb_key(bad)
    assert e.value.status_code == 400


def test_sanitize_meta_drops_unsafe_custom_thumbnail():
    cleaned = _sanitize_meta({"custom_thumbnail": "../logos/acct_1.png", "zillow_url": "x"})
    assert "custom_thumbnail" not in cleaned
    assert cleaned["zillow_url"] == "x"


def test_sanitize_meta_keeps_only_the_stored_custom_thumbnail():
    """A client can keep the asset's own photo, never name a new file."""
    meta = {"custom_thumbnail": "7_16_abcd1234.png", "zillow_url": "x"}
    assert _sanitize_meta(meta, keep="7_16_abcd1234.png") == meta
    assert "custom_thumbnail" not in _sanitize_meta(meta)
    assert "custom_thumbnail" not in _sanitize_meta(meta, keep="7_16_00000000.png")


def test_sanitize_meta_passes_through_non_dicts():
    assert _sanitize_meta(None) is None


# ── Auto-fetched thumbnail URLs are https only ───────────────────────

from app.api.assets import _https_image_url  # noqa: E402


@pytest.mark.parametrize("url, out", [
    ("https://photos.zillowstatic.com/fp/abc-cc_ft_960.jpg", "https://photos.zillowstatic.com/fp/abc-cc_ft_960.jpg"),
    ("https://upload.wikimedia.org/a.jpg?x=1&amp;y=2", "https://upload.wikimedia.org/a.jpg?x=1&y=2"),
    (None, None),
    ("", None),
    ("javascript:alert(1)", None),
    ("JaVaScRiPt:alert(1)", None),
    ("data:image/svg+xml;base64,PHN2Zz4=", None),
    ("http://photos.zillowstatic.com/a.jpg", None),
    ("//photos.zillowstatic.com/a.jpg", None),
    ("https:///no-host.jpg", None),
    ("https://example.com/" + "a" * 2100, None),
])
def test_only_https_urls_reach_the_browser(url, out):
    assert _https_image_url(url) == out
