/**
 * ApiClient
 * Centralise tous les appels HTTP vers le backend FastAPI.
 */

const ApiClient = (() => {
    function apiUrl(path) {
        // Use relative URLs so the app works behind a reverse proxy / sub-path.
        return `api/${path}`;
    }

    async function postSearch(query, tags = [], limit = 20) {
        const res = await fetch(apiUrl("search"), {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ q: query, tags, limit }),
        });
        if (!res.ok) throw new Error(`Search failed: ${res.status}`);
        return res.json();
    }

    async function getTags() {
        const res = await fetch(apiUrl("search/tags"));
        if (!res.ok) throw new Error(`Tags failed: ${res.status}`);
        return res.json();
    }

    function getDocumentFileUrl(documentId) {
        return apiUrl(`documents/${encodeURIComponent(documentId)}/file`);
    }

    function getDocumentVisualizeUrl(documentId) {
        return apiUrl(`documents/${encodeURIComponent(documentId)}/visualize`);
    }

    async function importVisionFile(file) {
        const formData = new FormData();
        formData.append("file", file);
        const res = await fetch(apiUrl("vision/import"), {
            method: "POST",
            credentials: "same-origin",
            body: formData,
        });
        if (!res.ok) throw new Error(`Vision import failed: ${res.status}`);
        return res.text();
    }

    async function importAndSaveModel(file, name) {
        const formData = new FormData();
        formData.append("file", file);
        if (name) formData.append("name", name);
        const res = await fetch(apiUrl("models/import"), {
            method: "POST",
            credentials: "same-origin",
            body: formData,
        });
        if (!res.ok) {
            if (res.status === 401) throw new Error("not_authenticated");
            throw new Error(`Model import failed: ${res.status}`);
        }
        return res.json();
    }

    async function getModels() {
        const res = await fetch(apiUrl("models"), { credentials: "same-origin" });
        if (!res.ok) throw new Error(`Models list failed: ${res.status}`);
        return res.json();
    }

    async function saveSearch(query, tags = []) {
        const res = await fetch(apiUrl("searches"), {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            credentials: "same-origin",
            body: JSON.stringify({ query, tags }),
        });
        if (!res.ok) {
            if (res.status === 401) throw new Error("not_authenticated");
            throw new Error(`Save search failed: ${res.status}`);
        }
        return res.json();
    }

    async function getSearches() {
        const res = await fetch(apiUrl("searches"), { credentials: "same-origin" });
        if (!res.ok) throw new Error(`Searches list failed: ${res.status}`);
        return res.json();
    }

    async function deleteSearch(searchId) {
        const res = await fetch(apiUrl(`searches/${searchId}`), {
            method: "DELETE",
            credentials: "same-origin",
        });
        if (!res.ok) throw new Error(`Delete search failed: ${res.status}`);
        return res.json();
    }

    async function me() {
        const res = await fetch(apiUrl("auth/me"), { credentials: "same-origin" });
        if (!res.ok) throw new Error("not_authenticated");
        return res.json();
    }

    async function login(username, password) {
        const res = await fetch(apiUrl("auth/login"), {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            credentials: "same-origin",
            body: JSON.stringify({ username, password }),
        });
        if (!res.ok) throw new Error(`Login failed: ${res.status}`);
        return res.json();
    }

    async function register(username, password) {
        const res = await fetch(apiUrl("auth/register"), {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            credentials: "same-origin",
            body: JSON.stringify({ username, password }),
        });
        if (!res.ok) throw new Error(`Register failed: ${res.status}`);
        return res.json();
    }

    async function logout() {
        const res = await fetch(apiUrl("auth/logout"), {
            method: "POST",
            credentials: "same-origin",
        });
        if (!res.ok) throw new Error(`Logout failed: ${res.status}`);
        return res.json();
    }

    async function streamChat(documentId, userMessage, history = []) {
        const res = await fetch(apiUrl("chat/stream"), {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
                document_id: documentId,
                user_message: userMessage,
                history,
            }),
        });
        if (!res.ok || !res.body) throw new Error(`Chat stream failed: ${res.status}`);
        return res.body.getReader();
    }

    return {
        postSearch,
        getTags,
        getDocumentFileUrl,
        getDocumentVisualizeUrl,
        importVisionFile,
        importAndSaveModel,
        getModels,
        saveSearch,
        getSearches,
        deleteSearch,
        me,
        login,
        register,
        logout,
        streamChat,
    };
})();

window.ApiClient = ApiClient;
