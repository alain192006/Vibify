import secrets

from fastapi import APIRouter, Header, HTTPException
from fastapi.responses import RedirectResponse
from pydantic import BaseModel

from app.services import spotify as sp

router = APIRouter()


@router.get("/login")
def login():
    state = secrets.token_urlsafe(16)
    return RedirectResponse(sp.get_auth_url(state))


@router.get("/callback")
async def callback(code: str = None, error: str = None):
    if error or not code:
        msg = error or "Autorisation refusée"
        return RedirectResponse(f"/#auth_error={msg}")
    try:
        data = await sp.exchange_code(code)
    except Exception as e:
        return RedirectResponse(f"/#auth_error={str(e)}")
    at = data.get("access_token")
    if not at:
        return RedirectResponse(f"/#auth_error=Pas_de_token_dans_la_reponse")
    rt = data.get("refresh_token", "")
    exp = data.get("expires_in", 3600)
    return RedirectResponse(f"/#access_token={at}&refresh_token={rt}&expires_in={exp}")


class RefreshBody(BaseModel):
    refresh_token: str


@router.post("/refresh")
async def refresh(body: RefreshBody):
    try:
        data = await sp.refresh_token(body.refresh_token)
        return data
    except Exception as e:
        raise HTTPException(400, str(e))


@router.get("/me")
async def me(authorization: str = Header(...)):
    token = authorization.removeprefix("Bearer ")
    try:
        user = await sp.get_me(token)
        return {
            "id": user["id"],
            "name": user.get("display_name") or user["id"],
            "email": user.get("email"),
            "image": user["images"][0]["url"] if user.get("images") else None,
        }
    except Exception as e:
        raise HTTPException(400, str(e))
