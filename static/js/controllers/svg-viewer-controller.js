/**
 * SvgViewerController
 *
 * Encapsulates the lifecycle of an SvgViewer instance tied to a DOM container:
 * create, set SVG, center/restore state, destroy, and ResizeObserver integration.
 *
 * This avoids duplicating SvgViewer setup logic between ModelerApp and PreviewApp.
 */

class SvgViewerController {
    constructor(containerSelector, options = {}) {
        this.containerSelector = containerSelector;
        this.onTransform = options.onTransform || (() => {});
        this._resizeObserver = null;
        this._lastContainerSize = null;
        this.viewer = null;
    }

    getContainer(root) {
        return root.querySelector(this.containerSelector);
    }

    ensureViewer(root, createOptions = {}) {
        const container = this.getContainer(root);
        if (!container) return null;
        if (!this.viewer) {
            this.viewer = new SvgViewer(container, {
                onTransform: (state) => {
                    this.onTransform(state);
                },
                ...createOptions,
            });
        }
        return this.viewer;
    }

    renderSvg(root, svgText, mainClassName = '', options = {}) {
        return new Promise((resolve) => {
            const container = this.getContainer(root);
            if (!container) return resolve();
            const { shouldCenter = true, stateToRestore = null, onComplete = null } = options;
            const viewer = this.ensureViewer(root);
            if (!viewer) return resolve();

            requestAnimationFrame(() => {
                requestAnimationFrame(() => {
                    viewer.setSvg(svgText, mainClassName);

                    const finalize = () => {
                        if (shouldCenter) {
                            viewer.resetZoom();
                        } else if (stateToRestore) {
                            viewer.restoreState(stateToRestore);
                            viewer.applyTransform();
                        }
                        // Force layout so the browser finishes rendering.
                        viewer.container.getBoundingClientRect();
                        if (viewer.svg) viewer.svg.getBBox();
                        requestAnimationFrame(() => {
                            if (onComplete) onComplete();
                            resolve();
                        });
                    };

                    requestAnimationFrame(() => {
                        requestAnimationFrame(finalize);
                    });
                });
            });
        });
    }

    observeResize(root, shouldSkipInitial = true) {
        const container = this.getContainer(root);
        if (!container || typeof ResizeObserver === 'undefined') return;
        if (this._resizeObserver) this._resizeObserver.disconnect();
        this._lastContainerSize = null;
        this._resizeObserver = new ResizeObserver((entries) => {
            if (!this.viewer) return;
            const entry = entries[0];
            if (!entry) return;
            const cr = entry.contentRect;
            if (!this._lastContainerSize) {
                this._lastContainerSize = { width: cr.width, height: cr.height };
                return;
            }
            const prev = this._lastContainerSize;
            const dw = cr.width - prev.width;
            const dh = cr.height - prev.height;
            if (Math.abs(dw) < 2 && Math.abs(dh) < 2) {
                this._lastContainerSize = { width: cr.width, height: cr.height };
                return;
            }
            this.viewer.state.x += dw / 2;
            this.viewer.state.y += dh / 2;
            this.viewer.applyTransform();
            this._lastContainerSize = { width: cr.width, height: cr.height };
        });
        this._resizeObserver.observe(container);
    }

    destroy() {
        if (this._resizeObserver) {
            this._resizeObserver.disconnect();
            this._resizeObserver = null;
        }
        if (this.viewer) {
            this.viewer.destroy();
            this.viewer = null;
        }
        this._lastContainerSize = null;
    }

    getState() {
        return this.viewer ? this.viewer.getState() : { scale: 1, x: 0, y: 0 };
    }

    centerDiagram(mainClassName) {
        if (this.viewer) this.viewer.centerDiagram(mainClassName);
    }
}

window.SvgViewerController = SvgViewerController;
