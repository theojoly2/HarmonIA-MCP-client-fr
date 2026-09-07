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
    async function importFile(file) {
        const formData = new FormData();
        formData.append('file', file);
        const res = await fetch('api/modeler/import', {
            method: 'POST',
            credentials: 'same-origin',
            body: formData,
        });
        if (!res.ok) throw new Error(`Modéliseur import failed: ${res.status}`);
        return res.text();
    }

    async function importAndSave(file, name) {
        const formData = new FormData();
        formData.append('file', file);
        if (name) formData.append('name', name);
        const res = await fetch('api/models/import', {
            method: 'POST',
            credentials: 'same-origin',
            body: formData,
        });
        if (!res.ok) {
            if (res.status === 401) throw new Error('not_authenticated');
            throw new Error(`Model import failed: ${res.status}`);
        }
        return res.json();
    }

    async function createEmpty(name) {
        const res = await fetch('api/models/create-empty', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            credentials: 'same-origin',
            body: JSON.stringify({ name }),
        });
        if (!res.ok) {
            if (res.status === 401) throw new Error('not_authenticated');
            throw new Error(`Create empty model failed: ${res.status}`);
        }
        return res.json();
    }

    async function openSvg(name) {
        const res = await fetch(`api/models/${encodeURIComponent(name)}/open`, {
            method: 'POST',
            credentials: 'same-origin',
        });
        if (!res.ok) throw new Error(`Model open failed: ${res.status}`);
        return { svgText: await res.text(), modelName: res.headers.get('X-Model-Name') || name };
    }

    async function exportAsBlob(name, format) {
        const res = await fetch(
            `api/models/${encodeURIComponent(name)}/export?format=${encodeURIComponent(format)}`,
            { method: 'GET', credentials: 'same-origin' }
        );
        if (!res.ok) {
            const err = await res.json().catch(() => ({}));
            throw new Error(err.detail || `Export failed: ${res.status}`);
        }
        return res.blob();
    }

    function findAssistantSession(name, origin = 'modeler') {
        return AssistantGateway.findAssistantSessionByModel(name, origin);
    }

    async function getModels() {
        const res = await fetch('api/models', { credentials: 'same-origin' });
        if (!res.ok) throw new Error(`Models list failed: ${res.status}`);
        return res.json();
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

    async function importAssistantModel(file, name, origin = 'assistant') {
        const form = new FormData();
        form.append('file', file);
        if (name) form.append('name', name);
        form.append('origin', origin);
        const res = await fetch('api/assistant/import', {
            method: 'POST',
            credentials: 'same-origin',
            body: form,
        });
        if (!res.ok) {
            const err = await res.json().catch(() => ({}));
            throw new Error(err.detail || `Assistant model import failed: ${res.status}`);
        }
        return res.json();
    }

    async function importDocumentAsAssistantModel(docId, origin = 'assistant') {
        const res = await fetch('api/assistant/import-from-document', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            credentials: 'same-origin',
            body: JSON.stringify({ doc_id: docId, origin }),
        });
        if (!res.ok) {
            const err = await res.json().catch(() => ({}));
            throw new Error(err.detail || `Assistant model import from document failed: ${res.status}`);
        }
        return res.json();
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
        getModels,
        importAssistantModel,
        importDocumentAsAssistantModel,
    };
})();

window.ModelGateway = ModelGateway;
