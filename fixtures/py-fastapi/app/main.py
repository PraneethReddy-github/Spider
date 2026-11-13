from fastapi import FastAPI
from app.routers import users
from .services.db import connect

app = FastAPI()
app.include_router(users.router)

@app.get("/health")
def health():
    return {"ok": True}

@app.on_event("startup")
async def startup():
    await connect()
