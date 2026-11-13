from shop.core import *
from shop.core import Item


def build(cart: Cart) -> Store:
    return Store(cart)


def run():
    store = build(Cart())
    cart = store.checkout()
    cart.first()
    Item("x")
