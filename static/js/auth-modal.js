/**
 * AuthManager
 * Gère la session utilisateur, le stockage d'un import en attente,
 * et l'affichage du modal d'authentification bloquant.
 */

const AuthManager = (() => {
    let currentUser = null;
    let pendingImport = null; // { file, fileName, svgText }
    let modal = null;
    let onLoginCallbacks = [];

    async function init() {
        try {
            const res = await fetch("api/auth/me", { credentials: "same-origin" });
            if (res.ok) {
                currentUser = await res.json();
            }
        } catch (err) {
            console.error("Auth init error", err);
        }
    }

    function getUser() {
        return currentUser;
    }

    function isLoggedIn() {
        return !!currentUser;
    }

    function setPendingImport(file, fileName, svgText) {
        pendingImport = { file, fileName, svgText };
    }

    function getPendingImport() {
        return pendingImport;
    }

    function clearPendingImport() {
        pendingImport = null;
    }

    function onLogin(cb) {
        onLoginCallbacks.push(cb);
    }

    function emitLogin(user) {
        onLoginCallbacks.forEach((cb) => cb(user));
    }

    async function register(username, password) {
        const res = await fetch("api/auth/register", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            credentials: "same-origin",
            body: JSON.stringify({ username, password }),
        });
        if (!res.ok) {
            const data = await res.json().catch(() => ({}));
            throw new Error(data.detail || `Erreur ${res.status}`);
        }
        currentUser = await res.json();
        emitLogin(currentUser);
        return currentUser;
    }

    async function login(username, password) {
        const res = await fetch("api/auth/login", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            credentials: "same-origin",
            body: JSON.stringify({ username, password }),
        });
        if (!res.ok) {
            const data = await res.json().catch(() => ({}));
            throw new Error(data.detail || `Erreur ${res.status}`);
        }
        currentUser = await res.json();
        emitLogin(currentUser);
        return currentUser;
    }

    async function logout() {
        await fetch("api/auth/logout", {
            method: "POST",
            credentials: "same-origin",
        });
        currentUser = null;
    }

    function showModal() {
        if (!modal) {
            modal = new AuthModal();
        }
        modal.open();
    }

    function hideModal() {
        if (modal) modal.close();
    }

    return {
        init,
        getUser,
        isLoggedIn,
        setPendingImport,
        getPendingImport,
        clearPendingImport,
        onLogin,
        register,
        login,
        logout,
        showModal,
        hideModal,
    };
})();

window.AuthManager = AuthManager;


/**
 * AuthModal
 * Overlay flouté, immobile, bloquant, avec onglets Login / Register.
 */

class AuthModal {
    constructor() {
        this.overlay = document.createElement("div");
        this.overlay.className = "auth-overlay hidden";
        this.overlay.innerHTML = `
            <div class="auth-modal">
                <div class="auth-modal-header">
                    <h2 class="auth-modal-title">SemantiQ</h2>
                    <p class="auth-modal-subtitle">Connectez-vous pour enregistrer vos modèles.</p>
                </div>
                <div class="auth-tabs">
                    <button type="button" class="auth-tab active" data-tab="login">Connexion</button>
                    <button type="button" class="auth-tab" data-tab="register">Inscription</button>
                </div>
                <form class="auth-form" id="auth-form">
                    <div class="auth-field">
                        <label for="auth-username">Nom d'utilisateur</label>
                        <input type="text" id="auth-username" autocomplete="username" required
                               pattern="^[a-zA-Z0-9_\-]+$" maxlength="64"
                               placeholder="votre_nom">
                    </div>
                    <div class="auth-field">
                        <label for="auth-password">Mot de passe</label>
                        <input type="password" id="auth-password" autocomplete="current-password" required
                               minlength="4" maxlength="128" placeholder="••••••••">
                    </div>
                    <div class="auth-error hidden" id="auth-error"></div>
                    <button type="submit" class="auth-submit" id="auth-submit">Se connecter</button>
                </form>
                <button type="button" class="auth-close" id="auth-close" title="Fermer">
                    <svg class="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M6 18L18 6M6 6l12 12"></path>
                    </svg>
                </button>
            </div>
        `;
        document.body.appendChild(this.overlay);
        this._bindEvents();
        this._currentTab = "login";
    }

    _bindEvents() {
        const tabs = this.overlay.querySelectorAll(".auth-tab");
        tabs.forEach((tab) => {
            tab.addEventListener("click", () => this._switchTab(tab.dataset.tab));
        });

        const form = this.overlay.querySelector("#auth-form");
        form.addEventListener("submit", (e) => this._onSubmit(e));

        const closeBtn = this.overlay.querySelector("#auth-close");
        closeBtn.addEventListener("click", () => this.close());

        this.overlay.addEventListener("click", (e) => {
            if (e.target === this.overlay) this.close();
        });
    }

    _switchTab(tab) {
        this._currentTab = tab;
        this.overlay.querySelectorAll(".auth-tab").forEach((btn) => {
            btn.classList.toggle("active", btn.dataset.tab === tab);
        });
        const submit = this.overlay.querySelector("#auth-submit");
        submit.textContent = tab === "login" ? "Se connecter" : "Créer un compte";
        this._setError("");
    }

    _setError(msg) {
        const el = this.overlay.querySelector("#auth-error");
        el.textContent = msg;
        el.classList.toggle("hidden", !msg);
    }

    async _onSubmit(e) {
        e.preventDefault();
        const username = this.overlay.querySelector("#auth-username").value.trim();
        const password = this.overlay.querySelector("#auth-password").value;
        this._setError("");
        const submit = this.overlay.querySelector("#auth-submit");
        submit.disabled = true;
        submit.textContent = this._currentTab === "login" ? "Connexion..." : "Inscription...";

        try {
            if (this._currentTab === "login") {
                await AuthManager.login(username, password);
            } else {
                await AuthManager.register(username, password);
            }
            this.close();
        } catch (err) {
            let msg = err.message;
            if (msg === "username_exists") msg = "Ce nom d'utilisateur est déjà pris.";
            else if (msg === "invalid_credentials") msg = "Identifiants incorrects.";
            this._setError(msg || "Une erreur est survenue.");
        } finally {
            submit.disabled = false;
            submit.textContent = this._currentTab === "login" ? "Se connecter" : "Créer un compte";
        }
    }

    open() {
        this.overlay.classList.remove("hidden");
        setTimeout(() => this.overlay.querySelector("#auth-username")?.focus(), 50);
    }

    close() {
        this.overlay.classList.add("hidden");
        this._setError("");
    }
}
