/**
 * ApiDocsManager
 * Modale d'aide/documentations de l'API externe.
 */

const ApiDocsManager = (() => {
    let modal = null;

    function show() {
        if (!modal) {
            modal = new ApiDocsModal();
        }
        modal.open();
    }

    return { show };
})();

window.ApiDocsManager = ApiDocsManager;


class ApiDocsModal {
    constructor() {
        this.overlay = document.createElement("div");
        this.overlay.className = "auth-overlay hidden";
        this.overlay.innerHTML = this._buildHtml();
        document.body.appendChild(this.overlay);
        this._bindEvents();
    }

    _buildHtml() {
        return `
            <div class="auth-modal api-docs-modal" data-mode="api-docs">
                <div class="auth-modal-header">
                    <h2 class="auth-modal-title">Documentation API externe</h2>
                    <button type="button" class="auth-modal-close" aria-label="Fermer">
                        <svg class="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M6 18L18 6M6 6l12 12"></path></svg>
                    </button>
                </div>
                <div class="auth-modal-body api-docs-body">
                    <p class="api-docs-intro">Base URL : <code>/api/external/v1</code>. Authentification : header <code>Authorization: Bearer {votre_clé_api}</code>.</p>

                    <h4>0. Authentification et création d'une clé API</h4>
                    <p>Pour obtenir une clé API il faut d'abord avoir un compte et une session web. Toutes les routes d'authentification sont sous <code>/api/auth</code>.</p>

                    <h5>Créer un compte</h5>
                    <pre><code>curl -X POST https://{serveur}/api/auth/register \\
  -H "Content-Type: application/json" \\
  -d '{"username": "{nom_utilisateur}", "password": "{mot_de_passe}"}' \\
  -c session.txt</code></pre>

                    <h5>Se connecter</h5>
                    <pre><code>curl -X POST https://{serveur}/api/auth/login \\
  -H "Content-Type: application/json" \\
  -d '{"username": "{nom_utilisateur}", "password": "{mot_de_passe}"}' \\
  -c session.txt -b session.txt</code></pre>

                    <h5>Créer une clé API</h5>
                    <pre><code>curl -X POST https://{serveur}/api/external/v1/keys \\
  -H "Content-Type: application/json" \\
  -b session.txt \\
  -d '{"name": "{nom_de_la_clé}"}'</code></pre>
                    <p>La réponse contient la clé en clair : <code>{"id": 1, "key": "sk_...", "name": "...", "created_at": "..."}</code>. Copiez-la immédiatement, elle n'est affichée qu'une seule fois.</p>

                    <h5>Utiliser la clé API</h5>
                    <p>Une fois la clé obtenue, vous pouvez appeler toutes les routes externes sans cookie de session :</p>
                    <pre><code>curl https://{serveur}/api/external/v1/conversations \\
  -H "Authorization: Bearer {votre_clé_api}"</code></pre>

                    <h5>Révoquer une clé API</h5>
                    <pre><code>curl -X DELETE https://{serveur}/api/external/v1/keys/{key_id} \\
  -H "Authorization: Bearer {votre_clé_api}"</code></pre>
                    <p>Vous pouvez aussi révoquer une clé avec la session web : <code>DELETE /api/external/v1/keys/{key_id}</code> avec le cookie de session.</p>

                    <h4>1. Créer une conversation</h4>
                    <pre><code>curl -X POST https://{serveur}/api/external/v1/conversations \\
  -H "Authorization: Bearer {votre_clé_api}" \\
  -H "Content-Type: application/json" \\
  -d '{"title": "{titre}"}'</code></pre>
                    <p>Réponse : <code>{"conversation_id": "{id}", "title": "...", "created_at": "..."}</code></p>

                    <h4>2. Lister les conversations</h4>
                    <pre><code>curl https://{serveur}/api/external/v1/conversations \\
  -H "Authorization: Bearer {votre_clé_api}"</code></pre>

                    <h4>3. Supprimer une conversation</h4>
                    <pre><code>curl -X DELETE https://{serveur}/api/external/v1/conversations/{conversation_id} \\
  -H "Authorization: Bearer {votre_clé_api}"</code></pre>

                    <h4>4. Importer un modèle (fichier)</h4>
                    <pre><code>curl -X POST https://{serveur}/api/external/v1/conversations/{conversation_id}/import \\
  -H "Authorization: Bearer {votre_clé_api}" \\
  -F "file=@/chemin/vers/{fichier}.json" \\
  -F "name={nom_affiché}"</code></pre>
                    <p>Formats acceptés : XMI/XML, TTL, JSON, SQL, texte.</p>

                    <h4>5. Importer depuis un document indexé</h4>
                    <pre><code>curl -X POST https://{serveur}/api/external/v1/conversations/{conversation_id}/import-from-document \\
  -H "Authorization: Bearer {votre_clé_api}" \\
  -H "Content-Type: application/json" \\
  -d '{"doc_id": "{id_du_document}"}'</code></pre>

                    <h4>6. Chat</h4>
                    <h5>Mode non-stream</h5>
                    <pre><code>curl -X POST https://{serveur}/api/external/v1/conversations/{conversation_id}/chat \\
  -H "Authorization: Bearer {votre_clé_api}" \\
  -H "Content-Type: application/json" \\
  -d '{"message": "{votre_message}", "stream": false}'</code></pre>
                    <h5>Mode stream (SSE)</h5>
                    <pre><code>curl -X POST https://{serveur}/api/external/v1/conversations/{conversation_id}/chat \\
  -H "Authorization: Bearer {votre_clé_api}" \\
  -H "Content-Type: application/json" \\
  -H "Accept: text/event-stream" \\
  -d '{"message": "{votre_message}", "stream": true}'</code></pre>

                    <h4>7. Exporter un modèle</h4>
                    <pre><code>curl -X GET "https://{serveur}/api/external/v1/models/{model_name}/export?format={xmi|ttl|svg|png}" \\
  -H "Authorization: Bearer {votre_clé_api}" \\
  --output "{model_name}.{format}"</code></pre>

                    <h4>Workflow complet (copier-coller)</h4>
                    <pre><code># Variables
API_KEY="{votre_clé_api}"
SERVER="https://{serveur}"

# 1. Créer la conversation
CONV=$(curl -s -X POST "$SERVER/api/external/v1/conversations" \\
  -H "Authorization: Bearer $API_KEY" \\
  -H "Content-Type: application/json" \\
  -d '{"title":"Mon modèle"}' | python3 -c "import sys,json; print(json.load(sys.stdin)['conversation_id'])")

# 2. Importer le modèle
curl -X POST "$SERVER/api/external/v1/conversations/$CONV/import" \\
  -H "Authorization: Bearer $API_KEY" \\
  -F "file=@model.json"

# 3. Discuter
curl -X POST "$SERVER/api/external/v1/conversations/$CONV/chat" \\
  -H "Authorization: Bearer $API_KEY" \\
  -H "Content-Type: application/json" \\
  -d '{"message":"Ajoute une classe Personne", "stream": true}'</code></pre>
                </div>
            </div>
        `;
    }

    _bindEvents() {
        const closeBtn = this.overlay.querySelector(".auth-modal-close");
        if (closeBtn) {
            closeBtn.addEventListener("click", () => this.close());
        }
        this.overlay.addEventListener("click", (e) => {
            if (e.target === this.overlay) this.close();
        });
    }

    open() {
        this.overlay.classList.remove("hidden");
    }

    close() {
        this.overlay.classList.add("hidden");
    }
}

window.ApiDocsModal = ApiDocsModal;
