/**
 * AssistantGateway
 *
 * Encapsulates all assistant/conversation HTTP calls and SSE streaming.
 */

const AssistantGateway = (() => {
    async function streamAssistant(session, userMessage, modelNames, tags, onEvent, options = {}) {
        const origin = options.origin || "assistant";
        const namesPayload = Array.isArray(modelNames)
            ? modelNames.filter(Boolean)
            : (modelNames ? [String(modelNames)] : []);
        const body = namesPayload.length === 1
            ? { session, user_message: userMessage, model_name: namesPayload[0], tags: tags || [], origin }
            : { session, user_message: userMessage, model_names: namesPayload, tags: tags || [], origin };
        const res = await fetch(`api/assistant/stream`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            credentials: "same-origin",
            body: JSON.stringify(body),
        });
        if (!res.ok || !res.body) throw new Error(`Assistant stream failed: ${res.status}`);

        const reader = res.body.getReader();
        const decoder = new TextDecoder("utf-8");
        let buffer = "";

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

            for (const rawLine of rawLines) {
                const line = rawLine.replace(/^data:\s*/, "").trim();
                if (!line) continue;
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

    async function getAssistantSessions(origin) {
        const qs = origin ? `?origin=${encodeURIComponent(origin)}` : "";
        const res = await fetch(`api/assistant/sessions${qs}`, { credentials: "same-origin" });
        if (!res.ok) throw new Error(`Assistant sessions failed: ${res.status}`);
        return res.json();
    }

    async function getAssistantSessionsAll() {
        const [assistantRes, externalRes] = await Promise.all([
            getAssistantSessions("assistant"),
            getAssistantSessions("external_api").catch(() => ({ sessions: [] })),
        ]);
        const sessions = [
            ...(assistantRes.sessions || []),
            ...(externalRes.sessions || []),
        ];
        const seen = new Set();
        return {
            sessions: sessions.filter((s) => {
                if (seen.has(s.name)) return false;
                seen.add(s.name);
                return true;
            }),
        };
    }

    async function findAssistantSessionByModel(modelName, origin = "modeler") {
        const res = await fetch(`api/assistant/sessions/by-model?model_name=${encodeURIComponent(modelName)}&origin=${encodeURIComponent(origin)}`, {
            credentials: "same-origin",
        });
        if (res.status === 404) return { session: "" };
        if (!res.ok) throw new Error(`findAssistantSessionByModel failed: ${res.status}`);
        return res.json();
    }

    async function getAssistantHistory(session, origin = "assistant") {
        if (!session) return { messages: [] };
        const res = await fetch(`api/assistant/history?session=${encodeURIComponent(session)}&origin=${encodeURIComponent(origin)}`, {
            credentials: "same-origin",
        });
        if (!res.ok) throw new Error(`Assistant history failed: ${res.status}`);
        return res.json();
    }

    async function deleteAssistantSession(session, origin = "assistant") {
        if (!session) return { ok: true };
        const res = await fetch(`api/assistant/sessions/${encodeURIComponent(session)}?origin=${encodeURIComponent(origin)}`, {
            method: "DELETE",
            credentials: "same-origin",
        });
        if (!res.ok) throw new Error(`Assistant session delete failed: ${res.status}`);
        return res.json();
    }

    async function touchAssistantSession(session, origin = "assistant") {
        if (!session) return { ok: true };
        const res = await fetch(`api/assistant/sessions/${encodeURIComponent(session)}/open?origin=${encodeURIComponent(origin)}`, {
            method: "POST",
            credentials: "same-origin",
        });
        if (!res.ok) throw new Error(`Assistant session touch failed: ${res.status}`);
        return res.json();
    }

    async function renameAssistantSession(session, newName, origin = "assistant") {
        const res = await fetch(`api/assistant/sessions/${encodeURIComponent(session)}/rename?origin=${encodeURIComponent(origin)}`, {
            method: "PATCH",
            headers: { "Content-Type": "application/json" },
            credentials: "same-origin",
            body: JSON.stringify({ name: newName }),
        });
        if (!res.ok) {
            const err = await res.json().catch(() => ({}));
            throw new Error(err.detail || `Rename failed: ${res.status}`);
        }
        return res.json().catch(() => ({}));
    }

    async function linkAssistantSessionModel(session, modelName, origin = "modeler") {
        const res = await fetch(`api/assistant/sessions/${encodeURIComponent(session)}/link-model`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            credentials: "same-origin",
            body: JSON.stringify({ model_name: modelName }),
        });
        if (!res.ok) {
            const err = await res.json().catch(() => ({}));
            throw new Error(err.detail || `Link model failed: ${res.status}`);
        }
        return res.json().catch(() => ({}));
    }

    return {
        streamAssistant,
        getAssistantSessions,
        getAssistantSessionsAll,
        findAssistantSessionByModel,
        getAssistantHistory,
        deleteAssistantSession,
        touchAssistantSession,
        renameAssistantSession,
        linkAssistantSessionModel,
    };
})();

window.AssistantGateway = AssistantGateway;
