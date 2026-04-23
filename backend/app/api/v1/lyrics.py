import httpx
from fastapi import APIRouter

router = APIRouter()


@router.get("")
async def get_lyrics(artist: str, title: str):
    try:
        async with httpx.AsyncClient(timeout=8) as client:
            r = await client.get(
                f"https://api.lyrics.ovh/v1/{artist}/{title}",
                headers={"User-Agent": "Vibify/1.0"},
            )
            if r.status_code == 200:
                lyrics = r.json().get("lyrics", "").strip()
                return {"lyrics": lyrics or None}
            return {"lyrics": None}
    except Exception:
        return {"lyrics": None}
