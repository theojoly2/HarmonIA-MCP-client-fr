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
        // Ensure pointer events work even inside a pointer-events-none overlay area.
        this.panel.style.pointerEvents = "auto";
        this.container.appendChild(this.panel);
        this.listEl = this.panel.querySelector("#history-list");
        this.emptyEl = this.panel.querySelector("#history-empty");
        this.panel.querySelector("#history-close").addEventListener("click", () => this.close());

        // Close when clicking outside the panel (ignore history menus floating in body).
        this._outsideClickHandler = (e) => {
            if (!this.isOpen) return;
            const target = e.target;
            if (this.panel.contains(target)) return;
            if (target.closest("#history-toggle")) return;
            if (target.closest(".history-menu")) return;
            this.close();
        };
        document.addEventListener("click", this._outsideClickHandler, true);
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
            const modelName = model.name || model.id || "";
            const li = document.createElement("li");
            li.className = "history-item";
            li.dataset.modelName = modelName;
            li.innerHTML = `
                <div class="history-item-info">
                    <span class="history-item-name" title="Cliquer pour renommer">${this._escape(modelName)}</span>
                </div>
                <button type="button" class="history-action history-action-more" title="Actions" aria-haspopup="true">
                    <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2.5" d="M5 12h.01M12 12h.01M19 12h.01"></path>
                    </svg>
                </button>
            `;
            li.addEventListener("click", (e) => {
                if (e.target.closest(".history-action-more, .history-menu")) return;
                this._openModel(modelName);
            });
            const nameEl = li.querySelector(".history-item-name");
            const moreBtn = li.querySelector(".history-action-more");
            moreBtn.addEventListener("click", (e) => {
                e.stopPropagation();
                this._showMenu(e.currentTarget, modelName);
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

    _showMenu(anchorBtn, modelName) {
        // Remove any existing menu
        this._closeMenu();
        const menu = document.createElement("div");
        menu.className = "history-menu";
        menu.innerHTML = `
            <button type="button" class="history-menu-item history-menu-rename">Renommer</button>
            <button type="button" class="history-menu-item history-menu-delete">Supprimer</button>
        `;
        const rect = anchorBtn.getBoundingClientRect();
        menu.style.top = `${rect.bottom + 4}px`;
        menu.style.right = `${document.body.clientWidth - rect.right}px`;
        document.body.appendChild(menu);
        this._activeMenu = menu;

        menu.querySelector(".history-menu-rename").addEventListener("click", (e) => {
            e.stopPropagation();
            this._closeMenu();
            const li = this.listEl.querySelector(`li[data-model-name="${CSS.escape(modelName)}"]`) || anchorBtn.closest(".history-item");
            const nameEl = li?.querySelector(".history-item-name");
            if (nameEl) this._startInlineRename(nameEl, modelName);
        });
        menu.querySelector(".history-menu-delete").addEventListener("click", (e) => {
            e.stopPropagation();
            this._closeMenu();
            this._deleteModel(modelName);
        });

        // Close on next click anywhere
        requestAnimationFrame(() => {
            const closeHandler = (e) => {
                if (menu.contains(e.target)) return;
                this._closeMenu();
                document.removeEventListener("click", closeHandler);
            };
            document.addEventListener("click", closeHandler);
        });
    }

    _closeMenu() {
        if (this._activeMenu) {
            this._activeMenu.remove();
            this._activeMenu = null;
        }
    }

    _startInlineRename(nameEl, modelName) {
        if (nameEl.querySelector("input")) return;
        const input = document.createElement("input");
        input.type = "text";
        input.value = modelName;
        input.className = "history-item-rename-input";
        nameEl.textContent = "";
        nameEl.appendChild(input);
        input.focus();
        input.select();

        const finish = async (save) => {
            const newName = input.value.trim();
            input.remove();
            if (!save || !newName || newName === modelName) {
                nameEl.textContent = modelName;
                return;
            }
            nameEl.textContent = newName;
            try {
                const encodedName = encodeURIComponent(modelName);
                const res = await fetch(`api/models/${encodedName}/rename`, {
                    method: "PATCH",
                    headers: { "Content-Type": "application/json" },
                    credentials: "same-origin",
                    body: JSON.stringify({ name: newName }),
                });
                if (!res.ok) throw new Error("rename_failed");
                // Keep displayed text; refresh list silently in background to sync ordering
                this.load();
            } catch (err) {
                console.error("Rename model error", err);
                nameEl.textContent = modelName;
                alert("Impossible de renommer le modèle.");
            }
        };

        input.addEventListener("keydown", (e) => {
            if (e.key === "Enter") finish(true);
            else if (e.key === "Escape") finish(false);
        });
        input.addEventListener("blur", () => finish(true));
        input.addEventListener("click", (e) => e.stopPropagation());
    }

    async _openModel(modelName) {
        try {
            const encodedName = encodeURIComponent(modelName);
            const res = await fetch(`api/models/${encodedName}/open`, {
                method: "POST",
                credentials: "same-origin",
            });
            if (!res.ok) throw new Error("open_failed");
            const svgText = await res.text();
            const fileName = res.headers.get("X-Model-Name") || modelName;

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
            });
            this.close();
        } catch (err) {
            console.error("Open model error", err);
            alert("Impossible d'ouvrir le modèle.");
        }
    }



    async _deleteModel(modelName) {
        if (!confirm("Supprimer ce modèle de votre historique ?")) return;
        try {
            const encodedName = encodeURIComponent(modelName);
            const res = await fetch(`api/models/${encodedName}`, {
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

    destroy() {
        if (this.panel) this.panel.remove();
        if (this._outsideClickHandler) {
            document.removeEventListener("click", this._outsideClickHandler, true);
        }
    }

    toggle() {
        if (this.isOpen) this.close();
        else this.open();
    }
}

window.HistoryPanel = HistoryPanel;
