from fastapi import APIRouter, Header, HTTPException
from pydantic import BaseModel

from app.services import spotify as sp

router = APIRouter()


def _format_track(track: dict) -> dict:
    images = track.get("album", {}).get("images") or []
    return {
        "id": track.get("id"),
        "name": track.get("name"),
        "artists": [a["name"] for a in track.get("artists", [])],
        "album": track.get("album", {}).get("name"),
        "uri": track.get("uri"),
        "duration_ms": track.get("duration_ms"),
        "image": images[0]["url"] if images else None,
    }


@router.get("/liked")
async def get_liked(authorization: str = Header(...)):
    token = authorization.removeprefix("Bearer ")
    try:
        tracks = await sp.get_liked_tracks(token)
        return [_format_track(t) for t in tracks]
    except Exception as e:
        raise HTTPException(400, str(e))


class EnrichBody(BaseModel):
    ids: list[str]


@router.post("/audio-features")
async def audio_features(body: EnrichBody):
    try:
        features = await sp.get_audio_features(body.ids)
        return [
            {
                "id": f["id"],
                "energy": round(f.get("energy", 0), 3),
                "danceability": round(f.get("danceability", 0), 3),
                "valence": round(f.get("valence", 0), 3),
                "tempo": round(f.get("tempo", 0)),
            }
            for f in features if f and f.get("id")
        ]
    except Exception:
        return []


@router.post("/enrich")
async def enrich_tracks(body: EnrichBody):
    try:
        tracks = await sp.get_tracks_details(body.ids)
        result = []
        track_map = {t["id"]: t for t in tracks if t.get("id")}
        for tid in body.ids:
            t = track_map.get(tid)
            uri = f"spotify:track:{tid}"
            if t:
                images = t.get("album", {}).get("images") or []
                result.append({
                    "id": tid,
                    "uri": t.get("uri") or uri,
                    "image": images[0]["url"] if images else None,
                    "duration_ms": t.get("duration_ms"),
                    "preview_url": t.get("preview_url"),
                })
            else:
                result.append({"id": tid, "uri": uri, "image": None, "duration_ms": None})
        return result
    except Exception:
        return []
