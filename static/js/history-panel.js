/**
 * HistoryPanel
 * Panneau latéral droit affichant l'historique des modèles de l'utilisateur.
 */

class HistoryPanel {
    constructor(container) {
        this.container = container;
        this.isOpen = false;
        this.models = [];
        this._hasLoaded = false;
        this._init();
    }

    _init() {
        this.panel = document.createElement("aside");
        this.panel.className = "history-panel";
        this.panel.setAttribute("aria-label", "Historique des modèles");
        this.panel.innerHTML = `
            <div class="history-panel-header">
                <div class="history-panel-title-wrap">
                    <h3 class="history-panel-title">Historique</h3>
                    <span class="history-panel-spinner" id="history-header-spinner" aria-hidden="true">
                        <svg class="animate-spin w-4 h-4 text-gray-400" fill="none" viewBox="0 0 24 24">
                            <circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4"></circle>
                            <path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path>
                        </svg>
                    </span>
                </div>
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
                <div class="history-loading" id="history-loading">
                    <svg class="animate-spin h-6 w-6 text-gray-400" fill="none" viewBox="0 0 24 24">
                        <circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4"></circle>
                        <path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path>
                    </svg>
                    <span class="text-sm font-medium">Chargement de l'historique...</span>
                </div>
                <div class="history-empty hidden" id="history-empty">Historique vide.</div>
                <ul class="history-list" id="history-list"></ul>
            </div>
        `;
        // Ensure pointer events work even inside a pointer-events-none overlay area.
        this.panel.style.pointerEvents = "auto";
        this.container.appendChild(this.panel);
        this.listEl = this.panel.querySelector("#history-list");
        this.emptyEl = this.panel.querySelector("#history-empty");
        this.loadingEl = this.panel.querySelector("#history-loading");
        this.headerSpinnerEl = this.panel.querySelector("#history-header-spinner");
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
        // Only show the big centered spinner on the first fetch; hide the small
        // header spinner during that first load so only one spinner is visible.
        if (!this._hasLoaded) {
            if (this.headerSpinnerEl) this.headerSpinnerEl.classList.add("history-panel-spinner-hidden");
            if (this.loadingEl) this.loadingEl.classList.remove("hidden");
            if (this.emptyEl) this.emptyEl.classList.add("hidden");
        } else {
            // Subsequent reloads show only the small header spinner and keep
            // the existing list/empty message visible underneath.
            if (this.headerSpinnerEl) this.headerSpinnerEl.classList.remove("history-panel-spinner-hidden");
        }
        if (!AuthManager.isLoggedIn()) {
            this.items = [];
            this._hasLoaded = true;
            this._render();
            return;
        }
        try {
            const [modelsRes, searchesRes, assistantRes, modelerAssistantRes] = await Promise.all([
                fetch("api/models", { credentials: "same-origin" }),
                fetch("api/searches", { credentials: "same-origin" }),
                ApiClient.getAssistantSessionsAll(),
                ApiClient.getAssistantSessions("modeler"),
            ]);
            let models = [];
            let searches = [];
            let conversations = [];
            let modelsData = { models: [] };
            if (modelsRes.ok) {
                modelsData = await modelsRes.json();
                // Build a map from model name to modeler assistant session so modeler items
                // know which conversation to reopen when the user opens the chat split.
                const assistantSessionByModel = new Map();
                (modelerAssistantRes.sessions || []).forEach((s) => {
                    if (!s.model_name) return;
                    // Keep the most recently touched session for each model.
                    const existing = assistantSessionByModel.get(s.model_name);
                    if (!existing || (s.last_opened_at || 0) > (existing.last_opened_at || 0)) {
                        assistantSessionByModel.set(s.model_name, s);
                    }
                });
                // Only sessions created from the modeler are attached to modeler
                // items. Standalone assistant conversations remain separate.
                const modelerSessionByModel = new Map();
                (modelerAssistantRes.sessions || []).forEach((s) => {
                    if (!s.model_name || s.origin !== "modeler") return;
                    const existing = modelerSessionByModel.get(s.model_name);
                    if (!existing || (s.last_opened_at || 0) > (existing.last_opened_at || 0)) {
                        modelerSessionByModel.set(s.model_name, s);
                    }
                });
                models = (modelsData.models || [])
                    .filter((m) => {
                        if (m.imported_from_assistant) return false;
                        return true;
                    })
                    .map((m) => {
                        const linked = modelerSessionByModel.get(m.name);
                        return {
                            ...m,
                            kind: "model",
                            sortKey: Number(m.last_opened_at) || 0,
                            assistant_session: linked?.name || "",
                            assistant_display_name: linked?.display_name || "",
                        };
                    });
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
            if (assistantRes && assistantRes.sessions) {
                // Show standalone assistant conversations (including those created
                // via the external API). Modeler-originated sessions are surfaced
                // through the modeler item, not here.
                conversations = assistantRes.sessions
                    .filter((s) => s.origin !== "modeler")
                    .map((s) => ({
                        ...s,
                        kind: "assistant",
                        name: s.name,
                        display_name: s.display_name || s.preview || s.name,
                        source_format: "conversation",
                        sortKey: Number(s.last_opened_at) || 0,
                        origin: s.origin || "assistant",
                    }));
            }
            // Do NOT list modeler-originated assistant sessions as standalone
            // history items. They remain accessible only through their linked
            // modeler item when the user reopens a model.
            this.items = [...models, ...searches, ...conversations].sort((a, b) => b.sortKey - a.sortKey);
        } catch (err) {
            console.error("History load error", err);
            this.items = [];
        }
        this._hasLoaded = true;
        this._render();
    }

    _render() {
        this.listEl.innerHTML = "";
        if (this.loadingEl) this.loadingEl.classList.add("hidden");
        if (this.headerSpinnerEl) this.headerSpinnerEl.classList.add("history-panel-spinner-hidden");
        if (!this.items.length) {
            this.emptyEl.classList.remove("hidden");
            return;
        }
        this.emptyEl.classList.add("hidden");
        this.items.forEach((item) => {
            const isSearch = item.kind === "search";
            const isAssistant = item.kind === "assistant";
            const isModelerAssistant = item.kind === "modeler_assistant";
            const storedName = item.name || "";
            const displayName = item.display_name || storedName;
            const li = document.createElement("li");
            li.className = `history-item history-item-${item.kind}`;
            li.dataset.itemName = storedName;
            li.dataset.itemKind = item.kind;
            if (isSearch) li.dataset.searchId = item.id;
            if (isAssistant || isModelerAssistant) {
                li.dataset.modelName = item.model_name || "";
                li.dataset.modelNames = Array.isArray(item.model_names) ? item.model_names.join(",") : "";
                li.dataset.origin = item.origin || (isModelerAssistant ? "modeler" : "assistant");
            }
            if (!isSearch && !isAssistant && !isModelerAssistant) {
                li.dataset.assistantSession = item.assistant_session || "";
                li.dataset.assistantDisplayName = item.assistant_display_name || "";
            }
            li.innerHTML = `
                <div class="history-item-icon">
                    ${isSearch ? this._searchIcon() : (isAssistant || isModelerAssistant) ? this._assistantIcon() : this._modelerIcon()}
                </div>
                <div class="history-item-info">
                    <span class="history-item-name">${this._escape(displayName)}</span>
                    ${isModelerAssistant ? '<span class="history-item-subtitle text-xs text-gray-400">Modéliseur</span>' : ''}
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
                else if (isAssistant) this._openAssistant(storedName, item.model_names || (item.model_name ? [item.model_name] : []), item.origin || "assistant");
                else if (isModelerAssistant) this._openAssistant(storedName, item.model_names || (item.model_name ? [item.model_name] : []), "modeler");
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

    _assistantIcon() {
        return AssistantApp.iconSvg;
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
        const isAssistant = item.kind === "assistant";
        const isModelerAssistant = item.kind === "modeler_assistant";
        const menu = document.createElement("div");
        menu.className = "history-menu";
        menu.innerHTML = isSearch
            ? `<button type="button" class="history-menu-item history-menu-delete">Supprimer</button>`
            : `
                <button type="button" class="history-menu-item history-menu-rename">Renommer</button>
                <button type="button" class="history-menu-item history-menu-delete">Supprimer</button>
            `;
        const rect = anchorBtn.getBoundingClientRect();
        document.body.appendChild(menu);
        const menuHeight = menu.offsetHeight;
        const gap = 4;
        // Open upwards when the menu would overflow the viewport bottom.
        const top = (rect.bottom + menuHeight + gap > window.innerHeight)
            ? rect.top - menuHeight - gap
            : rect.bottom + gap;
        menu.style.top = `${top}px`;
        menu.style.right = `${document.body.clientWidth - rect.right}px`;
        this._activeMenu = menu;

        if (!isSearch) {
            menu.querySelector(".history-menu-rename").addEventListener("click", (e) => {
                e.stopPropagation();
                this._closeMenu();
                const li = this.listEl.querySelector(`li[data-item-name="${CSS.escape(item.name)}"][data-item-kind="${item.kind}"]`) || anchorBtn.closest(".history-item");
                const nameEl = li?.querySelector(".history-item-name");
                if (nameEl && li) this._startInlineRename(nameEl, item, li);
            });
        }
        if (menu.querySelector(".history-menu-delete")) {
            menu.querySelector(".history-menu-delete").addEventListener("click", (e) => {
                e.stopPropagation();
                this._showDeleteConfirm(menu, item);
            });
        }

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
        const isAssistant = item.kind === "assistant";
        const isModelerAssistant = item.kind === "modeler_assistant";
        const label = isSearch
            ? "cette recherche"
            : isAssistant
            ? "cette conversation"
            : isModelerAssistant
            ? "cette conversation modéliseur"
            : "ce modèle";
        const currentTop = parseFloat(menu.style.top) || 0;
        menu.innerHTML = `
            <div class="history-menu-text">Supprimer ${label} ?</div>
            <button type="button" class="history-menu-item history-menu-cancel">Annuler</button>
            <button type="button" class="history-menu-item history-menu-confirm-delete">Supprimer</button>
        `;
        menu.querySelector(".history-menu-confirm-delete").addEventListener("click", async (e) => {
            e.stopPropagation();
            this._closeMenu();
            try {
                if (isSearch) {
                    await ApiClient.deleteSearch(item.id);
                } else if (isAssistant) {
                    const ctx = item.origin || "assistant";
                    await ApiClient.deleteAssistantSession(item.name, ctx);
                    // External-API sessions also own their imported models; delete them too.
                    if (ctx === "external_api" && item.model_names?.length) {
                        for (const modelName of item.model_names) {
                            await fetch(`api/models/${encodeURIComponent(modelName)}`, {
                                method: "DELETE",
                                credentials: "same-origin",
                            }).catch((err) => console.error("Delete linked external model error", err));
                        }
                    }
                    // If this conversation is linked to a model imported through the
                    // assistant, also delete the linked model.
                    if (item.model_name && (modelsData.models || []).some((m) => m.name === item.model_name && m.imported_from_assistant)) {
                        await fetch(`api/models/${encodeURIComponent(item.model_name)}`, {
                            method: "DELETE",
                            credentials: "same-origin",
                        }).catch((err) => console.error("Delete linked model error", err));
                    }
                } else if (isModelerAssistant) {
                    const ctx = item.origin || "modeler";
                    await ApiClient.deleteAssistantSession(item.name, ctx);
                } else {
                    const encodedName = encodeURIComponent(item.name);
                    const res = await fetch(`api/models/${encodedName}`, {
                        method: "DELETE",
                        credentials: "same-origin",
                    });
                    if (!res.ok) throw new Error("delete_failed");
                    // If this model has a linked modeler assistant session, also delete it.
                    if (item.assistant_session) {
                        await ApiClient.deleteAssistantSession(item.assistant_session, "modeler").catch((err) =>
                            console.error("Delete linked assistant error", err)
                        );
                    }
                }
                await this.load();
            } catch (err) {
                console.error("Delete history item error", err);
                alert(`Impossible de supprimer ${isSearch ? "la recherche" : isAssistant ? "la conversation" : isModelerAssistant ? "la conversation modéliseur" : "le modèle"}.`);
            }
        });
        menu.querySelector(".history-menu-cancel").addEventListener("click", (e) => {
            e.stopPropagation();
            this._closeMenu();
        });

        // The delete confirmation may be taller than the original menu; recheck
        // viewport overflow and flip upwards if needed.
        requestAnimationFrame(() => {
            const menuHeight = menu.offsetHeight;
            const bottom = currentTop + menuHeight;
            const gap = 4;
            if (bottom > window.innerHeight) {
                menu.style.top = `${Math.max(gap, currentTop - (bottom - window.innerHeight))}px`;
            }
        });
    }

    _startInlineRename(nameEl, item, li) {
        if (nameEl.querySelector("input")) return;
        const storedName = item.name || "";
        const displayName = item.display_name || storedName;
        const kind = item.kind || "model";
        const initialName = displayName || storedName;
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
                let res;
                if (kind === "assistant" || kind === "modeler_assistant") {
                    const ctx = item.origin || (kind === "modeler_assistant" ? "modeler" : "assistant");
                    const encodedSession = encodeURIComponent(storedName);
                    res = await fetch(`api/assistant/sessions/${encodedSession}/rename?origin=${encodeURIComponent(ctx)}`, {
                        method: "PATCH",
                        headers: { "Content-Type": "application/json" },
                        credentials: "same-origin",
                        body: JSON.stringify({ name: newName }),
                    });
                    if (!res.ok) {
                        const err = await res.json().catch(() => ({}));
                        throw new Error(err.detail || `rename_failed_${res.status}`);
                    }
                    const result = await res.json().catch(() => ({}));
                    const newStoredName = result.name || storedName;
                    // Update the DOM so subsequent renames use the new stored name.
                    li.dataset.itemName = newStoredName;
                    item.name = newStoredName;
                    item.display_name = newName;
                    // If the renamed assistant conversation is currently open,
                    // update the instance props so the next message goes to the
                    // new session file instead of recreating the old one.
                    AppState.listInstances().forEach((info) => {
                        if (info.appId !== "assistant") return;
                        const inst = AppState.getInstance(info.instanceId);
                        if (inst && inst.session === storedName && inst.origin === ctx) {
                            inst.session = newStoredName;
                            inst.props.session = newStoredName;
                            inst.props.fromHistory = true;
                            inst.props.display_name = newName;
                            // Update the displayed title in the tab if it changed.
                            if (inst.setTitle) {
                                inst.setTitle(`Assistant: ${newName}`);
                            }
                        }
                    });
                } else {
                    const encodedName = encodeURIComponent(storedName);
                    res = await fetch(`api/models/${encodedName}/rename`, {
                        method: "PATCH",
                        headers: { "Content-Type": "application/json" },
                        credentials: "same-origin",
                        body: JSON.stringify({ name: newName }),
                    });
                    if (!res.ok) {
                        const err = await res.json().catch(() => ({}));
                        throw new Error(err.detail || `rename_failed_${res.status}`);
                    }
                    const result = await res.json().catch(() => ({}));
                    const newStoredName = result.name || storedName;
                    // Update the DOM so subsequent renames use the new stored name.
                    li.dataset.itemName = newStoredName;
                    item.name = newStoredName;
                    item.display_name = newName;
                    // If the renamed model has a linked modeler assistant session,
                    // update the assistant's stored model name so the link survives.
                    const linkedSession = li.dataset.assistantSession;
                    if (linkedSession) {
                        try {
                            await fetch(`api/assistant/sessions/${encodeURIComponent(linkedSession)}/link-model`, {
                                method: "POST",
                                headers: { "Content-Type": "application/json" },
                                credentials: "same-origin",
                                body: JSON.stringify({ model_name: newStoredName }),
                            });
                        } catch (err) {
                            console.error("Update linked model name after rename error", err);
                        }
                    }
                    // If the renamed model is currently open in the Modeler, update its
                    // stored name and refresh the SVG so the displayed package/model name
                    // matches the new display name.
                    AppState.listInstances().forEach((info) => {
                        if (info.appId !== "modeler") return;
                        const inst = AppState.getInstance(info.instanceId);
                        if (inst && inst.updateModelName && (inst.storedName === storedName || inst.fileName === initialName)) {
                            inst.updateModelName(newStoredName, newName);
                            if (inst._reloadSvgFromServer) {
                                inst._reloadSvgFromServer().catch((err) => console.error("Refresh SVG after rename error", err));
                            }
                        }
                    });
                }
                // Keep displayed text; refresh list silently in background to sync ordering
                this.load();
            } catch (err) {
                console.error(`Rename ${kind} error`, err);
                nameEl.textContent = initialName;
                alert(kind === "assistant" || kind === "modeler_assistant" ? "Impossible de renommer la conversation : " + err.message : "Impossible de renommer le modèle : " + err.message);
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

        // Open the Modeler tab immediately in loading state so the user sees
        // the spinner while the SVG is fetched/generated in the background.
        const existingModéliseur = AppState.listInstances().find((i) => i.appId === "modeler" && i.mode === "tab");
        if (existingModéliseur) {
            AppState.removeInstance(existingModéliseur.instanceId);
        }
        const modelerInstance = AppState.createInstance("modeler", {
            mode: "tab",
            loading: true,
        });
        await windowManager._mountTab(modelerInstance.instance);
        AppState.setActiveInstance(modelerInstance.instanceId);

        // Fetch the SVG and linked session info in parallel with opening the tab.
        let svgText;
        let returnedName;
        try {
            ({ svgText, modelName: returnedName } = await ApiClient.getModelSvg(modelName));
        } catch (err) {
            console.error("Fetch model SVG error", err);
            modelerInstance.instance._setLoading(false);
            modelerInstance.instance._showError(err.message || err);
            alert("Impossible d'ouvrir le modèle : " + (err.message || err));
            return;
        }

        // Update last-opened time in the background (non-blocking).
        fetch(`api/models/${encodedName}/touch`, {
            method: "POST",
            credentials: "same-origin",
        }).catch((err) => console.error("Touch model error", err));

        const displayName = returnedName || modelName;
        if (modelerInstance.instance.loadSvg) {
            await modelerInstance.instance.loadSvg(svgText, displayName, (svgText.match(match) || ["", ""])[1], modelName);
        }

        // If this model has a linked modeler assistant conversation, prepare the
        // modeler so its assistant split reopens that session instead of
        // creating a blank one.
        const li = this.listEl.querySelector(`li[data-item-name="${CSS.escape(modelName)}"][data-item-kind="model"]`);
        const linkedSession = li?.dataset.assistantSession;
        const linkedDisplayName = li?.dataset.assistantDisplayName;
        if (linkedSession && modelerInstance.instance._prepareLinkedAssistantSession) {
            modelerInstance.instance._prepareLinkedAssistantSession(linkedSession, linkedDisplayName);
        }

        // Also update the modeler assistant sub-entry mtime so it stays in
        // sync with the model item in the history panel.
        if (linkedSession) {
            try {
                await ApiClient.touchAssistantSession(linkedSession, "modeler");
            } catch (err) {
                console.error("Touch modeler assistant session error", err);
            }
        }

        try {
            await this.load();
        } catch (err) {
            console.error("History reload error", err);
        }
    }

    async _openAssistant(sessionName, modelNames, origin = "assistant") {
        this.close();
        try {
            const names = Array.isArray(modelNames) ? modelNames : (modelNames ? [modelNames] : []);
            // Touch the session on the backend so it moves to the top of the
            // history list even when it is just reopened without a new message.
            await ApiClient.touchAssistantSession(sessionName, origin);
            const existingAssistant = AppState.listInstances().find((i) => i.appId === "assistant");
            if (existingAssistant) {
                AppState.removeInstance(existingAssistant.instanceId);
            }
            const assistantInstance = AppState.createInstance("assistant", {
                mode: "tab",
                session: sessionName,
                modelNames: names,
                modelName: names[0] || "",
                origin: origin,
                fromHistory: true,
            });
            await windowManager._mountTab(assistantInstance.instance);
            AppState.setActiveInstance(assistantInstance.instanceId);
            await this.load();
        } catch (err) {
            console.error("Open assistant conversation error", err);
            alert("Impossible d'ouvrir la conversation : " + (err.message || err));
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
                // Update the visible input so the user sees the restored query
                // instead of whatever was previously typed in the search box.
                const input = inst.container?.querySelector('#search-input');
                if (input) input.value = query;
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
            "Cette action supprimera définitivement tous vos modèles, toutes vos recherches et toutes vos conversations. Cette action est irréversible."
        );
        if (!confirmed) return;
        try {
            // Track which models/sessions are already deleted by their linked
            // counterpart so we don't try to delete the same file twice.
            const deletedModels = new Set();
            const deletedSessions = new Set();
            const deletions = [];

            this.items.forEach((item) => {
                if (item.kind === "search") {
                    deletions.push(ApiClient.deleteSearch(item.id));
                    return;
                }
                if (item.kind === "assistant") {
                    const ctx = item.origin || "assistant";
                    const sessionKey = `${ctx}__${item.name}`;
                    if (!deletedSessions.has(sessionKey)) {
                        deletedSessions.add(sessionKey);
                        deletions.push(ApiClient.deleteAssistantSession(item.name, ctx));
                    }
                    if (item.model_name && !deletedModels.has(item.model_name)) {
                        deletedModels.add(item.model_name);
                        deletions.push(
                            fetch(`api/models/${encodeURIComponent(item.model_name)}`, {
                                method: "DELETE",
                                credentials: "same-origin",
                            }).catch((err) => console.error("Delete all linked model error", err))
                        );
                    }
                    return;
                }
                if (item.kind === "modeler_assistant") {
                    const ctx = item.origin || "modeler";
                    const sessionKey = `${ctx}__${item.name}`;
                    if (!deletedSessions.has(sessionKey)) {
                        deletedSessions.add(sessionKey);
                        deletions.push(ApiClient.deleteAssistantSession(item.name, ctx));
                    }
                    return;
                }
                // modeler item
                if (!deletedModels.has(item.name)) {
                    deletedModels.add(item.name);
                    deletions.push(
                        fetch(`api/models/${encodeURIComponent(item.name)}`, {
                            method: "DELETE",
                            credentials: "same-origin",
                        })
                    );
                }
                if (item.assistant_session && !deletedSessions.has(`modeler__${item.assistant_session}`)) {
                    deletedSessions.add(`modeler__${item.assistant_session}`);
                    deletions.push(
                        ApiClient.deleteAssistantSession(item.assistant_session, "modeler").catch((err) =>
                            console.error("Delete all linked session error", err)
                        )
                    );
                }
            });

            await Promise.all(deletions);
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
