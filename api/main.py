import os
import urllib.parse
from pathlib import Path

from fastapi import FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, HTMLResponse
from fastapi.staticfiles import StaticFiles

from api.routers import search, documents, modeler, chat, auth, models, searches, assistant, external_api, external_api_keys


from api.services.user_store import init_db


def create_app() -> FastAPI:
    app = FastAPI(title="HarmonIA")

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

    init_db()

    app.include_router(auth.router)
    app.include_router(models.router)
    app.include_router(searches.router)
    app.include_router(search.router)
    app.include_router(documents.router)
    app.include_router(modeler.router)
    app.include_router(chat.router)
    app.include_router(assistant.router)
    app.include_router(external_api.router)
    app.include_router(external_api_keys.router)

    static_dir = Path(__file__).resolve().parent.parent / "static"
    app.mount("/static", StaticFiles(directory=static_dir), name="static")

    @app.api_route("/{path:path}", methods=["GET", "POST"])
    async def serve_spa(request: Request, path: str):
        download_id = request.query_params.get("download")
        if download_id:
            from api.services.mcp_service import fetch_document_file
            from fastapi.responses import Response as FastAPIResponse, HTMLResponse as FastAPIHTMLResponse
            import base64

            data = await fetch_document_file(download_id)
            if not data.get("success"):
                return FastAPIHTMLResponse(f"<h3>Erreur de récupération: {data.get('error')}</h3>", status_code=404)
            b64_str = data["file_base64"]
            filename = data.get("filename", "document")
            ext = data.get("extension", "").lower()
            file_bytes = base64.b64decode(b64_str)
            mime_type = "text/plain; charset=utf-8"
            if ext == ".pdf":
                mime_type = "application/pdf"
            elif ext in [".html", ".htm"]:
                mime_type = "text/html; charset=utf-8"
            elif ext == ".json":
                mime_type = "application/json; charset=utf-8"
            safe_filename = urllib.parse.quote(filename)
            return FastAPIResponse(
                content=file_bytes,
                media_type=mime_type,
                headers={"Content-Disposition": f"inline; filename*=utf-8''{safe_filename}"}
            )

        index_path = static_dir / "index.html"
        if index_path.exists():
            return FileResponse(index_path)
        return HTMLResponse("<h1>Frontend not built</h1>", status_code=404)

    return app


app = create_app()
