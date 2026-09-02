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
    let onLogoutCallbacks = [];

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

    function onLogout(cb) {
        onLogoutCallbacks.push(cb);
    }

    function emitLogout() {
        onLogoutCallbacks.forEach((cb) => cb());
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
        emitLogout();
    }

    async function changePassword(oldPassword, password) {
        const res = await fetch("api/auth/change-password", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            credentials: "same-origin",
            body: JSON.stringify({ old_password: oldPassword, password }),
        });
        if (!res.ok) {
            const data = await res.json().catch(() => ({}));
            throw new Error(data.detail || `Erreur ${res.status}`);
        }
        return await res.json();
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

    function showChangePassword() {
        if (!modal) {
            modal = new AuthModal();
        }
        modal.open("change-password");
    }

    return {
        init,
        getUser,
        isLoggedIn,
        setPendingImport,
        getPendingImport,
        clearPendingImport,
        onLogin,
        onLogout,
        register,
        login,
        logout,
        showModal,
        hideModal,
        showChangePassword,
        changePassword,
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
        this.overlay.innerHTML = this._buildHtml("login");
        document.body.appendChild(this.overlay);
        this._bindEvents();
        this._currentTab = "login";
    }

    _buildHtml(tab) {
        const isLogin = tab === "login";
        const isRegister = tab === "register";
        const isChangePassword = tab === "change-password";
        let title = "HarmonIA";
        let subtitle = "Connectez-vous pour enregistrer vos modèles.";
        let submitText = "Se connecter";
        let usernameVisible = true;
        let tabsVisible = true;
        let closeVisible = true;
        if (isRegister) {
            submitText = "Créer un compte";
        } else if (isChangePassword) {
            title = "Modifier le mot de passe";
            subtitle = "Entrez votre ancien mot de passe puis choisissez un nouveau.";
            submitText = "Enregistrer";
            usernameVisible = false;
            tabsVisible = false;
            closeVisible = true;
        }

        const tabsHtml = tabsVisible ? `
            <div class="auth-tabs">
                <button type="button" class="auth-tab ${isLogin ? "active" : ""}" data-tab="login">Connexion</button>
                <button type="button" class="auth-tab ${isRegister ? "active" : ""}" data-tab="register">Inscription</button>
            </div>
        ` : "";

        const usernameField = usernameVisible ? `
            <div class="auth-field">
                <label for="auth-username">Nom d'utilisateur</label>
                <input type="text" id="auth-username" autocomplete="username" required
                       pattern="^[a-zA-Z0-9_\-]+$" maxlength="64"
                       placeholder="votre_nom">
            </div>
        ` : "";

        const passwordField = isLogin ? `
            <div class="auth-field">
                <label for="auth-password">Mot de passe</label>
                <input type="password" id="auth-password" autocomplete="current-password" required
                       minlength="4" maxlength="128" placeholder="••••••••">
            </div>
        ` : (isRegister ? `
            <div class="auth-field">
                <label for="auth-password">Mot de passe</label>
                <input type="password" id="auth-password" autocomplete="new-password" required
                       minlength="4" maxlength="128" placeholder="••••••••">
            </div>
            <div class="auth-field">
                <label for="auth-password-confirm">Confirmer le mot de passe</label>
                <input type="password" id="auth-password-confirm" autocomplete="new-password" required
                       minlength="4" maxlength="128" placeholder="••••••••">
            </div>
        ` : `
            <div class="auth-field">
                <label for="auth-password">Ancien mot de passe</label>
                <input type="password" id="auth-password" autocomplete="current-password" required
                       minlength="4" maxlength="128" placeholder="••••••••">
            </div>
            <div class="auth-field">
                <label for="auth-password-new">Nouveau mot de passe</label>
                <input type="password" id="auth-password-new" autocomplete="new-password" required
                       minlength="4" maxlength="128" placeholder="••••••••">
            </div>
            <div class="auth-field">
                <label for="auth-password-confirm">Confirmer le mot de passe</label>
                <input type="password" id="auth-password-confirm" autocomplete="new-password" required
                       minlength="4" maxlength="128" placeholder="••••••••">
            </div>
        `);

        const closeBtnHtml = closeVisible ? `
            <button type="button" class="auth-close" id="auth-close" title="Fermer">
                <svg class="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M6 18L18 6M6 6l12 12"></path>
                </svg>
            </button>
        ` : "";

        return `
            <div class="auth-modal" data-mode="${tab}">
                <div class="auth-modal-header">
                    <h2 class="auth-modal-title">${title}</h2>
                    <p class="auth-modal-subtitle">${subtitle}</p>
                </div>
                ${tabsHtml}
                <form class="auth-form" id="auth-form">
                    ${usernameField}
                    ${passwordField}
                    <div class="auth-error hidden" id="auth-error"></div>
                    <button type="submit" class="auth-submit" id="auth-submit">${submitText}</button>
                </form>
                ${closeBtnHtml}
            </div>
        `;
    }

    _bindEvents() {
        const tabs = this.overlay.querySelectorAll(".auth-tab");
        tabs.forEach((tab) => {
            tab.addEventListener("click", () => this._switchTab(tab.dataset.tab));
        });

        const form = this.overlay.querySelector("#auth-form");
        form.addEventListener("submit", (e) => this._onSubmit(e));

        const closeBtn = this.overlay.querySelector("#auth-close");
        if (closeBtn) {
            closeBtn.addEventListener("click", () => this.close());
        }

        this.overlay.addEventListener("click", (e) => {
            if (e.target === this.overlay) this.close();
        });
    }

    _switchTab(tab) {
        const modal = this.overlay.querySelector(".auth-modal");
        modal.innerHTML = this._buildInnerHtml(tab);
        this._currentTab = tab;
        this._bindEvents();
    }

    _buildInnerHtml(tab) {
        // Same content as _buildHtml but without the outer .auth-modal wrapper.
        return this._buildHtml(tab).replace(/<div class="auth-modal"[^>]*>/, "").replace(/<\/div>\s*$/, "").trim();
    }

    _setError(msg) {
        const el = this.overlay.querySelector("#auth-error");
        el.textContent = msg;
        el.classList.toggle("hidden", !msg);
    }

    async _onSubmit(e) {
        e.preventDefault();
        this._setError("");
        const submit = this.overlay.querySelector("#auth-submit");
        submit.disabled = true;
        const originalText = submit.textContent;
        submit.textContent = "Enregistrement...";

        try {
            if (this._currentTab === "change-password") {
                const oldPassword = this.overlay.querySelector("#auth-password").value;
                const password = this.overlay.querySelector("#auth-password-new").value;
                const confirm = this.overlay.querySelector("#auth-password-confirm").value;
                if (password !== confirm) {
                    throw new Error("Les nouveaux mots de passe ne correspondent pas.");
                }
                await AuthManager.changePassword(oldPassword, password);
                this.close();
                return;
            }

            if (this._currentTab === "register") {
                const username = this.overlay.querySelector("#auth-username").value.trim();
                const password = this.overlay.querySelector("#auth-password").value;
                const confirm = this.overlay.querySelector("#auth-password-confirm").value;
                if (password !== confirm) {
                    throw new Error("Les mots de passe ne correspondent pas.");
                }
                submit.textContent = "Inscription...";
                await AuthManager.register(username, password);
                this.close();
                return;
            }

            const username = this.overlay.querySelector("#auth-username").value.trim();
            const password = this.overlay.querySelector("#auth-password").value;
            submit.textContent = "Connexion...";
            await AuthManager.login(username, password);
            this.close();
        } catch (err) {
            let msg = err.message;
            if (msg === "username_exists") msg = "Ce nom d'utilisateur est déjà pris.";
            else if (msg === "invalid_credentials") msg = "Nom d'utilisateur ou mot de passe incorrect.";
            else if (msg === "invalid_old_password") msg = "Ancien mot de passe incorrect.";
            this._setError(msg || "Une erreur est survenue.");
        } finally {
            submit.disabled = false;
            submit.textContent = originalText;
        }
    }

    open(tab = "login") {
        this._currentTab = tab;
        const modal = this.overlay.querySelector(".auth-modal");
        if (modal) {
            modal.innerHTML = this._buildInnerHtml(tab);
            this._bindEvents();
        }
        this.overlay.classList.remove("hidden");
        const firstInput = tab === "login" ? "#auth-username" : "#auth-password";
        setTimeout(() => this.overlay.querySelector(firstInput)?.focus(), 50);

    }

    close() {
        this.overlay.classList.add("hidden");
        this._setError("");
    }
}
