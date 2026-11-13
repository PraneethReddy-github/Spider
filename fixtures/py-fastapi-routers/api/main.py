from fastapi import FastAPI
from api.routers.v1 import router as v1_router

app = FastAPI()
app.include_router(v1_router, prefix="/api/v1")


@app.get("/health")
def health():
    return {}
