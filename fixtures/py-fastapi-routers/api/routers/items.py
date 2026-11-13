from fastapi import APIRouter

router = APIRouter(prefix="/items")


@router.get("/")
async def list_items():
    return []


@router.get("/{item_id}")
async def get_item(item_id: int):
    return {}
