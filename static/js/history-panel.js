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
                <h3 class="history-panel-title">Historique</h3>
                <div class="history-panel-actions">
                    <button type="button" class="history-panel-delete-all" id="history-delete-all" title="Tout supprimer">
                        <svg class="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16"></path>
                        </svg>
                    </button>
                    <button type="button" class="history-panel-close" id="history-close" title="Fermer">
                        <svg class="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M6 18L18 6M6 6l12 12"></path>
                        </svg>
                    </button>
                </div>
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
        this.panel.querySelector("#history-delete-all").addEventListener("click", (e) => {
            e.stopPropagation();
            this._deleteAll();
        });

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
            this.items = [];
            this._render();
            return;
        }
        try {
            const [modelsRes, searchesRes] = await Promise.all([
                fetch("api/models", { credentials: "same-origin" }),
                fetch("api/searches", { credentials: "same-origin" }),
            ]);
            let models = [];
            let searches = [];
            if (modelsRes.ok) {
                const data = await modelsRes.json();
                models = (data.models || []).map((m) => ({
                    ...m,
                    kind: "model",
                    sortKey: Number(m.last_opened_at) || 0,
                }));
            }
            if (searchesRes.ok) {
                const data = await searchesRes.json();
                searches = (data.searches || []).map((s) => ({
                    ...s,
                    kind: "search",
                    name: s.query,
                    source_format: (s.tags || "").split(",").filter(Boolean).join(", ") || "recherche",
                    sortKey: Number(s.last_opened_at) || 0,
                }));
            }
            this.items = [...models, ...searches].sort((a, b) => b.sortKey - a.sortKey);
        } catch (err) {
            console.error("History load error", err);
            this.items = [];
        }
        this._render();
    }

    _render() {
        this.listEl.innerHTML = "";
        if (!this.items.length) {
            this.emptyEl.classList.remove("hidden");
            return;
        }
        this.emptyEl.classList.add("hidden");
        this.items.forEach((item) => {
            const isSearch = item.kind === "search";
            const storedName = item.name || "";
            const displayName = item.display_name || storedName;
            const li = document.createElement("li");
            li.className = `history-item history-item-${item.kind}`;
            li.dataset.itemName = storedName;
            li.dataset.itemKind = item.kind;
            if (isSearch) li.dataset.searchId = item.id;
            li.innerHTML = `
                <div class="history-item-icon">
                    ${isSearch ? this._searchIcon() : this._modelerIcon()}
                </div>
                <div class="history-item-info">
                    <span class="history-item-name">${this._escape(displayName)}</span>
                </div>
                <button type="button" class="history-action history-action-more" title="Actions" aria-haspopup="true">
                    <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2.5" d="M5 12h.01M12 12h.01M19 12h.01"></path>
                    </svg>
                </button>
            `;
            li.addEventListener("click", (e) => {
                if (e.target.closest(".history-action-more, .history-menu")) return;
                if (isSearch) this._runSearch(storedName, (item.tags || "").split(",").filter(Boolean), item.id);
                else this._openModel(storedName);
            });
            const moreBtn = li.querySelector(".history-action-more");
            moreBtn.addEventListener("click", (e) => {
                e.stopPropagation();
                this._showMenu(e.currentTarget, item);
            });
            this.listEl.appendChild(li);
        });
    }

    _searchIcon() {
        return `<svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z"></path>
        </svg>`;
    }

    _modelerIcon() {
        return `<svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M15 12a3 3 0 11-6 0 3 3 0 016 0z"></path>
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M2.458 12C3.732 7.943 7.523 5 12 5c4.478 0 8.268 2.943 9.542 7-1.274 4.057-5.064 7-9.542 7-4.477 0-8.268-2.943-9.542-7z"></path>
        </svg>`;
    }

    _escape(str) {
        return String(str || "")
            .replace(/&/g, "&amp;")
            .replace(/\"/g, "&quot;")
            .replace(/\u003c/g, "&lt;")
            .replace(/\u003e/g, "&gt;");
    }

    _showMenu(anchorBtn, item) {
        // Remove any existing menu
        this._closeMenu();
        const isSearch = item.kind === "search";
        const menu = document.createElement("div");
        menu.className = "history-menu";
        menu.innerHTML = isSearch
            ? `<button type="button" class="history-menu-item history-menu-delete">Supprimer</button>`
            : `
                <button type="button" class="history-menu-item history-menu-rename">Renommer</button>
                <button type="button" class="history-menu-item history-menu-delete">Supprimer</button>
            `;
        const rect = anchorBtn.getBoundingClientRect();
        menu.style.top = `${rect.bottom + 4}px`;
        menu.style.right = `${document.body.clientWidth - rect.right}px`;
        document.body.appendChild(menu);
        this._activeMenu = menu;

        if (!isSearch) {
            menu.querySelector(".history-menu-rename").addEventListener("click", (e) => {
                e.stopPropagation();
                this._closeMenu();
                const li = this.listEl.querySelector(`li[data-item-name="${CSS.escape(item.name)}"][data-item-kind="model"]`) || anchorBtn.closest(".history-item");
                const nameEl = li?.querySelector(".history-item-name");
                if (nameEl) this._startInlineRename(nameEl, item.name, item.display_name || item.name);
            });
        }
        menu.querySelector(".history-menu-delete").addEventListener("click", (e) => {
            e.stopPropagation();
            this._showDeleteConfirm(menu, item);
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

    _showDeleteConfirm(menu, item) {
        const isSearch = item.kind === "search";
        const label = isSearch ? "recherche" : "modèle";
        menu.innerHTML = `
            <div class="history-menu-text">Supprimer cette ${label} ?</div>
            <button type="button" class="history-menu-item history-menu-cancel">Annuler</button>
            <button type="button" class="history-menu-item history-menu-confirm-delete">Supprimer</button>
        `;
        menu.querySelector(".history-menu-confirm-delete").addEventListener("click", async (e) => {
            e.stopPropagation();
            this._closeMenu();
            try {
                if (isSearch) {
                    await ApiClient.deleteSearch(item.id);
                } else {
                    const encodedName = encodeURIComponent(item.name);
                    const res = await fetch(`api/models/${encodedName}`, {
                        method: "DELETE",
                        credentials: "same-origin",
                    });
                    if (!res.ok) throw new Error("delete_failed");
                }
                await this.load();
            } catch (err) {
                console.error("Delete history item error", err);
                alert(`Impossible de supprimer ${isSearch ? "la recherche" : "le modèle"}.`);
            }
        });
        menu.querySelector(".history-menu-cancel").addEventListener("click", (e) => {
            e.stopPropagation();
            this._closeMenu();
        });
    }

    _startInlineRename(nameEl, modelName, displayName) {
        if (nameEl.querySelector("input")) return;
        const initialName = displayName || modelName;
        const input = document.createElement("input");
        input.type = "text";
        input.value = initialName;
        input.className = "history-item-rename-input";
        nameEl.textContent = "";
        nameEl.appendChild(input);
        input.focus();
        input.select();

        const finish = async (save) => {
            const newName = input.value.trim();
            input.remove();
            if (!save || !newName || newName === initialName) {
                nameEl.textContent = initialName;
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
                nameEl.textContent = initialName;
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
        const encodedName = encodeURIComponent(modelName);
        const match = /data-main-class="([^"]*)"/;

        this.close();

        try {
            let svgText;
            let returnedName;
            try {
                ({ svgText, modelName: returnedName } = await ApiClient.getModelSvg(modelName));
            } catch (err) {
                console.error("Fetch model SVG error", err);
                alert("Impossible d'ouvrir le modèle : " + (err.message || err));
                return;
            }

            // Update last-opened time in the background (non-blocking).
            fetch(`api/models/${encodedName}/touch`, {
                method: "POST",
                credentials: "same-origin",
            }).catch((err) => console.error("Touch model error", err));

            const existingModéliseur = AppState.listInstances().find((i) => i.appId === "modeler" && i.mode === "tab");
            if (existingModéliseur) {
                AppState.removeInstance(existingModéliseur.instanceId);
            }
            const modelerInstance = AppState.createInstance("modeler", {
                mode: "tab",
            });
            await windowManager._mountTab(modelerInstance.instance);
            AppState.setActiveInstance(modelerInstance.instanceId);
            const displayName = returnedName || modelName;
            if (modelerInstance.instance.loadSvg) {
                await modelerInstance.instance.loadSvg(svgText, displayName, (svgText.match(match) || ["", ""])[1], modelName);
            }

            await this.load();
        } catch (err) {
            console.error("Open model error", err);
            alert("Impossible d'ouvrir le modèle : " + (err.message || err));
        }
    }

    async _runSearch(query, tags, searchId) {
        this.close();
        if (searchId) {
            try {
                await ApiClient.touchSearch(searchId);
            } catch (err) {
                console.error("Touch search error", err);
            }
        }
        const existingSearch = AppState.listInstances().find((i) => i.appId === "search");
        if (existingSearch) {
            const inst = AppState.getInstance(existingSearch.instanceId);
            if (inst) {
                inst.query = query;
                inst.selectedTags = tags;
                inst._skipHistorySave = true;
                if (existingSearch.mode === "tab") {
                    await windowManager.switchTab(existingSearch.instanceId);
                } else if (existingSearch.mode === "float") {
                    await windowManager.moveToFloat(existingSearch.instanceId);
                } else if (existingSearch.mode === "split") {
                    windowManager.renderSplit();
                }
                inst._runSearch();
                return;
            }
        }
        windowManager.open("search", { mode: "tab", query, tags, fromHistory: true });
    }



    async _deleteAll() {
        const confirmed = await this._showConfirmDialog(
            "Supprimer tout l'historique",
            "Cette action supprimera définitivement tous vos modèles et toutes vos recherches. Cette action est irréversible."
        );
        if (!confirmed) return;
        try {
            await Promise.all(
                this.items.map((item) => {
                    if (item.kind === "search") {
                        return ApiClient.deleteSearch(item.id);
                    }
                    const encodedName = encodeURIComponent(item.name);
                    return fetch(`api/models/${encodedName}`, {
                        method: "DELETE",
                        credentials: "same-origin",
                    });
                })
            );
            await this.load();
        } catch (err) {
            console.error("Delete all error", err);
            alert("Impossible de supprimer tout l'historique.");
        }
    }

    _showConfirmDialog(title, message) {
        return new Promise((resolve) => {
            const overlay = document.createElement("div");
            overlay.className = "confirm-overlay";
            overlay.innerHTML = `
                <div class="confirm-modal">
                    <h3 class="confirm-title">${this._escape(title)}</h3>
                    <p class="confirm-message">${this._escape(message)}</p>
                    <div class="confirm-actions">
                        <button type="button" class="confirm-btn confirm-cancel">Annuler</button>
                        <button type="button" class="confirm-btn confirm-danger">Supprimer tout</button>
                    </div>
                </div>
            `;
            document.body.appendChild(overlay);

            const close = (value) => {
                overlay.classList.add("hidden");
                setTimeout(() => overlay.remove(), 250);
                resolve(value);
            };

            overlay.querySelector(".confirm-cancel").addEventListener("click", () => close(false));
            overlay.querySelector(".confirm-danger").addEventListener("click", () => close(true));
            overlay.addEventListener("click", (e) => {
                if (e.target === overlay) close(false);
            });
        });
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
