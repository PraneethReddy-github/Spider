class BaseService:
    def validate(self, payload):
        if not payload:
            raise ValueError("empty")
