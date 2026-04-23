from fastapi import APIRouter

from app.api.v1.artwork import router as artwork_router
from app.api.v1.auth import router as auth_router
from app.api.v1.lastfm import router as lastfm_router
from app.api.v1.lyrics import router as lyrics_router
from app.api.v1.playlists import router as playlists_router
from app.api.v1.tracks import router as tracks_router

api_v1_router = APIRouter()


@api_v1_router.get("/health")
def v1_health():
    return {"status": "ok", "version": "v1"}


api_v1_router.include_router(artwork_router, prefix="/artwork", tags=["artwork"])
api_v1_router.include_router(auth_router, prefix="/auth", tags=["auth"])
api_v1_router.include_router(lastfm_router, prefix="/lastfm", tags=["lastfm"])
api_v1_router.include_router(lyrics_router, prefix="/lyrics", tags=["lyrics"])
api_v1_router.include_router(playlists_router, prefix="/playlists", tags=["playlists"])
api_v1_router.include_router(tracks_router, prefix="/tracks", tags=["tracks"])
