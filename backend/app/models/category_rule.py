from sqlalchemy import ForeignKey, Index, Integer, String
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.core.database import Base


class CategoryRule(Base):
    __tablename__ = "category_rule"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    user_id: Mapped[int] = mapped_column(ForeignKey("user.id"), nullable=False)
    pattern: Mapped[str] = mapped_column(String(512), nullable=False)
    match_field: Mapped[str] = mapped_column(String(16), default="description")  # description|amount
    category_id: Mapped[int] = mapped_column(ForeignKey("category.id"), nullable=False)
    priority: Mapped[int] = mapped_column(Integer, default=0)
    is_case_sensitive: Mapped[bool] = mapped_column(default=False)

    category: Mapped["Category"] = relationship("Category")

    __table_args__ = (Index("idx_category_rule_user_id", "user_id"),)
