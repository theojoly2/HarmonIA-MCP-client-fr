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

    async function importModéliseurFile(file) {
        const formData = new FormData();
        formData.append("file", file);
        const res = await fetch(apiUrl("modeler/import"), {
            method: "POST",
            credentials: "same-origin",
            body: formData,
        });
        if (!res.ok) throw new Error(`Modéliseur import failed: ${res.status}`);
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

    async function importAssistantModel(file, name) {
        const formData = new FormData();
        formData.append("file", file);
        if (name) formData.append("name", name);
        const res = await fetch(apiUrl("assistant/import"), {
            method: "POST",
            credentials: "same-origin",
            body: formData,
        });
        if (!res.ok) {
            if (res.status === 401) throw new Error("not_authenticated");
            const err = await res.json().catch(() => ({}));
            throw new Error(err.detail || `Assistant model import failed: ${res.status}`);
        }
        return res.json();
    }

    async function getModelSvg(name) {
        const res = await fetch(apiUrl(`models/${encodeURIComponent(name)}/open`), {
            method: "POST",
            credentials: "same-origin",
        });
        if (!res.ok) throw new Error(`Model open failed: ${res.status}`);
        return { svgText: await res.text(), modelName: res.headers.get("X-Model-Name") || name };
    }

    async function createEmptyModel(name) {
        const res = await fetch(apiUrl("models/create-empty"), {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            credentials: "same-origin",
            body: JSON.stringify({ name }),
        });
        if (!res.ok) {
            if (res.status === 401) throw new Error("not_authenticated");
            throw new Error(`Create empty model failed: ${res.status}`);
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

    async function touchSearch(searchId) {
        const res = await fetch(apiUrl(`searches/${searchId}/open`), {
            method: "POST",
            credentials: "same-origin",
        });
        if (!res.ok) throw new Error(`Touch search failed: ${res.status}`);
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

    async function streamAssistant(session, userMessage, modelName, onEvent, signal) {
        const res = await fetch(apiUrl("assistant/stream"), {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            credentials: "same-origin",
            body: JSON.stringify({ session, user_message: userMessage, model_name: modelName || "" }),
            signal,
        });
        if (!res.ok || !res.body) throw new Error(`Assistant stream failed: ${res.status}`);

        // Read SSE events one at a time and force the browser to paint after each
        // event, so every assistant loop / tool card / text update is rendered
        // before the next event is consumed.
        const reader = res.body.getReader();
        const decoder = new TextDecoder("utf-8");
        let buffer = "";

        // Force a real browser paint. requestAnimationFrame alone is not enough when
        // events arrive in a burst; the style->macro-task->paint sequence guarantees
        // the DOM changes are visible before we continue reading the stream.
        const forcePaint = () =>
            new Promise((resolve) => {
                requestAnimationFrame(() => {
                    setTimeout(() => {
                        requestAnimationFrame(resolve);
                    }, 0);
                });
            });

        const handleLine = async (line) => {
            const ev = JSON.parse(line);
            try {
                await onEvent(ev);
            } catch (err) {
                console.error("Assistant event handler error", err, ev);
            }
            // Make structural events visible immediately. For text we let the
            // typewriter handle the pace, but for every milestone event we force a
            // layout + paint so the user sees the tool card / status before the
            // next chunk arrives.
            if (ev.kind === "loop_done" || ev.kind === "assistant_done" || ev.kind === "tool_result" || ev.kind === "tool_start" || ev.kind === "assistant_tool_calls") {
                await forcePaint();
            } else {
                await new Promise((resolve) => requestAnimationFrame(resolve));
            }
        };

        while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            buffer += decoder.decode(value, { stream: true });
            const rawLines = buffer.split("\n");
            buffer = rawLines.pop() || "";

            for (let i = 0; i < rawLines.length; i++) {
                const rawLine = rawLines[i];
                const line = rawLine.replace(/^data:\s*/, "").trim();
                if (!line) continue;
                // SSE comments start with ":" and are used as heartbeats to force
                // reverse proxies to flush their buffers. The client ignores them.
                if (line.startsWith("event:") || line.startsWith("id:")) continue;
                if (line.startsWith(":")) continue;
                try {
                    await handleLine(line);
                } catch (err) {
                    console.error("Assistant event parse/handler error", err, line);
                }
            }
        }

        const tail = buffer.replace(/^data:\s*/, "").trim();
        if (tail) {
            try {
                await handleLine(tail);
            } catch (err) {
                console.error("Assistant trailing event parse/handler error", err, tail);
            }
        }
    }

    async function getAssistantSessions() {
        const res = await fetch(apiUrl("assistant/sessions"), { credentials: "same-origin" });
        if (!res.ok) throw new Error(`Assistant sessions failed: ${res.status}`);
        return res.json();
    }

    async function getAssistantHistory(session) {
        // History is loaded directly from the JSON persistence in the backend;
        // for now the assistant app re-creates messages from display_messages.
        // This helper can be extended if a dedicated endpoint is added.
        return { messages: [] };
    }

    return {
        postSearch,
        getTags,
        getDocumentFileUrl,
        getDocumentVisualizeUrl,
        importModéliseurFile,
        importAndSaveModel,
        importAssistantModel,
        getModelSvg,
        createEmptyModel,
        getModels,
        saveSearch,
        getSearches,
        deleteSearch,
        touchSearch,
        me,
        login,
        register,
        logout,
        streamChat,
        streamAssistant,
        getAssistantSessions,
        getAssistantHistory,
    };
})();

window.ApiClient = ApiClient;
