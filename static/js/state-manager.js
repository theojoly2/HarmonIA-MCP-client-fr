/**
 * StateManager
 * Centralise l'état de toutes les fenêtres/apps pour la session en cours.
 * Un F5 recharge tout ; pendant la session, chaque instance conserve son contexte.
 */

const AppState = (() => {
    const store = {
        // instances: { [instanceId]: { appId, mode, state, meta } }
        instances: new Map(),
        activeInstanceId: null,
        registry: new Map(), // appId -> AppClass
        counter: 0,
    };

    function generateId() {
        return `inst_${++store.counter}_${Date.now().toString(36)}`;
    }

    function registerApp(appClass) {
        store.registry.set(appClass.id, appClass);
    }

    function createInstance(appId, props = {}) {
        const AppClass = store.registry.get(appId);
        if (!AppClass) throw new Error(`App non enregistrée: ${appId}`);
        const instanceId = generateId();
        const instance = new AppClass(instanceId, props);
        store.instances.set(instanceId, {
            appId,
            instance,
            mode: props.mode || "tab",
            savedState: {},
            meta: { ...props },
        });
        return { instanceId, instance };
    }

    function getInstance(instanceId) {
        return store.instances.get(instanceId)?.instance;
    }

    function getRecord(instanceId) {
        return store.instances.get(instanceId);
    }

    function saveInstanceState(instanceId) {
        const record = store.instances.get(instanceId);
        if (!record || !record.instance) return;
        record.savedState = record.instance.getState ? record.instance.getState() : {};
        record.meta = record.instance.getMeta ? record.instance.getMeta() : record.meta;
    }

    function restoreInstanceState(instanceId) {
        const record = store.instances.get(instanceId);
        if (!record || !record.instance) return;
        // Only restore if there is actual saved state; an empty saved state should not
        // overwrite data that was just initialized (e.g. tags loaded during render).
        if (record.instance.setState && Object.keys(record.savedState).length) {
            record.instance.setState(record.savedState);
        }
    }

    function removeInstance(instanceId) {
        saveInstanceState(instanceId);
        const record = store.instances.get(instanceId);
        if (record && record.instance && record.instance.destroy) {
            record.instance.destroy();
        }
        store.instances.delete(instanceId);
    }

    function listInstances() {
        return Array.from(store.instances.entries()).map(([id, rec]) => ({
            instanceId: id,
            appId: rec.appId,
            mode: rec.mode,
            title: rec.instance?.getTitle?.() || rec.appId,
        }));
    }

    function setActiveInstance(instanceId) {
        store.activeInstanceId = instanceId;
    }

    function getActiveInstance() {
        return store.activeInstanceId;
    }

    function getActiveAppId() {
        if (!store.activeInstanceId) return null;
        const rec = store.instances.get(store.activeInstanceId);
        return rec ? rec.appId : null;
    }

    return {
        registerApp,
        createInstance,
        getInstance,
        getRecord,
        saveInstanceState,
        restoreInstanceState,
        removeInstance,
        listInstances,
        setActiveInstance,
        getActiveInstance,
        getActiveAppId,
    };
})();

window.AppState = AppState;
