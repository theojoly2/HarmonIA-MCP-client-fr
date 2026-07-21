import uvicorn

if __name__ == "__main__":
    print("=" * 60, flush=True)
    print("Serveur Web SSR (Multi-instances) démarré (Port 8000)", flush=True)
    print("=" * 60, flush=True)
    uvicorn.run("api.main:app", host="0.0.0.0", port=8000, workers=4)
