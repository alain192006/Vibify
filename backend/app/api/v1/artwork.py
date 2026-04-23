import httpx
from fastapi import APIRouter

router = APIRouter()


@router.get("")
async def get_artwork(artist: str, title: str):
    try:
        q = f"{artist} {title}"
        async with httpx.AsyncClient(timeout=8) as client:
            r = await client.get(
                "https://itunes.apple.com/search",
                params={"term": q, "entity": "song", "limit": 3, "media": "music"},
                headers={"User-Agent": "Vibify/1.0"},
            )
            if r.status_code == 200:
                for result in r.json().get("results", []):
                    url = result.get("artworkUrl100", "")
                    if url:
                        return {"url": url.replace("100x100bb", "600x600bb")}
        return {"url": None}
    except Exception:
        return {"url": None}
