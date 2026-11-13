from .db import query
from .base import BaseService

class UserService(BaseService):
    async def list(self):
        return await query("select * from users")

    async def create(self, payload):
        self.validate(payload)
        return await query("insert into users ...")
