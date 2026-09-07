/**
 * DocumentGateway
 *
 * Encapsulates document file access, preview visualisation URL building
 * and chat streaming for individual documents.
 */

const DocumentGateway = (() => {
    function getFileUrl(documentId) {
        return `api/documents/${encodeURIComponent(documentId)}/file`;
    }

    function getVisualizeUrl(documentId) {
        return `api/documents/${encodeURIComponent(documentId)}/visualize`;
    }

    async function fetchFile(documentId) {
        const res = await fetch(getFileUrl(documentId), { credentials: "same-origin" });
        if (!res.ok) throw new Error(`file_fetch_failed:${res.status}`);
        return res;
    }

    async function fetchVisualizeSvg(documentId) {
        const res = await fetch(getVisualizeUrl(documentId), { credentials: "same-origin" });
        if (!res.ok) throw new Error(`Preview failed: ${res.status}`);
        return res.text();
    }

    async function streamChat(documentId, userMessage, history = []) {
        const res = await fetch("api/chat/stream", {
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
        getFileUrl,
        getVisualizeUrl,
        fetchFile,
        fetchVisualizeSvg,
        streamChat,
    };
})();

window.DocumentGateway = DocumentGateway;
