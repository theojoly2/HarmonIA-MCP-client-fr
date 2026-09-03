/**
 * AppBase
 * Contrat minimal que toutes les apps doivent respecter.
 *
 * Chaque app est autonome. Elle ne doit pas importer/connaître directement
 * les autres apps. La communication passe exclusivement par EventBus ou par
 * AppState/WindowManager via des événements génériques.
 */

class AppBase {
    static id = "base";
    static title = "App";
    static iconSvg = "";
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

    get authManager() {
        // Lazy access to the global auth manager so apps do not hardcode it.
        return (typeof AppState !== "undefined" && AppState.authManager)
            || (typeof window !== "undefined" && window.AuthManager)
            || null;
    }

    get ui() {
        return (typeof window !== "undefined" && window.UiHelpers) || {};
    }

    _requireAuth() {
        if (AuthManager.isLoggedIn()) return true;
        if (this.authManager) this.authManager.showModal();
        return false;
    }

    /**
     * Central point to update all UI pieces that depend on the current set of
     * attached models. Called whenever models are added, removed, finished
     * loading or failed loading.
     */
    _syncModelUi() {
        this._updateImportButtonState(this.container?.querySelector('#assistant-import-model'));
        this._updateModelPill();
        if (typeof this._updateSearchResultAddButtons === 'function') {
            this._updateSearchResultAddButtons();
        }
    }

    /**
     * Build the app DOM in the given container.
     * Must set `this.container = container`.
     */
    render(container) {
        this.container = container;
        container.innerHTML = `<div class="p-8 text-center text-gray-500">App ${this.constructor.id} non implémentée.</div>`;
    }

    /**
     * Mount the app. Called by WindowManager after render.
     */
    async mount(container) {
        await this.render(container);
        this.mounted = true;
    }

    /**
     * Unmount the app. Release observers, timers, streams.
     */
    unmount() {
        this.mounted = false;
        this.container = null;
    }

    /**
     * Called when the tab is hidden but kept alive in the DOM cache.
     */
    onTabDeactivated() {}

    /**
     * Called when the cached tab DOM is re-attached to the shell.
     */
    onTabActivated() {}

    /**
     * Return a JSON-serializable snapshot of the instance state.
     */
    getState() {
        return {};
    }

    /**
     * Restore a previously saved state.
     */
    setState(state) {}

    /**
     * Return the current user-visible title.
     */
    getTitle() {
        return this.title || this.constructor.title;
    }

    /**
     * Update the user-visible title.
     */
    setTitle(title) {
        this.title = title;
    }

    /**
     * Return metadata used by WindowManager (mode, origin, etc.).
     */
    getMeta() {
        return { ...this.props };
    }

    /**
     * Fully reset the app to its initial/home state.
     * Apps that support a "new session / home" screen should override this.
     */
    resetToHome() {
        this.unmount();
    }

    /**
     * Permanently destroy the instance.
     */
    destroy() {
        this.unmount();
    }
}

window.AppBase = AppBase;
