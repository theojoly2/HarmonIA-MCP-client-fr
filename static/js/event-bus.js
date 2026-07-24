/**
 * EventBus
 * Communication légère entre apps (ex: recherche -> preview, recherche -> chat).
 */

const EventBus = (() => {
    const handlers = {};

    function on(event, callback) {
        if (!handlers[event]) handlers[event] = [];
        handlers[event].push(callback);
        return () => off(event, callback);
    }

    function off(event, callback) {
        if (!handlers[event]) return;
        handlers[event] = handlers[event].filter(h => h !== callback);
    }

    function emit(event, payload) {
        (handlers[event] || []).forEach(h => {
            try { h(payload); } catch (e) { console.error(`EventBus error on ${event}:`, e); }
        });
    }

    return { on, off, emit };
})();

window.EventBus = EventBus;
