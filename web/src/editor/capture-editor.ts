import { ANNOTATION_SCHEMA_VERSION } from '@snapping-turtle/shared/constants';
import {
  annotationSizes,
  type AnnotationDocument,
  type AnnotationSizes,
  type Shape,
} from '@snapping-turtle/shared/annotations';
import { RETENTION_CHOICES_DAYS } from '@snapping-turtle/shared/api';
import { Canvas, FabricImage, IText, type FabricObject, type TPointerEventInfo } from 'fabric';
import { ApiError, annotations as annotationsApi, describeError, patchCapture } from '../api.js';
import { el } from '../dom.js';
import { newShapeId } from './model.js';
import {
  AnnoArrow,
  AnnoRect,
  makeText,
  normalizeScaling,
  objectFromShape,
  setShapeId,
  shapeOf,
} from './shapes.js';

export interface EditorOptions {
  viewId: string;
  width: number;
  height: number;
  imageUrl: string;
  csrfToken: string;
  doc: AnnotationDocument;
  createdAt: string;
  /** ISO timestamp or '' for indefinite. */
  retentionUntil: string;
  retentionMaxDays: number;
}

type Tool = 'select' | 'rect' | 'arrow' | 'text';
type SaveState = 'saved' | 'pending' | 'saving' | 'error';

const AUTOSAVE_DEBOUNCE_MS = 800;
const RETRY_MS = 5000;
const DAY_MS = 86_400_000;

/**
 * The owner's annotation editor (§9): Fabric canvas at native image pixels
 * scaled to fit, rect/arrow/text tools, in-memory undo/redo, debounced
 * autosave with revision-conflict reload, and the owner tooling (retention,
 * delete). All persistence goes through our own JSON — never Fabric's.
 */
export class CaptureEditor {
  private canvas!: Canvas;
  private tool: Tool = 'select';
  private rev: number;
  private dirty = false;
  private saving = false;
  private saveTimer: number | undefined;
  private retryTimer: number | undefined;
  private undoStack: string[] = [];
  private redoStack: string[] = [];
  private drawing: { origin: { x: number; y: number }; obj: FabricObject } | null = null;
  private readonly status = el('span', {
    className: 'save-state saved',
    text: 'Saved',
    attrs: { role: 'status', 'aria-live': 'polite' },
  });
  private readonly toolButtons = new Map<Tool, HTMLButtonElement>();
  /** Drawing sizes for this capture's width (§9 adaptive sizing) — computed once, shared by every object. */
  private readonly sizes: AnnotationSizes;

  constructor(
    private readonly root: HTMLElement,
    private readonly opts: EditorOptions,
  ) {
    this.rev = opts.doc.rev;
    this.sizes = annotationSizes(opts.width);
  }

  async mount(): Promise<void> {
    const canvasEl = el('canvas');
    const wrap = el('div', { className: 'canvas-wrap' }, [canvasEl]);
    this.root.replaceChildren(this.buildToolbar(), wrap);

    this.canvas = new Canvas(canvasEl, {
      selection: false,
      preserveObjectStacking: true,
      uniformScaling: false,
    });
    this.fit();

    const img = await FabricImage.fromURL(this.opts.imageUrl);
    img.set({ selectable: false, evented: false });
    this.canvas.backgroundImage = img;

    this.loadDoc(this.opts.doc);
    this.undoStack = [this.snapshot()];

    this.canvas.on('mouse:down', (o) => this.onMouseDown(o));
    this.canvas.on('mouse:move', (o) => this.onMouseMove(o));
    this.canvas.on('mouse:up', () => this.onMouseUp());
    this.canvas.on('object:modified', (o) => {
      if (o.target) normalizeScaling(o.target);
      this.commit();
    });
    document.addEventListener('keydown', (e) => this.onKey(e));
    window.addEventListener('resize', () => this.fit());
    window.addEventListener('pagehide', () => this.beacon());
    this.canvas.requestRenderAll();
  }

  // ---- layout ---------------------------------------------------------------

  /** Fit-to-width at most 1:1; tall captures scroll vertically (§9). */
  private fit(): void {
    const avail = Math.max(320, this.root.clientWidth || this.root.parentElement?.clientWidth || 1024);
    const scale = Math.min(1, avail / this.opts.width);
    this.canvas.setDimensions({
      width: Math.round(this.opts.width * scale),
      height: Math.round(this.opts.height * scale),
    });
    this.canvas.setZoom(scale);
    this.canvas.requestRenderAll();
  }

  // ---- toolbar --------------------------------------------------------------

  private buildToolbar(): HTMLElement {
    const toolButton = (tool: Tool, label: string): HTMLButtonElement => {
      const b = el('button', {
        text: label,
        className: 'tool',
        attrs: { type: 'button', 'aria-pressed': String(tool === this.tool) },
        on: { click: () => this.setTool(tool) },
      });
      this.toolButtons.set(tool, b);
      return b;
    };
    return el('div', { className: 'editor-toolbar' }, [
      toolButton('select', 'Select'),
      toolButton('rect', 'Rectangle'),
      toolButton('arrow', 'Arrow'),
      toolButton('text', 'Text'),
      el('span', { className: 'sep' }),
      el('button', {
        text: 'Delete shape',
        attrs: { type: 'button' },
        on: { click: () => this.deleteSelection() },
      }),
      el('button', { text: 'Undo', attrs: { type: 'button' }, on: { click: () => this.undo() } }),
      el('button', { text: 'Redo', attrs: { type: 'button' }, on: { click: () => this.redo() } }),
      this.status,
      el('span', { className: 'spacer' }),
      this.buildRetention(),
      el('button', {
        text: 'Delete capture',
        className: 'danger',
        attrs: { type: 'button' },
        on: { click: () => void this.deleteCapture() },
      }),
    ]);
  }

  private setTool(tool: Tool): void {
    this.tool = tool;
    for (const [t, b] of this.toolButtons) b.setAttribute('aria-pressed', String(t === tool));
    const drawing = tool !== 'select';
    this.canvas.skipTargetFind = drawing;
    this.canvas.defaultCursor = drawing ? 'crosshair' : 'default';
    if (drawing) {
      this.canvas.discardActiveObject();
      this.canvas.requestRenderAll();
    }
  }

  // ---- drawing --------------------------------------------------------------

  private onMouseDown(o: TPointerEventInfo): void {
    if (this.tool === 'select') return;
    const p = this.canvas.getScenePoint(o.e);
    if (this.tool === 'text') {
      // New text starts at the width-derived default; from here on the shape's
      // fontSize is absolute and user resizes store absolute pixels (schema v1).
      const t = makeText('', { left: p.x, top: p.y, fontSize: this.sizes.defaultFontSize }, this.sizes);
      setShapeId(t, newShapeId());
      this.wireText(t);
      this.canvas.add(t);
      this.setTool('select');
      this.canvas.setActiveObject(t);
      t.enterEditing();
      return; // committed on editing:exited
    }
    const obj: FabricObject =
      this.tool === 'rect'
        ? new AnnoRect({ left: p.x, top: p.y, width: 1, height: 1 }, this.sizes)
        : new AnnoArrow(p.x, p.y, p.x + 1, p.y + 1, this.sizes);
    setShapeId(obj, newShapeId());
    this.canvas.add(obj);
    this.drawing = { origin: { x: p.x, y: p.y }, obj };
  }

  private onMouseMove(o: TPointerEventInfo): void {
    if (!this.drawing) return;
    const p = this.canvas.getScenePoint(o.e);
    const { origin, obj } = this.drawing;
    if (obj instanceof AnnoArrow) {
      obj.setEndpoints(origin.x, origin.y, p.x, p.y);
    } else {
      obj.set({
        left: Math.min(origin.x, p.x),
        top: Math.min(origin.y, p.y),
        width: Math.max(1, Math.abs(p.x - origin.x)),
        height: Math.max(1, Math.abs(p.y - origin.y)),
      });
      obj.setCoords();
      obj.dirty = true;
    }
    this.canvas.requestRenderAll();
  }

  private onMouseUp(): void {
    if (!this.drawing) return;
    const { obj } = this.drawing;
    this.drawing = null;
    const tooSmall =
      obj instanceof AnnoArrow
        ? Math.hypot(obj.rx2 - obj.rx1, obj.ry2 - obj.ry1) < 4
        : obj.width < 4 && obj.height < 4;
    this.setTool('select');
    if (tooSmall) {
      this.canvas.remove(obj);
      this.canvas.requestRenderAll();
      return;
    }
    this.canvas.setActiveObject(obj);
    this.commit();
  }

  private wireText(t: IText): void {
    t.on('changed', () => this.markDirty());
    t.on('editing:exited', () => {
      if ((t.text ?? '').trim() === '') this.canvas.remove(t);
      this.commit();
    });
  }

  private deleteSelection(): void {
    const active = this.canvas.getActiveObject();
    if (!active) return;
    if (active instanceof IText && active.isEditing) return;
    this.canvas.remove(active);
    this.canvas.discardActiveObject();
    this.commit();
  }

  private onKey(e: KeyboardEvent): void {
    const target = e.target as HTMLElement | null;
    if (target && ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName)) return;
    const active = this.canvas.getActiveObject();
    if (active instanceof IText && active.isEditing) return;
    if (e.key === 'Delete' || e.key === 'Backspace') {
      e.preventDefault();
      this.deleteSelection();
    } else if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'z') {
      e.preventDefault();
      if (e.shiftKey) this.redo();
      else this.undo();
    }
  }

  // ---- document + undo ------------------------------------------------------

  private shapes(): Shape[] {
    const out: Shape[] = [];
    for (const obj of this.canvas.getObjects()) {
      const s = shapeOf(obj);
      if (s) out.push(s);
    }
    return out;
  }

  private document(): AnnotationDocument {
    return { version: ANNOTATION_SCHEMA_VERSION, rev: this.rev, shapes: this.shapes() };
  }

  private snapshot(): string {
    return JSON.stringify(this.shapes());
  }

  private loadDoc(doc: AnnotationDocument): void {
    this.canvas.remove(...this.canvas.getObjects());
    for (const s of doc.shapes) {
      const obj = objectFromShape(s, this.sizes);
      if (obj instanceof IText) this.wireText(obj);
      this.canvas.add(obj);
    }
    this.canvas.discardActiveObject();
    this.canvas.requestRenderAll();
  }

  private loadSnapshot(json: string): void {
    const shapes = JSON.parse(json) as Shape[];
    this.loadDoc({ version: ANNOTATION_SCHEMA_VERSION, rev: this.rev, shapes });
  }

  /** One user-visible change is complete: record it and schedule a save. */
  private commit(): void {
    const snap = this.snapshot();
    if (snap !== this.undoStack[this.undoStack.length - 1]) {
      this.undoStack.push(snap);
      this.redoStack = [];
    }
    this.markDirty();
  }

  private undo(): void {
    if (this.undoStack.length < 2) return;
    this.redoStack.push(this.undoStack.pop()!);
    this.loadSnapshot(this.undoStack[this.undoStack.length - 1]!);
    this.markDirty();
  }

  private redo(): void {
    const snap = this.redoStack.pop();
    if (snap === undefined) return;
    this.undoStack.push(snap);
    this.loadSnapshot(snap);
    this.markDirty();
  }

  // ---- autosave (§9) --------------------------------------------------------

  private setStatus(state: SaveState, text: string): void {
    this.status.className = `save-state ${state}`;
    this.status.textContent = text;
  }

  private markDirty(): void {
    this.dirty = true;
    this.setStatus('pending', 'Unsaved changes');
    window.clearTimeout(this.saveTimer);
    this.saveTimer = window.setTimeout(() => void this.save(), AUTOSAVE_DEBOUNCE_MS);
  }

  private async save(): Promise<void> {
    if (this.saving) return; // the running save reschedules if still dirty
    window.clearTimeout(this.retryTimer);
    this.saving = true;
    this.dirty = false;
    this.setStatus('saving', 'Saving…');
    try {
      const res = await annotationsApi.put(this.opts.viewId, this.document(), this.opts.csrfToken);
      this.rev = res.rev;
      if (!this.dirty) this.setStatus('saved', 'Saved');
    } catch (err) {
      if (err instanceof ApiError && err.status === 409) {
        // Another of the owner's tabs saved first: last writer wins, so this
        // tab reloads the server document and the local edits are dropped (§9).
        await this.reloadFromServer();
      } else {
        this.dirty = true;
        this.setStatus('error', 'Save failed — retrying');
        this.retryTimer = window.setTimeout(() => void this.save(), RETRY_MS);
      }
    } finally {
      this.saving = false;
      if (this.dirty) {
        window.clearTimeout(this.saveTimer);
        this.saveTimer = window.setTimeout(() => void this.save(), AUTOSAVE_DEBOUNCE_MS);
      }
    }
  }

  private async reloadFromServer(): Promise<void> {
    try {
      const doc = await annotationsApi.get(this.opts.viewId);
      this.rev = doc.rev;
      this.loadDoc(doc);
      this.undoStack = [this.snapshot()];
      this.redoStack = [];
      this.dirty = false;
      this.setStatus('saved', 'Updated elsewhere — reloaded');
    } catch {
      this.setStatus('error', 'Save conflict — reload the page');
    }
  }

  /** Best-effort save on unload; the CSRF token rides in the body (§9). */
  private beacon(): void {
    if (!this.dirty) return;
    navigator.sendBeacon(
      `/api/v1/captures/${this.opts.viewId}/annotations`,
      JSON.stringify({ csrfToken: this.opts.csrfToken, document: this.document() }),
    );
  }

  // ---- owner tooling (§7, §13) ----------------------------------------------

  private buildRetention(): HTMLElement {
    const created = Date.parse(this.opts.createdAt);
    const currentDays = this.opts.retentionUntil
      ? Math.round((Date.parse(this.opts.retentionUntil) - created) / DAY_MS)
      : null;
    const select = el('select', { attrs: { 'aria-label': 'Keep capture for' } });
    if (currentDays === null) {
      select.append(el('option', { text: 'Indefinite', attrs: { value: '', disabled: '' } }));
    } else if (!(RETENTION_CHOICES_DAYS as readonly number[]).includes(currentDays)) {
      select.append(el('option', { text: `${currentDays} days`, attrs: { value: '' } }));
    }
    for (const d of RETENTION_CHOICES_DAYS) {
      if (d > this.opts.retentionMaxDays) continue;
      select.append(el('option', { text: `${d} days`, attrs: { value: String(d) } }));
    }
    const want = currentDays === null ? '' : String(currentDays);
    select.value = [...select.options].some((o) => o.value === want) ? want : '';
    if (select.value === '' && select.options[0]) select.selectedIndex = 0;
    select.addEventListener('change', () => {
      const days = Number(select.value);
      if (Number.isInteger(days) && days > 0) void this.changeRetention(days);
    });
    return el('label', { className: 'retention' }, ['Keep for ', select]);
  }

  private async changeRetention(days: number): Promise<void> {
    try {
      const res = await patchCapture(this.opts.viewId, { retentionDays: days }, this.opts.csrfToken);
      const until = res ? new Date(res.retentionUntil).toLocaleDateString() : '';
      this.setStatus('saved', until ? `Expires ${until}` : 'Retention updated');
    } catch (err) {
      this.setStatus('error', describeError(err));
    }
  }

  private async deleteCapture(): Promise<void> {
    const sure = window.confirm(
      'Delete this capture? The image is removed immediately and the link stops working.',
    );
    if (!sure) return;
    try {
      await patchCapture(this.opts.viewId, { delete: true }, this.opts.csrfToken);
      window.location.replace('/');
    } catch (err) {
      this.setStatus('error', describeError(err));
    }
  }
}
