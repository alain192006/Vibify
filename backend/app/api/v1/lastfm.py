import httpx
from fastapi import APIRouter, HTTPException

from app.config.settings import settings

router = APIRouter()

LASTFM_API = "https://ws.audioscrobbler.com/2.0/"


async def _lastfm(method: str, params: dict) -> dict:
    async with httpx.AsyncClient() as client:
        r = await client.get(LASTFM_API, params={
            "method": method,
            "api_key": settings.lastfm_api_key,
            "format": "json",
            **params,
        })
        r.raise_for_status()
        data = r.json()
        if "error" in data:
            raise HTTPException(400, data.get("message", "Last.fm error"))
        return data


def _fmt(track: dict, source: str = "") -> dict:
    img = track.get("image", [])
    image_url = next((i["#text"] for i in reversed(img) if i.get("#text")), None)
    return {
        "id": f"lfm_{track.get('mbid') or track.get('name','')}_{track.get('artist',{}).get('name','') if isinstance(track.get('artist'), dict) else track.get('artist','')}",
        "name": track.get("name", ""),
        "artists": [track["artist"]["name"] if isinstance(track.get("artist"), dict) else track.get("artist", "")],
        "album": track.get("album", {}).get("#text", "") if isinstance(track.get("album"), dict) else "",
        "uri": None,
        "duration_ms": int(track.get("duration", 0) or 0) * 1000 or None,
        "image": image_url,
        "preview_url": None,
        "scrobbles": int(track.get("playcount", 0) or 0),
        "source": source,
    }


@router.get("/recent")
async def get_recent(username: str, limit: int = 200):
    try:
        pages, tracks = 1, []
        page = 1
        while len(tracks) < limit and page <= pages:
            data = await _lastfm("user.getrecenttracks", {
                "user": username, "limit": min(200, limit - len(tracks)), "page": page
            })
            rt = data.get("recenttracks", {})
            pages = int(rt.get("@attr", {}).get("totalPages", 1))
            items = rt.get("track", [])
            for t in items:
                if t.get("@attr", {}).get("nowplaying"):
                    continue
                tracks.append(_fmt(t, "recent"))
            page += 1
            if page > 3:
                break
        return tracks
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(400, str(e))


@router.get("/top-tracks")
async def get_top_tracks(username: str, period: str = "overall", limit: int = 100):
    try:
        data = await _lastfm("user.gettoptracks", {"user": username, "period": period, "limit": min(limit, 200)})
        tracks = data.get("toptracks", {}).get("track", [])
        return [_fmt(t, "top") for t in tracks]
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(400, str(e))


@router.get("/top-artists")
async def get_top_artists(username: str, period: str = "overall", limit: int = 20):
    try:
        data = await _lastfm("user.gettopartists", {"user": username, "period": period, "limit": min(limit, 50)})
        artists = data.get("topartists", {}).get("artist", [])
        return [{"name": a.get("name"), "playcount": int(a.get("playcount", 0)), "image": next((i["#text"] for i in reversed(a.get("image", [])) if i.get("#text")), None)} for a in artists]
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(400, str(e))


@router.get("/loved")
async def get_loved(username: str, limit: int = 100):
    try:
        data = await _lastfm("user.getlovedtracks", {"user": username, "limit": min(limit, 200)})
        tracks = data.get("lovedtracks", {}).get("track", [])
        return [_fmt(t, "loved") for t in tracks]
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(400, str(e))
