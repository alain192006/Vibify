from pathlib import Path

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles

from app.api.v1 import router as v1_router

app = FastAPI(title="Vibify", description="Gestionnaire de playlists Spotify")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

app.include_router(v1_router.api_v1_router, prefix="/api/v1")


@app.get("/health")
def health():
    return {"status": "ok"}


FRONTEND = Path(__file__).parent.parent.parent / "frontend"

if FRONTEND.exists():
    app.mount("/static", StaticFiles(directory=str(FRONTEND)), name="static")

    @app.get("/")
    def serve_frontend():
        return FileResponse(str(FRONTEND / "index.html"))
