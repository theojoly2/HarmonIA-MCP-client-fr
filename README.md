# SemantiQ-MCP-Client

Client web de l'assistant de modélisation sémantique **SemantiQ**. Il fournit une interface utilisateur monopage (SPA) avec FastAPI en backend et un frontend JavaScript vanilla.

---

## Interface utilisateur

L'interface web se présente comme une application monopage (SPA) organisée autour de **trois outils principaux**, accessibles depuis la barre de navigation :

| Outil | Onglet | Description |
|---|---|---|
| **Explorateur de modèles** | `Explorer` | Recherche sémantique dans le corpus indexé. Permet de trouver des concepts, classes, propriétés et définitions issus de standards (SEMIC, schema.data.gouv.fr, Schema.org, LOV, etc.) et de textes juridiques. Les résultats peuvent être filtrés par tags/source et servent de base au RAG de l'assistant. |
| **Concepteur de modèles** | `Créer/Modifier` | Environnement de modélisation sémantique. Permet d'importer un modèle (XMI/UML, OWL/TTL, JSON, SQL, texte), de le visualiser sous forme de diagramme PlantUML, de l'éditer (ajouter/modifier classes, attributs et relations) et de l'exporter en XMI ou TTL. |
| **Assistant de modélisation** | `Analyser/Fusionner/Optimiser` | Chat conversationnel intelligent. L'agent LLM peut analyser le modèle courant, suggérer des améliorations, fusionner des concepts, vérifier la conformité au guide SEMIC et appeler les outils du serveur MCP en arrière-plan. |

---

## Fonctionnalités transversales

| Fonction | Description |
|---|---|
| **API externe** | Endpoint `/api/external/v1` pour interagir programmatiquement avec l'assistant via des clés API Bearer. |
| **Authentification** | Inscription / connexion avec mots de passe hachés (bcrypt). |
| **Historique** | Sauvegarde des conversations de l'assistant et des recherches documentaires. |
| **Visualisation** | Génération de diagrammes PlantUML et rendu SVG/PNG des modèles. |

---

## Structure du projet

```
SemantiQ-MCP-client-fr/
│
├── web_app.py                  # Point d'entrée Uvicorn (4 workers, port 8000)
│
├── api/
│   ├── main.py                 # Application FastAPI et routage
│   ├── dependencies.py         # Dépendances communes (auth, DB, etc.)
│   ├── routers/
│   │   ├── auth.py             # Inscription / connexion
│   │   ├── models.py           # Upload / gestion des modèles
│   │   ├── search.py           # Recherche vectorielle
│   │   ├── documents.py        # Récupération des documents indexés
│   │   ├── modeler.py          # Modélisation interactive
│   │   ├── chat.py             # Chat classique
│   │   ├── assistant.py        # Assistant conversationnel MCP
│   │   ├── searches.py         # Historique de recherche
│   │   ├── external_api.py     # API externe programmatique
│   │   └── external_api_keys.py # Gestion des clés API
│   └── services/
│       ├── auth_service.py
│       ├── user_store.py
│       ├── model_store.py
│       ├── mcp_service.py
│       ├── llm_service.py
│       ├── assistant_history.py
│       ├── search_history_store.py
│       ├── api_key_store.py
│       └── assistant_mcp_client.py
│
├── data_model_utils/           # Parsing / import / export / visualisation des modèles
│   ├── import_xml.py
│   ├── import_ttl.py
│   ├── import_json.py
│   ├── import_sql.py
│   ├── import_text.py
│   ├── export_xml.py
│   ├── export_ttl.py
│   ├── visualisation.py
│   └── plantuml_installer.py
│
├── static/                     # Frontend SPA (HTML, CSS, JS)
│   ├── index.html
│   ├── css/
│   └── js/
│       ├── api-client.js
│       ├── shell.js
│       ├── auth-modal.js
│       └── apps/
│           ├── search-app.js
│           ├── modeler-app.js
│           ├── chat-app.js
│           └── assistant-app.js
│
├── data/                       # Base SQLite et fichiers de session
│   ├── users.db
│   └── assistant_histories/
│
├── .env                        # Variables d'environnement (non commité)
├── .env.sample                 # Exemple de configuration
└── requirements.txt
```

---

## Installation

### 1. Cloner le dépôt

```bash
git clone <url-du-depot>
cd SemantiQ-MCP-client-fr
```

### 2. Créer l'environnement virtuel

```bash
python -m venv venv-client
source venv-client/bin/activate  # Windows : venv-client\Scripts\activate
```

### 3. Installer les dépendances

```bash
pip install -r requirements.txt
```

### 4. Configurer les variables d'environnement

```bash
cp .env.sample .env
# Éditer .env avec vos URLs et clés API
```

Variables principales :

| Variable | Description |
|---|---|
| `LLM_API_KEY` / `URL_LLM_API` / `LLM_MODEL` | API LLM compatible OpenAI utilisée par l'assistant et le chat |
| `MCP_SERVER_URL` | URL du serveur MCP SemantiQ (par défaut `http://127.0.0.1:8001/mcp`) |
| `PLANTUML_*` | Options d'installation / rendering de PlantUML (optionnel) |

---

## Lancement du client

```bash
source venv-client/bin/activate
python web_app.py
```

L'application est accessible sur `http://localhost:8000`.

---

## Prérequis côté serveur

Le client web dépend du serveur MCP (`SemantiQ-MCP-server-fr`). Avant de lancer le client, assure-toi que les étapes suivantes ont été réalisées côté serveur :

1. Qdrant est démarré (`docker-compose up -d` dans `SemantiQ-MCP-server-fr`).
2. Les documents ont été indexés une fois (`python tools/index_search/load_documents/load.py`).
3. Le serveur MCP est lancé (`python -m server`).

> L'indexation n'est à faire **qu'une seule fois** tant que le corpus de documents ne change pas. Pas besoin de la relancer à chaque démarrage.

## Lancement du client (en dev)

```bash
cd SemantiQ-MCP-client-fr
source venv-client/bin/activate
python web_app.py
```

---

## Sécurité

- Ne jamais commiter `.env` ni les clés API.
- Les mots de passe utilisateurs sont **hachés avec bcrypt** (salt unique par mot de passe).
- Les clés API Bearer générées sont stockées sous forme de hash ; seule la clé en clair est affichée lors de la création.
- En production : forcer HTTPS, chiffrer la base SQLite et les modèles au repos, auditer les routers.
