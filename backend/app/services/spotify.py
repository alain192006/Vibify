import base64
from urllib.parse import urlencode

import httpx

from app.config.settings import settings

SPOTIFY_AUTH_URL = "https://accounts.spotify.com/authorize"
SPOTIFY_TOKEN_URL = "https://accounts.spotify.com/api/token"
SPOTIFY_API = "https://api.spotify.com/v1"

SCOPES = " ".join([
    "playlist-read-private",
    "playlist-read-collaborative",
    "playlist-modify-private",
    "playlist-modify-public",
    "user-library-read",
    "user-read-private",
    "user-read-email",
])


def get_auth_url(state: str) -> str:
    params = {
        "client_id": settings.spotify_client_id,
        "response_type": "code",
        "redirect_uri": settings.spotify_redirect_uri,
        "scope": SCOPES,
        "state": state,
        "show_dialog": "true",
    }
    return f"{SPOTIFY_AUTH_URL}?{urlencode(params)}"


def _basic_auth() -> str:
    raw = f"{settings.spotify_client_id}:{settings.spotify_client_secret}"
    return "Basic " + base64.b64encode(raw.encode()).decode()


async def exchange_code(code: str) -> dict:
    async with httpx.AsyncClient() as client:
        r = await client.post(
            SPOTIFY_TOKEN_URL,
            headers={"Authorization": _basic_auth()},
            data={
                "grant_type": "authorization_code",
                "code": code,
                "redirect_uri": settings.spotify_redirect_uri,
            },
        )
        r.raise_for_status()
        return r.json()


async def refresh_token(token: str) -> dict:
    async with httpx.AsyncClient() as client:
        r = await client.post(
            SPOTIFY_TOKEN_URL,
            headers={"Authorization": _basic_auth()},
            data={"grant_type": "refresh_token", "refresh_token": token},
        )
        r.raise_for_status()
        return r.json()


async def get_me(access_token: str) -> dict:
    async with httpx.AsyncClient() as client:
        r = await client.get(
            f"{SPOTIFY_API}/me",
            headers={"Authorization": f"Bearer {access_token}"},
        )
        r.raise_for_status()
        return r.json()


async def get_user_playlists(access_token: str) -> list[dict]:
    items, url = [], f"{SPOTIFY_API}/me/playlists"
    headers = {"Authorization": f"Bearer {access_token}"}
    async with httpx.AsyncClient() as client:
        while url:
            r = await client.get(url, headers=headers, params={"limit": 50})
            if not r.is_success:
                try:
                    detail = r.json().get("error", {}).get("message", r.text)
                except Exception:
                    detail = r.text
                raise Exception(f"Spotify {r.status_code}: {detail}")
            data = r.json()
            items.extend(data["items"])
            url = data.get("next")
    return items


async def get_playlist_tracks(access_token: str, playlist_id: str) -> list[dict]:
    items, url = [], f"{SPOTIFY_API}/playlists/{playlist_id}/tracks"
    headers = {"Authorization": f"Bearer {access_token}"}
    async with httpx.AsyncClient() as client:
        while url:
            r = await client.get(url, headers=headers, params={"limit": 100})
            r.raise_for_status()
            data = r.json()
            items.extend(item["track"] for item in data["items"] if item.get("track"))
            url = data.get("next")
    return items


async def get_liked_tracks(access_token: str) -> list[dict]:
    items, url = [], f"{SPOTIFY_API}/me/tracks"
    headers = {"Authorization": f"Bearer {access_token}"}
    async with httpx.AsyncClient() as client:
        while url:
            r = await client.get(url, headers=headers, params={"limit": 50})
            if not r.is_success:
                try:
                    detail = r.json().get("error", {}).get("message", r.text)
                except Exception:
                    detail = r.text
                raise Exception(f"Spotify {r.status_code}: {detail}")
            data = r.json()
            items.extend(item["track"] for item in data["items"] if item.get("track"))
            url = data.get("next")
    return items


async def create_playlist(access_token: str, user_id: str, name: str, description: str) -> dict:
    async with httpx.AsyncClient() as client:
        r = await client.post(
            f"{SPOTIFY_API}/users/{user_id}/playlists",
            headers={
                "Authorization": f"Bearer {access_token}",
                "Content-Type": "application/json",
            },
            json={"name": name, "description": description, "public": False},
        )
        r.raise_for_status()
        return r.json()


async def get_client_token() -> str:
    async with httpx.AsyncClient() as client:
        r = await client.post(
            SPOTIFY_TOKEN_URL,
            headers={"Authorization": _basic_auth()},
            data={"grant_type": "client_credentials"},
        )
        r.raise_for_status()
        return r.json()["access_token"]


async def get_tracks_details(track_ids: list[str]) -> list[dict]:
    if not track_ids:
        return []
    token = await get_client_token()
    results = []
    async with httpx.AsyncClient() as client:
        for i in range(0, len(track_ids), 50):
            batch = track_ids[i:i + 50]
            r = await client.get(
                f"{SPOTIFY_API}/tracks",
                headers={"Authorization": f"Bearer {token}"},
                params={"ids": ",".join(batch)},
            )
            if r.is_success:
                results.extend(t for t in (r.json().get("tracks") or []) if t)
            # On skip silently les erreurs (403 Premium, etc.)
    return results


async def get_audio_features(track_ids: list[str]) -> list[dict]:
    if not track_ids:
        return []
    token = await get_client_token()
    results = []
    async with httpx.AsyncClient() as client:
        for i in range(0, len(track_ids), 100):
            batch = track_ids[i:i + 100]
            r = await client.get(
                f"{SPOTIFY_API}/audio-features",
                headers={"Authorization": f"Bearer {token}"},
                params={"ids": ",".join(batch)},
            )
            if r.is_success:
                results.extend(f for f in (r.json().get("audio_features") or []) if f)
    return results


async def add_tracks(access_token: str, playlist_id: str, uris: list[str]) -> None:
    headers = {
        "Authorization": f"Bearer {access_token}",
        "Content-Type": "application/json",
    }
    async with httpx.AsyncClient() as client:
        for i in range(0, len(uris), 100):
            r = await client.post(
                f"{SPOTIFY_API}/playlists/{playlist_id}/tracks",
                headers=headers,
                json={"uris": uris[i : i + 100]},
            )
            r.raise_for_status()
