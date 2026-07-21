/**
 * SvgViewer
 * Composant réutilisable de zoom/pan pour diagrammes SVG.
 * Peut être utilisé par VisionApp, PreviewApp, ou toute future app.
 */

class SvgViewer {
    constructor(container, options = {}) {
        this.container = container;
        this.canvas = null;
        this.svg = null;
        this.state = {
            scale: options.defaultScale || 1,
            x: 0,
            y: 0,
            isDragging: false,
            lastX: 0,
            lastY: 0,
        };
        this.minZoom = options.minZoom || 0.2;
        this.maxZoom = options.maxZoom || 4;
        this.onTransform = options.onTransform || (() => {});
        this._listeners = [];
        this._init();
    }

    _init() {
        this.container.classList.add('svg-viewer');
        this.container.innerHTML = `
            <div class="svg-canvas"></div>
            <div class="svg-controls">
                <button class="svg-ctrl-btn" title="Zoom avant">+</button>
                <button class="svg-ctrl-btn" title="Zoom arrière">−</button>
                <button class="svg-ctrl-btn" title="Réinitialiser">⟲</button>
            </div>
        `;
        this.canvas = this.container.querySelector('.svg-canvas');
        const [zoomIn, zoomOut, reset] = this.container.querySelectorAll('.svg-ctrl-btn');
        this._bind(zoomIn, 'click', () => this.zoomAtCenter(1.2));
        this._bind(zoomOut, 'click', () => this.zoomAtCenter(1 / 1.2));
        this._bind(reset, 'click', () => this.resetZoom());

        this._bind(this.container, 'wheel', (e) => {
            if (!this.svg) return;
            e.preventDefault();
            const factor = e.deltaY > 0 ? 0.9 : 1.1;
            const rect = this.container.getBoundingClientRect();
            this.zoomAt({
                x: e.clientX - rect.left,
                y: e.clientY - rect.top,
            }, factor);
        }, { passive: false });

        this._bind(this.container, 'mousedown', (e) => {
            if (!this.svg || e.target.closest('.svg-controls')) return;
            this.state.isDragging = true;
            this.state.lastX = e.clientX;
            this.state.lastY = e.clientY;
            this.container.style.cursor = 'grabbing';
        });

        this._bind(window, 'mousemove', (e) => {
            if (!this.state.isDragging) return;
            const dx = e.clientX - this.state.lastX;
            const dy = e.clientY - this.state.lastY;
            this.state.lastX = e.clientX;
            this.state.lastY = e.clientY;
            this.state.x += dx;
            this.state.y += dy;
            this.applyTransform();
        });

        this._bind(window, 'mouseup', () => {
            if (this.state.isDragging) {
                this.state.isDragging = false;
                this.container.style.cursor = '';
            }
        });
    }

    _bind(target, event, handler, options) {
        target.addEventListener(event, handler, options);
        this._listeners.push({ target, event, handler, options });
    }

    setSvg(svgText, mainClassName = '') {
        this.canvas.innerHTML = svgText
            .replace(/style="background:#000000;"/g, 'style="background:#ffffff;"')
            .replace(/background:#000000/g, 'background:#ffffff')
            .replace(/<svg/, '<svg class="svg-diagram"');
        this.svg = this.canvas.querySelector('svg.svg-diagram');
    }

    setSvgAndRestore(svgText, mainClassName = '', state = null) {
        this.setSvg(svgText, mainClassName);
        if (state) {
            this.restoreState(state);
        } else {
            requestAnimationFrame(() => requestAnimationFrame(() => this.centerDiagram(mainClassName)));
        }
    }

    restoreState(state) {
        this.state.scale = state.scale ?? 1;
        this.state.x = state.x ?? 0;
        this.state.y = state.y ?? 0;
        this.applyTransform();
    }

    getState() {
        return { scale: this.state.scale, x: this.state.x, y: this.state.y };
    }

    setState(state) {
        this.state.scale = state.scale ?? 1;
        this.state.x = state.x ?? 0;
        this.state.y = state.y ?? 0;
        this.applyTransform();
    }

    applyTransform() {
        this.clampPan();
        this.canvas.style.transform = `translate(${this.state.x}px, ${this.state.y}px) scale(${this.state.scale})`;
        this.onTransform(this.getState());
    }

    getDiagramBounds() {
        if (!this.svg) return null;
        try {
            const bbox = this.svg.getBBox();
            return { x: bbox.x, y: bbox.y, width: bbox.width, height: bbox.height };
        } catch (e) {
            const width = parseFloat(this.svg.getAttribute('width')) || this.container.clientWidth;
            const height = parseFloat(this.svg.getAttribute('height')) || this.container.clientHeight;
            return { x: 0, y: 0, width, height };
        }
    }

    clampPan() {
        if (!this.svg) return;
        const rect = this.container.getBoundingClientRect();
        let bounds;
        try { bounds = this.svg.getBBox(); }
        catch (e) { bounds = { x: 0, y: 0, width: parseFloat(this.svg.getAttribute('width')) || rect.width, height: parseFloat(this.svg.getAttribute('height')) || rect.height }; }
        if (!bounds || !bounds.width || !bounds.height) return;
        const maxOverflow = 60;
        const scaledWidth = bounds.width * this.state.scale;
        const scaledHeight = bounds.height * this.state.scale;
        const minScreenLeft = maxOverflow - scaledWidth;
        const maxScreenLeft = rect.width - maxOverflow;
        const minScreenTop = maxOverflow - scaledHeight;
        const maxScreenTop = rect.height - maxOverflow;
        const currentScreenLeft = this.state.x + bounds.x * this.state.scale;
        const currentScreenTop = this.state.y + bounds.y * this.state.scale;
        const clampedScreenLeft = Math.max(minScreenLeft, Math.min(maxScreenLeft, currentScreenLeft));
        const clampedScreenTop = Math.max(minScreenTop, Math.min(maxScreenTop, currentScreenTop));
        this.state.x = clampedScreenLeft - bounds.x * this.state.scale;
        this.state.y = clampedScreenTop - bounds.y * this.state.scale;
    }

    centerDiagram(mainClassName = '') {
        if (!this.svg) return;
        const rect = this.container.getBoundingClientRect();
        let target = null;
        if (mainClassName) {
            const texts = this.svg.querySelectorAll('text');
            for (const textEl of texts) {
                if (textEl.textContent.trim() === mainClassName) {
                    try {
                        const parent = textEl.closest('g') || textEl;
                        target = parent.getBBox();
                        break;
                    } catch (e) {}
                }
            }
        }
        if (!target) {
            try { target = this.svg.getBBox(); }
            catch (e) { target = { x: 0, y: 0, width: rect.width, height: rect.height }; }
        }
        if (!target || target.width <= 0 || target.height <= 0) return;
        this.state.scale = 1;
        this.state.x = (rect.width / 2) - (target.x + target.width / 2) * this.state.scale;
        this.state.y = (rect.height / 2) - (target.y + target.height / 2) * this.state.scale;
        this.applyTransform();
    }

    zoomAt(point, factor) {
        const newScale = Math.min(this.maxZoom, Math.max(this.minZoom, this.state.scale * factor));
        this.state.x = point.x - (point.x - this.state.x) * (newScale / this.state.scale);
        this.state.y = point.y - (point.y - this.state.y) * (newScale / this.state.scale);
        this.state.scale = newScale;
        this.applyTransform();
    }

    zoomAtCenter(factor) {
        const rect = this.container.getBoundingClientRect();
        this.zoomAt({ x: rect.width / 2, y: rect.height / 2 }, factor);
    }

    resetZoom() {
        this.state.scale = 1;
        this.centerDiagram();
    }

    destroy() {
        this._listeners.forEach(({ target, event, handler, options }) => {
            target.removeEventListener(event, handler, options);
        });
        this._listeners = [];
        if (this.container) this.container.innerHTML = '';
    }
}

window.SvgViewer = SvgViewer;
