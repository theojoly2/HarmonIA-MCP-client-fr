/**
 * ModelerAssistantBridge
 * Handles the assistant split panel linked to a modeler instance.
 * Stateless; only coordinates AppState/WindowManager lookups.
 */

const ModelerAssistantBridge = (() => {
    function findSplitInstance(modelerInstanceId, modelName) {
        const targetName = modelName;
        const instances = AppState.listInstances();
        return instances.find((i) => {
            if (i.appId !== 'assistant') return false;
            const rec = AppState.getRecord(i.instanceId);
            if (!rec || rec.mode !== 'split') return false;
            const meta = rec.meta || {};
            if (meta.linkedModelerInstanceId === modelerInstanceId) return true;
            if (targetName && meta.modelName === targetName && meta.origin === 'modeler') return true;
            return false;
        }) || null;
    }

    async function toggleSplit(app) {
        if (!app.authManager?.isLoggedIn()) {
            app.authManager?.showModal?.();
            return;
        }
        const windowManager = ServiceLocator.get('windowManager');
        if (!app.storedName || !windowManager) return;
        const existing = findSplitInstance(app.instanceId, app.storedName);
        if (existing) {
            windowManager.collapseSplitTo(app.instanceId, existing.instanceId);
            EventBus.emit('modeler:update-assistant-toggle', { instanceId: app.instanceId });
            return;
        }

        let session = app._pendingAssistantSession || '';
        let displayName = app._pendingAssistantDisplayName || '';
        if (!session) {
            try {
                const data = await ModelGateway.findAssistantSession(app.storedName, 'modeler');
                if (data.session) {
                    session = data.session;
                    displayName = '';
                }
            } catch (err) {
                console.warn('No existing assistant session for model', app.storedName, err);
            }
        }
        EventBus.emit('assistant:prepare-linked-session', {
            instanceId: app.instanceId,
            session: '',
            displayName: '',
        });

        if (app._openingAssistant) return;
        app._openingAssistant = true;
        try {
            await windowManager.splitPanel(app.instanceId, 'assistant', {
                modelName: app.storedName,
                modelNames: [app.storedName],
                linkedModelerInstanceId: app.instanceId,
                origin: 'modeler',
                session,
                display_name: displayName,
                fromModeler: true,
            }, { ratio: [70, 30] });
            EventBus.emit('modeler:update-assistant-toggle', { instanceId: app.instanceId });
        } finally {
            app._openingAssistant = false;
        }
    }

    return {
        findSplitInstance,
        toggleSplit,
    };
})();

window.ModelerAssistantBridge = ModelerAssistantBridge;
