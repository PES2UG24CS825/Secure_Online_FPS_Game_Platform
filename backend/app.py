import os
from flask import Flask
from flask_cors import CORS
from routes.auth_routes import auth_bp
from routes.game_routes import game_bp

app = Flask(__name__)
app.config["SECRET_KEY"] = os.getenv("FLASK_SECRET_KEY", "dev-only-change-this-secret")
app.config.update(
    SESSION_COOKIE_HTTPONLY=True,
    SESSION_COOKIE_SAMESITE="Lax",
    SESSION_COOKIE_SECURE=False,  # Set True when deployed behind HTTPS
)

CORS(
    app,
    resources={r"/api/*": {"origins": [os.getenv("FRONTEND_ORIGIN", "http://127.0.0.1:5500")]}},
    supports_credentials=True,
)

app.register_blueprint(auth_bp)
app.register_blueprint(game_bp)

@app.get("/api/health")
def health():
    return {"status": "ok"}

if __name__ == "__main__":
    app.run(host="127.0.0.1", port=5000, debug=True)
