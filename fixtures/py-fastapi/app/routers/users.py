from fastapi import APIRouter
from app.services.user_service import UserService
from ..services import db

router = APIRouter()
service = UserService()

@router.get("/users")
async def list_users():
    return await service.list()

@router.post("/users")
async def create_user(payload: dict):
    user = await service.create(payload)
    db.log("created")
    return user
