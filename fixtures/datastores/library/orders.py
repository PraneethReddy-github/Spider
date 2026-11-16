from sqlalchemy import insert, select
from sqlalchemy.orm import Session, declarative_base

Base = declarative_base()


class Order(Base):
    __tablename__ = "orders"


def open_orders(session: Session):
    return session.query(Order).all()


def latest(session: Session):
    return session.execute(select(Order)).scalars()


def place(session: Session, total: int):
    session.execute(insert(Order).values(total=total))
