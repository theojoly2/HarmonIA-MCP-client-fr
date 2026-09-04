/**
 * ServiceLocator
 *
 * A tiny dependency registry that prevents apps from reaching directly into
 * global `window.*` services. All shared singletons (windowManager, historyPanel,
 * authManager, etc.) are registered here during bootstrap, and apps access them
 * through this locator.
 *
 * This keeps the frontend modular: an app does not need to know *where* a
 * service lives, only its interface contract.
 */

const ServiceLocator = {
    _services: {},

    register(name, service) {
        this._services[name] = service;
    },

    get(name) {
        return this._services[name] || null;
    },

    require(name) {
        const service = this._services[name];
        if (!service) {
            throw new Error(`Service '${name}' is not registered.`);
        }
        return service;
    },

    has(name) {
        return name in this._services;
    },
};

window.ServiceLocator = ServiceLocator;
