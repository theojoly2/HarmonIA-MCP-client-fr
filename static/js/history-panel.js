/**
 * HistoryPanel
 * Panneau latéral droit affichant l'historique des modèles de l'utilisateur.
 */

class HistoryPanel {
    constructor(container) {
        this.container = container;
        this.isOpen = false;
        this.models = [];
        this._init();
    }

    _init() {
        this.panel = document.createElement("aside");
        this.panel.className = "history-panel";
        this.panel.setAttribute("aria-label", "Historique des modèles");
        this.panel.innerHTML = `
            <div class="history-panel-header">
                <h3 class="history-panel-title">Modèles enregistrés</h3>
                <button type="button" class="history-panel-close" id="history-close" title="Fermer">
                    <svg class="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M6 18L18 6M6 6l12 12"></path>
                    </svg>
                </button>
            </div>
            <div class="history-panel-content" id="history-content">
                <div class="history-empty" id="history-empty">Aucun modèle enregistré.</div>
                <ul class="history-list" id="history-list"></ul>
            </div>
        `;
        this.container.appendChild(this.panel);
        this.listEl = this.panel.querySelector("#history-list");
        this.emptyEl = this.panel.querySelector("#history-empty");
        this.panel.querySelector("#history-close").addEventListener("click", () => this.close());

        // Close when clicking outside (on the shell content area)
        document.addEventListener("click", (e) => {
            if (!this.isOpen) return;
            const target = e.target;
            if (!this.panel.contains(target) && !target.closest("#history-toggle")) {
                this.close();
            }
        });
    }

    async load() {
        if (!AuthManager.isLoggedIn()) {
            this.models = [];
            this._render();
            return;
        }
        try {
            const res = await fetch("api/models", { credentials: "same-origin" });
            if (!res.ok) throw new Error("fetch_failed");
            const data = await res.json();
            this.models = data.models || [];
        } catch (err) {
            console.error("History load error", err);
            this.models = [];
        }
        this._render();
    }

    _render() {
        this.listEl.innerHTML = "";
        if (!this.models.length) {
            this.emptyEl.classList.remove("hidden");
            return;
        }
        this.emptyEl.classList.add("hidden");
        this.models.forEach((model) => {
            const li = document.createElement("li");
            li.className = "history-item";
            li.dataset.modelId = model.id;
            li.innerHTML = `
                <div class="history-item-info">
                    <span class="history-item-name" title="${this._escape(model.name)}">${this._escape(model.name)}</span>
                    <span class="history-item-meta">${this._escape(model.source_format || "")}</span>
                </div>
                <div class="history-item-actions">
                    <button type="button" class="history-action history-action-open" title="Ouvrir">
                        <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M15 12a3 3 0 11-6 0 3 3 0 016 0z"></path>
                            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M2.458 12C3.732 7.943 7.523 5 12 5c4.478 0 8.268 2.943 9.542 7-1.274 4.057-5.064 7-9.542 7-4.477 0-8.268-2.943-9.542-7z"></path>
                        </svg>
                    </button>
                    <button type="button" class="history-action history-action-rename" title="Renommer">
                        <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z"></path>
                        </svg>
                    </button>
                    <button type="button" class="history-action history-action-delete" title="Supprimer">
                        <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16"></path>
                        </svg>
                    </button>
                </div>
            `;
            li.querySelector(".history-action-open").addEventListener("click", (e) => {
                e.stopPropagation();
                this._openModel(model.id);
            });
            li.querySelector(".history-action-rename").addEventListener("click", (e) => {
                e.stopPropagation();
                this._renameModel(model.id, model.name);
            });
            li.querySelector(".history-action-delete").addEventListener("click", (e) => {
                e.stopPropagation();
                this._deleteModel(model.id);
            });
            this.listEl.appendChild(li);
        });
    }

    _escape(str) {
        return String(str || "")
            .replace(/&/g, "&amp;")
            .replace(/\"/g, "&quot;")
            .replace(/\u003c/g, "&lt;")
            .replace(/\u003e/g, "&gt;");
    }

    async _openModel(modelId) {
        try {
            const res = await fetch(`api/models/${modelId}/open`, {
                method: "POST",
                credentials: "same-origin",
            });
            if (!res.ok) throw new Error("open_failed");
            const svgText = await res.text();
            const fileName = res.headers.get("X-Model-Name") || "Modèle";
            const modelIdFromHeader = res.headers.get("X-Model-Id") || modelId;

            // Replace current Vision instance (tab) with this model
            const existingVision = AppState.listInstances().find((i) => i.appId === "vision" && i.mode === "tab");
            if (existingVision) {
                AppState.removeInstance(existingVision.instanceId);
            }
            windowManager.open("vision", {
                mode: "tab",
                fileName,
                svgText,
                mainClassName: "",
                modelId: modelIdFromHeader,
            });
            this.close();
        } catch (err) {
            console.error("Open model error", err);
            alert("Impossible d'ouvrir le modèle.");
        }
    }

    async _renameModel(modelId, currentName) {
        const newName = prompt("Renommer le modèle :", currentName);
        if (!newName || newName.trim() === currentName) return;
        try {
            const res = await fetch(`api/models/${modelId}/rename`, {
                method: "PATCH",
                headers: { "Content-Type": "application/json" },
                credentials: "same-origin",
                body: JSON.stringify({ name: newName.trim() }),
            });
            if (!res.ok) throw new Error("rename_failed");
            await this.load();
        } catch (err) {
            console.error("Rename model error", err);
            alert("Impossible de renommer le modèle.");
        }
    }

    async _deleteModel(modelId) {
        if (!confirm("Supprimer ce modèle de votre historique ?")) return;
        try {
            const res = await fetch(`api/models/${modelId}`, {
                method: "DELETE",
                credentials: "same-origin",
            });
            if (!res.ok) throw new Error("delete_failed");
            await this.load();
        } catch (err) {
            console.error("Delete model error", err);
            alert("Impossible de supprimer le modèle.");
        }
    }

    open() {
        this.isOpen = true;
        this.panel.classList.add("open");
        this.load();
    }

    close() {
        this.isOpen = false;
        this.panel.classList.remove("open");
    }

    toggle() {
        if (this.isOpen) this.close();
        else this.open();
    }
}

window.HistoryPanel = HistoryPanel;
