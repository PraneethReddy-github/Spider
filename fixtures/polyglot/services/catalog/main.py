import os
import sqlite3

import requests
from fastapi import FastAPI

app = FastAPI()
ORDERS = os.environ.get("ORDERS_URL", "http://orders:8080")
db = sqlite3.connect("catalog.db")


@app.get("/items")
def list_items():
    return db.execute("SELECT id, name FROM items").fetchall()


@app.get("/items/{item_id}")
def get_item(item_id: str):
    return {"id": item_id}


@app.post("/items/{item_id}/reserve")
def reserve(item_id: str):
    requests.post(f"{ORDERS}/orders/{item_id}/reserve", timeout=5)
    return {"ok": True}


@app.get("/health")
def health():
    return {"ok": True}
