from pydantic_settings import BaseSettings


class Settings(BaseSettings):
    spotify_client_id: str = ""
    spotify_client_secret: str = ""
    spotify_redirect_uri: str = "http://127.0.0.1:8000/api/v1/auth/callback"
    lastfm_api_key: str = ""

    model_config = {"env_file": ".env"}


settings = Settings()
