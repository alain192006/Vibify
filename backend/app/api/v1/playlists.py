from fastapi import APIRouter, Header, HTTPException
from pydantic import BaseModel

from app.services import spotify as sp
from app.api.v1.tracks import _format_track

router = APIRouter()


class CreatePlaylistBody(BaseModel):
    name: str
    description: str = ""
    track_uris: list[str] = []


@router.get("/")
async def get_playlists(authorization: str = Header(...)):
    token = authorization.removeprefix("Bearer ")
    try:
        playlists = await sp.get_user_playlists(token)
        return [
            {
                "id": p["id"],
                "name": p["name"],
                "image": (p.get("images") or [{}])[0].get("url"),
                "tracks_total": p["tracks"]["total"],
                "owner": p["owner"]["display_name"],
            }
            for p in playlists
            if p
        ]
    except Exception as e:
        raise HTTPException(400, str(e))


@router.get("/{playlist_id}/tracks")
async def get_playlist_tracks(playlist_id: str, authorization: str = Header(...)):
    token = authorization.removeprefix("Bearer ")
    try:
        tracks = await sp.get_playlist_tracks(token, playlist_id)
        return [_format_track(t) for t in tracks]
    except Exception as e:
        raise HTTPException(400, str(e))


@router.post("/")
async def create_playlist(body: CreatePlaylistBody, authorization: str = Header(...)):
    token = authorization.removeprefix("Bearer ")
    try:
        user = await sp.get_me(token)
        playlist = await sp.create_playlist(token, user["id"], body.name, body.description)
        if body.track_uris:
            await sp.add_tracks(token, playlist["id"], body.track_uris)
        return {
            "id": playlist["id"],
            "name": playlist["name"],
            "url": playlist["external_urls"]["spotify"],
        }
    except Exception as e:
        raise HTTPException(400, str(e))
