/**
 * ApiKeysManager
 * Modale de gestion des clés API externe (création / liste / révocation).
 */

const ApiKeysManager = (() => {
    let modal = null;

    async function listKeys() {
        const res = await fetch("api/external/v1/keys", { credentials: "same-origin" });
        if (!res.ok) {
            const data = await res.json().catch(() => ({}));
            throw new Error(data.detail || `Erreur ${res.status}`);
        }
        return res.json();
    }

    async function createKey(name) {
        const res = await fetch("api/external/v1/keys", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            credentials: "same-origin",
            body: JSON.stringify({ name: name || undefined }),
        });
        if (!res.ok) {
            const data = await res.json().catch(() => ({}));
            throw new Error(data.detail || `Erreur ${res.status}`);
        }
        return res.json();
    }

    async function revokeKey(keyId) {
        const res = await fetch(`api/external/v1/keys/${keyId}`, {
            method: "DELETE",
            credentials: "same-origin",
        });
        if (!res.ok) {
            const data = await res.json().catch(() => ({}));
            throw new Error(data.detail || `Erreur ${res.status}`);
        }
        return res.json();
    }

    function show() {
        if (!modal) {
            modal = new ApiKeysModal();
        }
        modal.open();
    }

    return {
        show,
        listKeys,
        createKey,
        revokeKey,
    };
})();

window.ApiKeysManager = ApiKeysManager;


class ApiKeysModal {
    constructor() {
        this.overlay = document.createElement("div");
        this.overlay.className = "auth-overlay hidden";
        this.overlay.innerHTML = this._buildHtml();
        document.body.appendChild(this.overlay);
        this._bindEvents();
        this._newKey = null;
    }

    _buildHtml() {
        return `
            <div class="auth-modal" data-mode="api-keys">
                <div class="auth-modal-header">
                    <h2 class="auth-modal-title">Clés API</h2>
                    <p class="auth-modal-subtitle">Gérez les clés d'accès à l'API externe.</p>
                    <button type="button" class="auth-modal-close" aria-label="Fermer">
                        <svg class="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M6 18L18 6M6 6l12 12"></path></svg>
                    </button>
                </div>
                <div class="auth-modal-body">
                    <div class="api-keys-new hidden" id="api-keys-new-block">
                        <div class="api-keys-new-label">Nouvelle clé (affichée une seule fois)</div>
                        <div class="api-keys-new-value" id="api-keys-new-value"></div>
                        <button type="button" class="api-keys-copy" id="api-keys-copy">Copier</button>
                    </div>
                    <div class="api-keys-create">
                        <input type="text" id="api-key-name" class="api-key-name-input" placeholder="Nom de la clé (optionnel)" maxlength="64">
                        <button type="button" class="api-keys-add" id="api-keys-add">Créer une clé</button>
                    </div>
                    <div class="api-keys-list" id="api-keys-list"></div>
                </div>
            </div>
        `;
    }

    _bindEvents() {
        const closeBtn = this.overlay.querySelector(".auth-modal-close");
        if (closeBtn) {
            closeBtn.addEventListener("click", () => this.close());
        }

        const addBtn = this.overlay.querySelector("#api-keys-add");
        const nameInput = this.overlay.querySelector("#api-key-name");
        addBtn?.addEventListener("click", async () => {
            const name = nameInput.value.trim();
            try {
                addBtn.disabled = true;
                const data = await ApiKeysManager.createKey(name);
                this._showNewKey(data.key);
                nameInput.value = "";
                await this._loadKeys();
            } catch (err) {
                console.error("Create API key error", err);
                alert(err.message || "Impossible de créer la clé.");
            } finally {
                addBtn.disabled = false;
            }
        });

        const copyBtn = this.overlay.querySelector("#api-keys-copy");
        copyBtn?.addEventListener("click", () => {
            if (!this._newKey) return;
            navigator.clipboard?.writeText(this._newKey).then(() => {
                copyBtn.textContent = "Copié !";
                setTimeout(() => (copyBtn.textContent = "Copier"), 1500);
            });
        });

        const list = this.overlay.querySelector("#api-keys-list");
        list?.addEventListener("click", async (e) => {
            const revokeBtn = e.target.closest("[data-action='revoke']");
            if (!revokeBtn) return;
            const keyId = revokeBtn.dataset.keyId;
            if (!keyId) return;
            if (!confirm("Révoquer cette clé ? Les applications l'utilisant ne pourront plus accéder à l'API.")) return;
            try {
                await ApiKeysManager.revokeKey(keyId);
                await this._loadKeys();
            } catch (err) {
                console.error("Revoke API key error", err);
                alert(err.message || "Impossible de révoquer la clé.");
            }
        });
    }

    _showNewKey(key) {
        this._newKey = key;
        const block = this.overlay.querySelector("#api-keys-new-block");
        const value = this.overlay.querySelector("#api-keys-new-value");
        if (block && value) {
            value.textContent = key;
            block.classList.remove("hidden");
        }
    }

    async _loadKeys() {
        const list = this.overlay.querySelector("#api-keys-list");
        if (!list) return;
        try {
            const keys = await ApiKeysManager.listKeys();
            if (!keys.length) {
                list.innerHTML = `<div class="api-keys-empty">Aucune clé API active.</div>`;
                return;
            }
            list.innerHTML = keys.map((k) => `
                <div class="api-key-item">
                    <div class="api-key-info">
                        <div class="api-key-name">${this._escape(k.name || "Clé sans nom")}</div>
                        <div class="api-key-meta">Créée le ${this._formatDate(k.created_at)}${k.last_used_at ? ` · Dernière utilisation ${this._formatDate(k.last_used_at)}` : ""}</div>
                    </div>
                    <button type="button" class="api-key-revoke" data-action="revoke" data-key-id="${k.id}" title="Révoquer">
                        <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16"></path></svg>
                    </button>
                </div>
            `).join("");
        } catch (err) {
            console.error("List API keys error", err);
            list.innerHTML = `<div class="api-keys-empty">Impossible de charger les clés.</div>`;
        }
    }

    open() {
        this.overlay.classList.remove("hidden");
        const newBlock = this.overlay.querySelector("#api-keys-new-block");
        if (newBlock) newBlock.classList.add("hidden");
        this._newKey = null;
        this._loadKeys();
    }

    close() {
        this.overlay.classList.add("hidden");
    }

    _escape(text) {
        return String(text || "")
            .replace(/&/g, "&amp;")
            .replace(/</g, "&lt;")
            .replace(/>/g, "&gt;")
            .replace(/"/g, "&quot;");
    }

    _formatDate(iso) {
        if (!iso) return "";
        const d = new Date(iso);
        return d.toLocaleDateString("fr-FR", { day: "numeric", month: "short", year: "numeric" });
    }
}
