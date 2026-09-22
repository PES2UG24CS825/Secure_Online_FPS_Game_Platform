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

allowed_origins = [
    "http://127.0.0.1:5500",
    "http://127.0.0.1:3000",
    "http://localhost:5500",
    "http://localhost:3000",
    "http://localhost:8080",
]
frontend_origin = os.getenv("FRONTEND_ORIGIN")
if frontend_origin:
    allowed_origins.append(frontend_origin)

CORS(
    app,
    resources={r"/api/*": {"origins": allowed_origins}},
    supports_credentials=True,
    allow_headers=["Content-Type", "Authorization"],
    methods=["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
)

app.register_blueprint(auth_bp)
app.register_blueprint(game_bp)

@app.get("/api/health")
def health():
    return {"status": "ok"}

if __name__ == "__main__":
    app.run(host="127.0.0.1", port=5000, debug=True)
