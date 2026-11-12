from sqlalchemy import ForeignKey, Integer, String, Text
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.core.database import Base


class UserSettings(Base):
    __tablename__ = "user_settings"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    user_id: Mapped[int] = mapped_column(ForeignKey("user.id"), unique=True, nullable=False)

    # Appearance
    # The mode (light|dark|gray|system) and theme id (frontend lib/themes.ts)
    # the user last picked. NULL until they pick one: a stored default would
    # read as a choice made on another device and override what this device
    # shows (store/theme.ts, hydrateFromServer), so a dark-mode Mac following
    # the system turned light on the first page with the sidebar.
    theme: Mapped[str | None] = mapped_column(String(16), nullable=True)
    theme_variant: Mapped[str | None] = mapped_column(String(32), nullable=True)

    # Investments grid column order (JSON array of column keys)
    holdings_column_order: Mapped[str | None] = mapped_column(Text, nullable=True)

    # Cross-device UI preferences (JSON object): remembered date-range selections,
    # sidebar collapsed state, etc. Free-form so the frontend can grow it without
    # a schema change. See frontend store/uiPrefs.ts.
    ui_prefs: Mapped[str | None] = mapped_column(Text, nullable=True)

    user: Mapped["User"] = relationship("User", back_populates="settings")
