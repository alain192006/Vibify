from fastapi import APIRouter

from app.api.v1.auth import router as auth_router
from app.api.v1.playlists import router as playlists_router
from app.api.v1.tracks import router as tracks_router

api_v1_router = APIRouter()


@api_v1_router.get("/health")
def v1_health():
    return {"status": "ok", "version": "v1"}


api_v1_router.include_router(auth_router, prefix="/auth", tags=["auth"])
api_v1_router.include_router(playlists_router, prefix="/playlists", tags=["playlists"])
api_v1_router.include_router(tracks_router, prefix="/tracks", tags=["tracks"])
