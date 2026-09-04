/**
 * AssistantBridge
 *
 * Decouples the Assistant app from the Modeler app. The assistant only emits
 * events here; the bridge routes them to the correct modeler instance via the
 * service locator / EventBus. This removes direct method calls like
 * `modeler._reloadSvgFromServer()` from AssistantApp.
 */

const AssistantBridge = {
    notifySvgRefresh(linkedModelerInstanceId) {
        if (!linkedModelerInstanceId) return;
        const modeler = AppState.getInstance(linkedModelerInstanceId);
        if (modeler && typeof modeler._reloadSvgFromServer === 'function') {
            modeler._reloadSvgFromServer();
        }
    },
};

window.AssistantBridge = AssistantBridge;
