/**
 * ExternalApiGateway
 *
 * Encapsulates external API key management calls.
 */

const ExternalApiGateway = (() => {
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

    return {
        listKeys,
        createKey,
        revokeKey,
    };
})();

window.ExternalApiGateway = ExternalApiGateway;
