from flask import Flask
from .views import bp, admin

app = Flask(__name__)
app.register_blueprint(bp, url_prefix="/api/v1/users")
app.register_blueprint(admin)


@app.route("/health")
def health():
    return "ok"
