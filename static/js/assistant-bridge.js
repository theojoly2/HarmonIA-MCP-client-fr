/**
 * AssistantBridge
 *
 * Decouples the Assistant app from the Modeler app. The assistant only emits
 * events; the bridge routes them through EventBus so the assistant never calls
 * modeler methods directly.
 */

const AssistantBridge = {
    notifySvgRefresh(linkedModelerInstanceId) {
        if (!linkedModelerInstanceId) return;
        EventBus.emit('modeler:reload-svg', { instanceId: linkedModelerInstanceId });
    },
};

window.AssistantBridge = AssistantBridge;
