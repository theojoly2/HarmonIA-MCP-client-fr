# AGENTS.md — HarmonIA-MCP-Client

Ce fichier décrit les conventions de code, l'architecture cible et les points d'attention pour les agents travaillant sur le projet HarmonIA.

---

## Objectif global

Porter HarmonIA vers une architecture propre, découplée et pérenne, tout en conservant l'interface utilisateur et les fonctionnalités exactement identiques.

---

## Architecture backend

```
routers  →  gateways  →  services  →  data_model_utils / MCP
```

- **Routers (`api/routers/`)** : sérialisation HTTP/JSON, validation Pydantic, sécurité (`Depends`). Doivent rester minces. **Seuls les routers** construisent les `HTTPException`, `StreamingResponse` et `Response`.
- **Gateways (`api/gateways/`)** : règles métier, orchestration, mapping entre le monde HTTP et le monde interne. **Aucun import FastAPI/HTTP** ici. Ils lèvent des exceptions métier définies dans `api.exceptions`.
- **Services (`api/services/`)** : accès aux données, au MCP, au LLM, historique, etc. Peuvent lever des exceptions Python standard ou `api.exceptions.*`.
- **`data_model_utils/`** : parsing, transformation, visualisation et export des modèles.
- **Sécurité (`api/security.py`)** : guards d'authentification (cookie + API key Bearer). Les routers et gateways n'implémentent pas eux-mêmes la logique d'auth.
- **Exceptions (`api/exceptions.py`)** : `NotFoundError`, `ValidationError`, `ConflictError`, `ProcessingError`, `AuthenticationError`, `PermissionError`.
- **Erreurs HTTP (`api/utils/errors.py`)** : helper `api_error_payload(...)` + `domain_to_http(...)` pour convertir les exceptions métier en `HTTPException` standardisées.

### Erreurs

Les `HTTPException` doivent renvoyer un payload JSON normalisé :

```python
from api.utils.errors import api_error_payload, raise_api_error, domain_to_http

raise HTTPException(status_code=..., detail=api_error_payload("code_snake_case", "Message lisible."))
```

Pour traduire une exception métier dans un router :

```python
try:
    result = await gateway.some_action()
except Exception as exc:
    raise domain_to_http(exc) from exc
```

Éviter les messages d'erreur bruts (`str(e)`) exposés au client.

---

## Architecture frontend

```
index.html
    → service-locator.js
    → gateways/
    → apps/app-base.js
    → apps/<app>.js (+ sous-modules)
    → controllers/
    → shell.js / window-manager.js / split-manager.js
```

### Conventions

- Chaque application hérite de `AppBase`. `AppBase` fournit :
  - `this.authManager` via `ServiceLocator.get('authManager')`
  - `this.ui` via `ServiceLocator.get('uiHelpers')`
  - `this._scanGlow()` via `ServiceLocator.get('glowEffects')`
  - `this._requireAuth()`
  - `this.setTitle(title)`
- Les applications n'accèdent **pas** directement aux services globaux via `window.*` ; elles utilisent `ServiceLocator.get('...')`.
- Le couplage direct `AssistantApp` ↔ `ModelerApp` est interdit. Utiliser `EventBus` + `AssistantBridge` / `ModelerAssistantBridge`.
- `api-client.js` a été supprimé. Les gateways (`ModelGateway`, `AssistantGateway`, `SearchGateway`, `DocumentGateway`, `AuthGateway`, `ExternalApiGateway`) restent la source de vérité.

### Module JS

- Les sous-modules d'une app sont placés dans `static/js/apps/<app>/` et chargés **avant** l'app principale dans `index.html`.
- Exemple : `modeler/svg-lifecycle.js`, `modeler/edit-dialogs.js`, `modeler/assistant-bridge.js` chargés avant `modeler-app.js`.
- Les modules exportent explicitement via `window.NomDuModule = NomDuModule` pour rester compatibles avec le chargement par balises `<script>`.

### Événements inter-app

Utiliser `EventBus` pour les communications Assistant ↔ Modeler :

- `modeler:reload-svg` — demander le rechargement du SVG côté modeler.
- `modeler:toggle-assistant-split` — basculer le panneau assistant lié au modeler.
- `modeler:update-assistant-toggle` — mettre à jour la visibilité du bouton assistant.
- `assistant:prepare-linked-session` — préparer une session assistant liée au modeler.
- `assistant-split-close` — fermeture du split assistant.

---

## Modifications interdites / à éviter

- Ne pas changer la logique métier existante, surtout dans les tests ou les comportements DOM/transitions SVG.
- Ne pas introduire de dépendances framework côté frontend.
- Ne pas ajouter d'accès directs `window.*` ; les remplacer par `ServiceLocator`.
- Ne pas commiter `.env`, ni les clés API, ni les fichiers de données utilisateur.
- Ne pas importer `HTTPException` / `StreamingResponse` dans les gateways ou services.

---

## Vérifications attendues

Après toute modification de code :

1. **JavaScript :** `node --check` sur les fichiers modifiés.
2. **Python :** `python3 -m py_compile` sur les fichiers Python modifiés.
3. Lancer le serveur localement et vérifier au minimum le démarrage sans exception d'import (`python web_app.py` ou `python -c "from api.main import app"`).

---

## Tests et démarrage

```bash
source venv-client/bin/activate
python -c "from api.main import app"  # vérifie les imports backend
python web_app.py                    # démarre le serveur
```

En l'absence de serveur MCP / Qdrant, le client démarre quand même mais les fonctionnalités MCP échoueront gracieusement.

---

## Style de code

- Python : PEP 8, typage `from __future__ import annotations`, `Optional`/`list` en minuscules quand possible.
- JavaScript : ES2020, classes, `async/await`, éviter les `var`.
- CSS : utiliser Tailwind pour le layout ; les styles spécifiques d'app dans `static/css/apps/<app>.css`.

---

## Points d'attention spécifiques

### Modeler

- Conserver les transitions home → viewer et l'état pan/zoom du SVG.
- Le SVG viewer est géré par `SvgViewerController` (`static/js/controllers/svg-viewer-controller.js`).
- Les dialogues d'édition flottants utilisent `UiUtils.createFloatingWindow`.
- L'export du modèle passe par `ModelGateway.exportAsBlob`.
- Les mutations déclenchent `EventBus.emit('modeler:reload-svg', { instanceId: ... })` au lieu d'appeler `_reloadSvgFromServer()` directement.

### Assistant

- Le streaming SSE est formaté par `api.utils.sse._event`.
- L'orchestrateur de streaming est `api.services.assistant_orchestrator`.
- Les événements SSE spécifiques au frontend sont traités dans `static/js/apps/assistant/event-processor.js`.
- Le typewriter est `static/js/apps/assistant/typewriter.js`.
- Les appels directs `AssistantBridge.notifySvgRefresh` ont été remplacés par `EventBus.emit('modeler:reload-svg', ...)`.

### External API

- Les streams externes sont filtrés et transformés via `api.utils.sse._stream_filtered_events` / `_collect_filtered_events`.
- N'exposer au client externe que les événements `assistant_text`, `tool_start`/`tool_end`, `assistant_done`, `error`.
- La gateway retourne des générateurs bruts ; le router construit le `StreamingResponse`.
