import os
from pathlib import Path

from fastapi import FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, HTMLResponse
from fastapi.staticfiles import StaticFiles

from api.routers import search, documents, vision, chat


def create_app() -> FastAPI:
    app = FastAPI(title="Recherche Sémantique")

    app.add_middleware(
        CORSMiddleware,
        allow_origins=["*"],
        allow_credentials=True,
        allow_methods=["*"],
        allow_headers=["*"],
    )

    # Launch PlantUML native binary auto-installation in the background.
    try:
        from data_model_utils.plantuml_installer import start_background_install
        start_background_install()
    except Exception as exc:
        print(f"[PlantUML] Could not start auto-installation: {exc}", flush=True)

    app.include_router(search.router)
    app.include_router(documents.router)
    app.include_router(vision.router)
    app.include_router(chat.router)

    static_dir = Path(__file__).resolve().parent.parent / "static"
    app.mount("/static", StaticFiles(directory=static_dir), name="static")

    @app.api_route("/{path:path}", methods=["GET", "POST"])
    async def serve_spa(request: Request, path: str):
        index_path = static_dir / "index.html"
        if index_path.exists():
            return FileResponse(index_path)
        return HTMLResponse("<h1>Frontend not built</h1>", status_code=404)

    return app


app = create_app()
