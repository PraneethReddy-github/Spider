from flask import Blueprint
from flask.views import MethodView

bp = Blueprint("users", __name__, url_prefix="/users")
admin = Blueprint("admin", __name__, url_prefix="/admin")


@bp.route("/")
def list_users():
    return []


@admin.get("/stats")
def stats():
    return {}


class ItemAPI(MethodView):
    def get(self, item_id):
        return {}

    def delete(self, item_id):
        return ""


bp.add_url_rule("/items/<int:item_id>", view_func=ItemAPI.as_view("item"))
