from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy import select, update
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from ..database import get_db
from ..dependencies import AuthContext, current_auth, require_csrf
from ..models import Book, BookCategory
from ..schemas import BookCategoryInput, BookCategoryOut


router = APIRouter(prefix="/api/book-categories", tags=["book-categories"])


def _owned_category(db: Session, user_id: str, category_id: str) -> BookCategory:
    category = db.scalar(
        select(BookCategory).where(BookCategory.id == category_id, BookCategory.user_id == user_id)
    )
    if category is None:
        raise HTTPException(404, "book category not found")
    return category


@router.get("", response_model=list[BookCategoryOut])
def list_book_categories(
    auth: AuthContext = Depends(current_auth), db: Session = Depends(get_db)
) -> list[BookCategory]:
    return list(
        db.scalars(
            select(BookCategory)
            .where(BookCategory.user_id == auth.user.id)
            .order_by(BookCategory.normalized_name, BookCategory.created_at)
        ).all()
    )


@router.post("", response_model=BookCategoryOut, status_code=201)
def create_book_category(
    payload: BookCategoryInput,
    auth: AuthContext = Depends(require_csrf),
    db: Session = Depends(get_db),
) -> BookCategory:
    category = BookCategory(
        user_id=auth.user.id,
        name=payload.name,
        normalized_name=payload.name.casefold(),
    )
    db.add(category)
    try:
        db.commit()
    except IntegrityError:
        db.rollback()
        raise HTTPException(409, "book category name already exists")
    db.refresh(category)
    return category


@router.patch("/{category_id}", response_model=BookCategoryOut)
def rename_book_category(
    category_id: str,
    payload: BookCategoryInput,
    auth: AuthContext = Depends(require_csrf),
    db: Session = Depends(get_db),
) -> BookCategory:
    category = _owned_category(db, auth.user.id, category_id)
    category.name = payload.name
    category.normalized_name = payload.name.casefold()
    try:
        db.commit()
    except IntegrityError:
        db.rollback()
        raise HTTPException(409, "book category name already exists")
    db.refresh(category)
    return category


@router.delete("/{category_id}", status_code=204)
def delete_book_category(
    category_id: str,
    auth: AuthContext = Depends(require_csrf),
    db: Session = Depends(get_db),
) -> None:
    category = _owned_category(db, auth.user.id, category_id)
    db.execute(
        update(Book)
        .where(Book.user_id == auth.user.id, Book.category_id == category.id)
        .values(category_id=None)
    )
    db.delete(category)
    db.commit()
