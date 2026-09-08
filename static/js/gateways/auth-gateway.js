/**
 * AuthGateway
 *
 * Encapsulates all authentication and user-related HTTP calls.
 * AuthManager and Shell access user/session capabilities through this gateway.
 */

const AuthGateway = (() => {
    async function me() {
        const res = await fetch("api/auth/me", { credentials: "same-origin" });
        if (!res.ok) throw new Error("not_authenticated");
        return res.json();
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
        return res.json();
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
        return res.json();
    }

    async function logout() {
        const res = await fetch("api/auth/logout", {
            method: "POST",
            credentials: "same-origin",
        });
        if (!res.ok) throw new Error(`Logout failed: ${res.status}`);
        return res.json();
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
        return res.json();
    }

    async function getUsage(scale = "day") {
        const res = await fetch(`api/auth/usage?scale=${encodeURIComponent(scale)}`, {
            method: "GET",
            credentials: "same-origin",
        });
        if (!res.ok) {
            const err = await res.json().catch(() => ({}));
            throw new Error(err.detail || `Usage failed: ${res.status}`);
        }
        return res.json();
    }

    return {
        me,
        login,
        register,
        logout,
        changePassword,
        getUsage,
    };
})();

window.AuthGateway = AuthGateway;
