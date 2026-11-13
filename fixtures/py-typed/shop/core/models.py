from dataclasses import dataclass
from typing import Optional


@dataclass
class Item:
    name: str


class Cart:
    items: list[Item]
    latest: "Item"

    def add(self, item: Item) -> None:
        pass

    def first(self) -> Optional[Item]:
        return None
