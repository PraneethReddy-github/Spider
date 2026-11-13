from .models import Cart
from .util import traced


class Store:
    def __init__(self, cart: Cart):
        self.cart = cart

    @traced
    def checkout(self) -> Cart:
        self.cart.add(None)
        return self.cart
