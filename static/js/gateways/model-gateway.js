/**
 * ModelGateway
 *
 * Encapsulates all model-related HTTP calls used by the modeler and assistant.
 * This is a thin, discoverable facade over ApiClient: it keeps business-level
 * model operations in one place so apps can request capabilities (import,
 * export, mutate, open) without scattering endpoint URLs throughout the UI.
 *
 * All methods return the same values/shapes as ApiClient to preserve existing
 * behaviour; apps can be migrated incrementally.
 */

const ModelGateway = (() => {
    function importFile(file) {
        return ApiClient.importModéliseurFile(file);
    }

    function importAndSave(file, name) {
        return ApiClient.importAndSaveModel(file, name);
    }

    function createEmpty(name) {
        return ApiClient.createEmptyModel(name);
    }

    function openSvg(name) {
        return ApiClient.getModelSvg(name);
    }

    function exportAsBlob(name, format) {
        return ApiClient.exportModel(name, format);
    }

    function findAssistantSession(name, origin = 'modeler') {
        return ApiClient.findAssistantSessionByModel(name, origin);
    }

    async function applyMutation(name, endpoint, body) {
        const encodedName = encodeURIComponent(name);
        const res = await fetch(`api/models/${encodedName}/${endpoint}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            credentials: 'same-origin',
            body: JSON.stringify(body),
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(data.detail || `Erreur ${res.status}`);
        return data;
    }

    async function reloadSvg(name) {
        const encodedName = encodeURIComponent(name);
        const res = await fetch(`api/models/${encodedName}/open`, {
            method: 'POST',
            credentials: 'same-origin',
        });
        if (!res.ok) throw new Error('reload_failed');
        return res.text();
    }

    async function deleteModel(name) {
        const res = await fetch(`api/models/${encodeURIComponent(name)}`, {
            method: 'DELETE',
            credentials: 'same-origin',
        });
        return { ok: res.ok, status: res.status, body: await res.json().catch(() => ({})) };
    }

    async function renameModel(name, newName) {
        const res = await fetch(`api/models/${encodeURIComponent(name)}/rename`, {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            credentials: 'same-origin',
            body: JSON.stringify({ name: newName }),
        });
        if (!res.ok) {
            const err = await res.json().catch(() => ({}));
            throw new Error(err.detail || `Rename failed: ${res.status}`);
        }
        return res.json().catch(() => ({}));
    }

    async function touchModel(name) {
        const res = await fetch(`api/models/${encodeURIComponent(name)}/touch`, {
            method: 'POST',
            credentials: 'same-origin',
        });
        return { ok: res.ok, status: res.status, body: await res.json().catch(() => ({})) };
    }

    function importAssistantModel(file, name, origin = 'assistant') {
        return ApiClient.importAssistantModel(file, name, origin);
    }

    function importDocumentAsAssistantModel(docId, origin = 'assistant') {
        return ApiClient.importDocumentAsAssistantModel(docId, origin);
    }

    return {
        importFile,
        importAndSave,
        createEmpty,
        openSvg,
        exportAsBlob,
        findAssistantSession,
        applyMutation,
        reloadSvg,
        deleteModel,
        renameModel,
        touchModel,
        importAssistantModel,
        importDocumentAsAssistantModel,
    };
})();

window.ModelGateway = ModelGateway;
