"""merge_ui_prefs: a dismissed tip stays dismissed whatever copy a client saves."""
from app.api.settings import merge_ui_prefs


def test_stale_copy_does_not_bring_back_a_dismissed_tip():
    stored = {"onboarding": {"status": "completed", "seenTips": ["nav-budgeting"], "completedSteps": ["snapshot"]}}
    stale = {"onboarding": {"status": "completed", "seenTips": [], "completedSteps": []}}
    merged = merge_ui_prefs(stored, stale)
    assert merged["onboarding"]["seenTips"] == ["nav-budgeting"]
    assert merged["onboarding"]["completedSteps"] == ["snapshot"]


def test_new_tips_are_added_and_other_fields_replaced():
    stored = {"sidebarCollapsed": False, "onboarding": {"status": "active", "seenTips": ["a"]}}
    incoming = {"onboarding": {"status": "completed", "seenTips": ["b"]}}
    merged = merge_ui_prefs(stored, incoming)
    assert merged["sidebarCollapsed"] is False
    assert merged["onboarding"]["status"] == "completed"
    assert merged["onboarding"]["seenTips"] == ["b", "a"]


def test_keys_not_sent_are_kept():
    stored = {"onboarding": {"seenTips": ["a"]}, "tableSort": {"t": {"key": "x", "dir": "asc"}}}
    merged = merge_ui_prefs(stored, {"sidebarCollapsed": True})
    assert merged["onboarding"] == {"seenTips": ["a"]}
    assert merged["tableSort"] == {"t": {"key": "x", "dir": "asc"}}
    assert merged["sidebarCollapsed"] is True
