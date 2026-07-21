/**
 * AppBase
 * Classe abstraite que toutes les apps doivent étendre.
 */

class AppBase {
    static id = "base";
    static title = "App";
    static icon = "";
    static canFloat = true;
    static canSplit = true;
    static singleton = false;

    constructor(instanceId, props = {}) {
        this.instanceId = instanceId;
        this.props = props;
        this.title = this.constructor.title;
        this.container = null;
        this.mounted = false;
    }

    // À surcharger
    render(container) {
        this.container = container;
        container.innerHTML = `<div class="p-8 text-center text-gray-500">App ${this.constructor.id} non implémentée.</div>`;
    }

    mount(container) {
        this.render(container);
        this.mounted = true;
    }

    unmount() {
        this.mounted = false;
        this.container = null;
    }

    getState() {
        return {};
    }

    setState(state) {}

    getTitle() {
        return this.title || this.constructor.title;
    }

    setTitle(title) {
        this.title = title;
    }

    getMeta() {
        return { ...this.props };
    }

    destroy() {
        this.unmount();
    }
}

window.AppBase = AppBase;
