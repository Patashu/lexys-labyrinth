import { DIRECTIONS, TICS_PER_SECOND } from './defs.js';
import { TILES_WITH_PROPS } from './editor-tile-overlays.js';
import * as format_base from './format-base.js';
import * as c2g from './format-c2g.js';
import { PrimaryView, TransientOverlay, DialogOverlay, flash_button, load_json_from_storage, save_json_to_storage } from './main-base.js';
import CanvasRenderer from './renderer-canvas.js';
import TILE_TYPES from './tiletypes.js';
import { SVG_NS, mk, mk_svg, string_from_buffer_ascii, bytestring_to_buffer, walk_grid } from './util.js';
import * as util from './util.js';

class EditorPackMetaOverlay extends DialogOverlay {
    constructor(conductor, stored_pack) {
        super(conductor);
        this.set_title("pack properties");
        let dl = mk('dl.formgrid');
        this.main.append(dl);

        dl.append(
            mk('dt', "Title"),
            mk('dd', mk('input', {name: 'title', type: 'text', value: stored_pack.title})),
        );
        // TODO...?  what else is a property of the pack itself

        this.add_button("save", () => {
            let els = this.root.elements;

            let title = els.title.value;
            if (title !== stored_pack.title) {
                stored_pack.title = title;
                this.conductor.update_level_title();
            }

            this.close();
        });
        this.add_button("nevermind", () => {
            this.close();
        });
    }
}

class EditorLevelMetaOverlay extends DialogOverlay {
    constructor(conductor, stored_level) {
        super(conductor);
        this.set_title("level properties");
        let dl = mk('dl.formgrid');
        this.main.append(dl);

        let time_limit_input = mk('input', {name: 'time_limit', type: 'range', min: 0, max: 999, value: stored_level.time_limit});
        let time_limit_output = mk('output');
        let update_time_limit = () => {
            let time_limit = parseInt(time_limit_input.value, 10);
            let text;
            if (time_limit === 0) {
                text = "No time limit";
            }
            else {
                text = `${time_limit} (${util.format_duration(time_limit)})`;
            }
            time_limit_output.textContent = text;
        };
        update_time_limit();
        time_limit_input.addEventListener('input', update_time_limit);

        let make_radio_set = (name, options) => {
            let elements = [];
            for (let [label, value] of options) {
                elements.push();
            }
        };

        dl.append(
            mk('dt', "Title"),
            mk('dd', mk('input', {name: 'title', type: 'text', value: stored_level.title})),
            mk('dt', "Author"),
            mk('dd', mk('input', {name: 'author', type: 'text', value: stored_level.author})),
            mk('dt', "Time limit"),
            mk('dd', time_limit_input, " ", time_limit_output),
            mk('dt', "Size"),
            mk('dd',
                "Width: ",
                mk('input', {name: 'size_x', type: 'number', min: 10, max: 100, value: stored_level.size_x}),
                mk('br'),
                "Height: ",
                mk('input', {name: 'size_y', type: 'number', min: 10, max: 100, value: stored_level.size_y}),
            ),
            mk('dt', "Viewport"),
            mk('dd',
                mk('label',
                    mk('input', {name: 'viewport', type: 'radio', value: '10'}),
                    " 10×10 (Chip's Challenge 2 size)"),
                mk('br'),
                mk('label',
                    mk('input', {name: 'viewport', type: 'radio', value: '9'}),
                    " 9×9 (Chip's Challenge 1 size)"),
                mk('br'),
                mk('label',
                    mk('input', {name: 'viewport', type: 'radio', value: '', disabled: 'disabled'}),
                    " Split 10×10 (not yet supported)"),
            ),
            mk('dt', "Blob behavior"),
            mk('dd',
                mk('label',
                    mk('input', {name: 'blob_behavior', type: 'radio', value: '0'}),
                    " Deterministic (PRNG + simple convolution)"),
                mk('br'),
                mk('label',
                    mk('input', {name: 'blob_behavior', type: 'radio', value: '1'}),
                    " 4 patterns (default; PRNG + rotating offset)"),
                mk('br'),
                mk('label',
                    mk('input', {name: 'blob_behavior', type: 'radio', value: '2'}),
                    " Extra random (initial seed is truly random)"),
            ),
        );
        this.root.elements['viewport'].value = stored_level.viewport_size;
        this.root.elements['blob_behavior'].value = stored_level.blob_behavior;
        // TODO:
        // - chips?
        // - password???
        // - comment
        // - use CC1 tools
        // - hide logic
        // - "unviewable", "read only"

        this.add_button("save", () => {
            let els = this.root.elements;

            let title = els.title.value;
            if (title !== stored_level.title) {
                stored_level.title = title;
                this.conductor.update_level_title();
            }
            let author = els.author.value;
            if (author !== stored_level.author) {
                stored_level.author = author;
            }

            stored_level.time_limit = parseInt(els.time_limit.value, 10);

            let size_x = parseInt(els.size_x.value, 10);
            let size_y = parseInt(els.size_y.value, 10);
            if (size_x !== stored_level.size_x || size_y !== stored_level.size_y) {
                this.conductor.editor.resize_level(size_x, size_y);
            }

            stored_level.blob_behavior = parseInt(els.blob_behavior.value, 10);
            stored_level.viewport_size = parseInt(els.viewport.value, 10);
            this.conductor.player.update_viewport_size();

            this.close();
        });
        this.add_button("nevermind", () => {
            this.close();
        });
    }
}

// List of levels, used in the player
class EditorLevelBrowserOverlay extends DialogOverlay {
    constructor(conductor) {
        super(conductor);
        this.set_title("choose a level");

        // Set up some infrastructure to lazily display level renders
        this.renderer = new CanvasRenderer(this.conductor.tileset, 32);
        this.awaiting_renders = [];
        this.observer = new IntersectionObserver((entries, observer) => {
                let any_new = false;
                let to_remove = new Set;
                for (let entry of entries) {
                    if (entry.target.classList.contains('--rendered'))
                        continue;

                    let index = parseInt(entry.target.getAttribute('data-index'), 10);
                    if (entry.isIntersecting) {
                        this.awaiting_renders.push(index);
                        any_new = true;
                    }
                    else {
                        to_remove.add(index);
                    }
                }

                this.awaiting_renders = this.awaiting_renders.filter(index => ! to_remove.has(index));
                if (any_new) {
                    this.schedule_level_render();
                }
            },
            { root: this.main },
        );
        this.list = mk('ol.editor-level-browser');
        for (let [i, meta] of conductor.stored_game.level_metadata.entries()) {
            let title = meta.title;
            let li = mk('li',
                {'data-index': i},
                mk('div.-preview'),
                mk('div.-number', {}, meta.number),
                mk('div.-title', {}, meta.error ? "(error!)" : meta.title),
            );

            this.list.append(li);

            if (meta.error) {
                li.classList.add('--error');
            }
            else {
                this.observer.observe(li);
            }
        }
        this.main.append(this.list);

        this.list.addEventListener('click', ev => {
            let li = ev.target.closest('li');
            if (! li)
                return;

            let index = parseInt(li.getAttribute('data-index'), 10);
            if (this.conductor.change_level(index)) {
                this.close();
            }
        });

        this.add_button("new level", ev => {
            this.conductor.editor.append_new_level();
            this.close();
        });
        this.add_button("nevermind", ev => {
            this.close();
        });
    }

    schedule_level_render() {
        if (this._handle)
            return;
        this._handle = setTimeout(() => { this.render_level() }, 100);
    }

    render_level() {
        this._handle = null;
        if (this.awaiting_renders.length === 0)
            return;

        let index = this.awaiting_renders.shift();
        let element = this.list.childNodes[index];
        let stored_level = this.conductor.stored_game.load_level(index);
        this.conductor.editor._xxx_update_stored_level_cells(stored_level);
        this.renderer.set_level(stored_level);
        this.renderer.set_viewport_size(stored_level.size_x, stored_level.size_y);
        this.renderer.draw();
        let canvas = mk('canvas', {
            width: stored_level.size_x * this.conductor.tileset.size_x / 4,
            height: stored_level.size_y * this.conductor.tileset.size_y / 4,
        });
        canvas.getContext('2d').drawImage(this.renderer.canvas, 0, 0, canvas.width, canvas.height);
        element.querySelector('.-preview').append(canvas);
        element.classList.add('--rendered');

        this.schedule_level_render();
    }
}

class EditorShareOverlay extends DialogOverlay {
    constructor(conductor, url) {
        super(conductor);
        this.set_title("give this to friends");
        this.main.append(mk('p', "Give this URL out to let others try your level:"));
        this.main.append(mk('p.editor-share-url', {}, url));
        let copy_button = mk('button', {type: 'button'}, "Copy to clipboard");
        copy_button.addEventListener('click', ev => {
            flash_button(ev.target);
            navigator.clipboard.writeText(url);
        });
        this.main.append(copy_button);

        let ok = mk('button', {type: 'button'}, "neato");
        ok.addEventListener('click', ev => {
            this.close();
        });
        this.footer.append(ok);
    }
}

////////////////////////////////////////////////////////////////////////////////////////////////////
// Mouse handling

// Stores and controls what the mouse is doing during a movement, mostly by dispatching to functions
// defined for the individual tools
const MOUSE_BUTTON_MASKS = [1, 4, 2];  // MouseEvent.button/buttons are ordered differently
class MouseOperation {
    constructor(editor, ev, target = null) {
        this.editor = editor;
        this.target = target;
        this.button_mask = MOUSE_BUTTON_MASKS[ev.button];
        this.alt_mode = ev.button > 0;
        this.modifier = null;  // or 'shift' or 'ctrl' (ctrl takes precedent)
        this._update_modifier(ev);

        // Client coordinates of the initial click
        this.mx0 = ev.clientX;
        this.my0 = ev.clientY;
        // Real cell coordinates (i.e. including fractional position within a cell) of the click
        [this.gx0f, this.gy0f] = this.editor.renderer.real_cell_coords_from_event(ev);
        // Cell coordinates
        this.gx0 = Math.floor(this.gx0f);
        this.gy0 = Math.floor(this.gy0f);

        // Same as above but for the previous mouse position
        this.mx1 = this.mx0;
        this.my1 = this.my0;
        this.gx1f = this.gx0f;
        this.gy1f = this.gy0f;
        this.gx1 = this.gx0;
        this.gy1 = this.gy0;

        this.start(ev);
    }

    cell(gx, gy) {
        return this.editor.cell(Math.floor(gx), Math.floor(gy));
    }

    do_mousemove(ev) {
        let [gxf, gyf] = this.editor.renderer.real_cell_coords_from_event(ev);
        let gx = Math.floor(gxf);
        let gy = Math.floor(gyf);
        this._update_modifier(ev);

        this.step(ev.clientX, ev.clientY, gxf, gyf, gx, gy);

        this.mx1 = ev.clientX;
        this.my1 = ev.clientY;
        this.gx1f = gxf;
        this.gy1f = gyf;
        this.gx1 = gx;
        this.gy1 = gy;
    }

    _update_modifier(ev) {
        if (ev.ctrlKey) {
            this.modifier = 'ctrl';
        }
        else if (ev.shiftKey) {
            this.modifier = 'shift';
        }
        else {
            this.modifier = null;
        }
    }

    do_commit() {
        this.commit();
        this.cleanup();
    }

    do_abort() {
        this.abort();
        this.cleanup();
    }

    *iter_touched_cells(gxf, gyf) {
        for (let pt of walk_grid(
            this.gx1f, this.gy1f, gxf, gyf,
            // Bound the grid walk to one cell beyond the edges of the level, so that dragging the
            // mouse in from outside the actual edges still works reliably
            -1, -1, this.editor.stored_level.size_x, this.editor.stored_level.size_y))
        {
            if (this.editor.is_in_bounds(...pt)) {
                yield pt;
            }
        }
    }

    // Implement these
    start() {}
    step(x, y) {}
    commit() {}
    abort() {}
    cleanup() {}
}

class PanOperation extends MouseOperation {
    step(mx, my) {
        let target = this.editor.viewport_el.parentNode;
        target.scrollLeft -= mx - this.mx1;
        target.scrollTop -= my - this.my1;
    }
}

class DrawOperation extends MouseOperation {
}

class PencilOperation extends DrawOperation {
    start() {
        this.handle_cell(this.gx0, this.gy0);
    }
    step(mx, my, gxf, gyf, gx, gy) {
        if (this.modifier === 'ctrl') {
            this.handle_cell(gx, gy);
        }
        else {
            for (let [x, y] of this.iter_touched_cells(gxf, gyf)) {
                this.handle_cell(x, y);
            }
        }
    }

    handle_cell(x, y) {
        if (this.modifier === 'ctrl') {
            let cell = this.cell(x, y);
            if (cell) {
                this.editor.select_palette(cell[cell.length - 1]);
            }
            return;
        }

        let template = this.editor.palette_selection;
        if (this.alt_mode) {
            // Erase
            let cell = this.cell(x, y);
            if (this.modifier === 'shift') {
                // Aggressive mode: erase the entire cell
                cell.length = 0;
                cell.push({type: TILE_TYPES.floor});
            }
            else if (template) {
                // Erase whatever's on the same layer
                // TODO this seems like the wrong place for this
                let layer = template.type.draw_layer;
                for (let i = cell.length - 1; i >= 0; i--) {
                    if (cell[i].type.draw_layer === layer) {
                        cell.splice(i, 1);
                    }
                }
                // Don't allow erasing the floor entirely
                if (layer === 0) {
                    cell.unshift({type: TILE_TYPES.floor});
                }
                this.editor.mark_cell_dirty(cell);
            }
        }
        else {
            // Draw
            if (! template)
                return;
            if (this.modifier === 'shift') {
                // Aggressive mode: erase whatever's already in the cell
                let cell = this.cell(x, y);
                cell.length = 0;
                let type = this.editor.palette_selection.type;
                if (type.draw_layer !== 0) {
                    cell.push({type: TILE_TYPES.floor});
                }
                this.editor.place_in_cell(x, y, template);
            }
            else {
                // Default operation: only erase whatever's on the same layer
                this.editor.place_in_cell(x, y, template);
            }
        }
    }
}

class ForceFloorOperation extends DrawOperation {
    start() {
        // Begin by placing an all-way force floor under the mouse
        this.editor.place_in_cell(x, y, 'force_floor_all');
    }
    step(mx, my, gxf, gyf) {
        // Walk the mouse movement and change each we touch to match the direction we
        // crossed the border
        // FIXME occasionally i draw a tetris S kinda shape and both middle parts point
        // the same direction, but shouldn't
        let i = 0;
        let prevx, prevy;
        for (let [x, y] of this.iter_touched_cells(gxf, gyf)) {
            i++;
            // The very first cell is the one the mouse was already in, and we don't
            // have a movement direction yet, so leave that alone
            if (i === 1) {
                prevx = x;
                prevy = y;
                continue;
            }
            let name;
            if (x === prevx) {
                if (y > prevy) {
                    name = 'force_floor_s';
                }
                else {
                    name = 'force_floor_n';
                }
            }
            else {
                if (x > prevx) {
                    name = 'force_floor_e';
                }
                else {
                    name = 'force_floor_w';
                }
            }

            // The second cell tells us the direction to use for the first, assuming it
            // had some kind of force floor
            if (i === 2) {
                let prevcell = this.editor.cell(prevx, prevy);
                if (prevcell[0].type.name.startsWith('force_floor_')) {
                    prevcell[0].type = TILE_TYPES[name];
                }
            }

            // Drawing a loop with force floors creates ice (but not in the previous
            // cell, obviously)
            let cell = this.editor.cell(x, y);
            if (cell[0].type.name.startsWith('force_floor_') &&
                cell[0].type.name !== name)
            {
                name = 'ice';
            }
            this.editor.place_in_cell(x, y, name);

            prevx = x;
            prevy = y;
        }
    }
}

// TODO entered cell should get blank railroad?
// TODO maybe place a straight track in the new cell so it looks like we're doing something, then
// fix it if it wasn't there?
// TODO gonna need an ice tool too, so maybe i can merge all three with some base thing that tracks
// the directions the mouse is moving?  or is FF tool too different?
class TrackOperation extends DrawOperation {
    start() {
        // Do nothing to start; we only lay track when the mouse leaves a cell
        this.entry_direction = null;
    }
    step(mx, my, gxf, gyf) {
        // Walk the mouse movement and, for every tile we LEAVE, add a railroad track matching the
        // two edges of it that we crossed.
        let prevx = null, prevy = null;
        for (let [x, y] of this.iter_touched_cells(gxf, gyf)) {
            if (prevx === null || prevy === null) {
                prevx = x;
                prevy = y;
                continue;
            }

            // Figure out which way we're leaving the tile
            let exit_direction;
            if (x === prevx) {
                if (y > prevy) {
                    exit_direction = 'south';
                }
                else {
                    exit_direction = 'north';
                }
            }
            else {
                if (x > prevx) {
                    exit_direction = 'east';
                }
                else {
                    exit_direction = 'west';
                }
            }

            // If the entry direction is missing or bogus, lay straight track
            if (this.entry_direction === null || this.entry_direction === exit_direction) {
                this.entry_direction = DIRECTIONS[exit_direction].opposite;
            }

            // Get the corresponding bit
            let bit = null;
            for (let [i, track] of TILE_TYPES['railroad'].track_order.entries()) {
                if ((track[0] === this.entry_direction && track[1] === exit_direction) ||
                    (track[1] === this.entry_direction && track[0] === exit_direction))
                {
                    bit = 1 << i;
                    break;
                }
            }

            if (bit === null)
                continue;

            // Update the cell we just left
            let cell = this.cell(prevx, prevy);
            let terrain = cell[0];
            if (terrain.type.name === 'railroad') {
                if (this.alt_mode) {
                    // Erase
                    // TODO fix track switch?
                    // TODO if this leaves tracks === 0, replace with floor?
                    terrain.tracks &= ~bit;
                }
                else {
                    // Draw
                    terrain.tracks |= bit;
                }
            }
            else if (! this.alt_mode) {
                terrain = { type: TILE_TYPES['railroad'] };
                terrain.type.populate_defaults(terrain);
                terrain.tracks |= bit;
                this.editor.place_in_cell(prevx, prevy, terrain);
            }

            prevx = x;
            prevy = y;
            this.entry_direction = DIRECTIONS[exit_direction].opposite;
        }
    }
}

class WireOperation extends DrawOperation {
    start() {
        if (this.modifier === 'ctrl') {
            // Place or remove wire tunnels
            let cell = this.cell(this.gx0f, this.gy0f);
            if (! cell)
                return;

            let direction;
            // Use the offset from the center to figure out which edge of the tile to affect
            let xoff = this.gx0f % 1 - 0.5;
            let yoff = this.gy0f % 1 - 0.5;
            if (Math.abs(xoff) > Math.abs(yoff)) {
                if (xoff > 0) {
                    direction = 'east';
                }
                else {
                    direction = 'west';
                }
            }
            else {
                if (yoff > 0) {
                    direction = 'south';
                }
                else {
                    direction = 'north';
                }
            }
            let bit = DIRECTIONS[direction].bit;

            for (let tile of cell) {
                if (tile.type.name !== 'floor')
                    continue;
                if (this.alt_mode) {
                    tile.wire_tunnel_directions &= ~bit;
                }
                else {
                    tile.wire_tunnel_directions |= bit;
                }
            }
            return;
        }
    }
    step(mx, my, gxf, gyf) {
        if (this.modifier === 'ctrl') {
            // Wire tunnels don't support dragging
            // TODO but maybe they should??  makes erasing a lot of them easier at least
            return;
        }

        // Wire is interesting.  Consider this diagram.
        // +-------+
        // | . A . |
        // |...A...|
        // | . A . |
        // |BBB+CCC|
        // | . D . |
        // |...D...|
        // | . D . |
        // +-------+
        // In order to know which of the four wire pieces in a cell (A, B, C, D) someone is trying
        // to draw over, we use a quarter-size grid, indicated by the dots.  Then any mouse movement
        // that crosses the first horizontal grid line means we should draw wire A.
        // (Note that crossing either a tile boundary or the middle of a cell doesn't mean anything;
        // for example, dragging the mouse horizontally across the A wire is meaningless.)
        // TODO maybe i should just have a walk_grid variant that yields line crossings, christ
        let prevqx = null, prevqy = null;
        for (let [qx, qy] of walk_grid(
            this.gx1f * 4, this.gy1f * 4, gxf * 4, gyf * 4,
            // See comment in iter_touched_cells
            -1, -1, this.editor.stored_level.size_x * 4, this.editor.stored_level.size_y * 4))
        {
            if (prevqx === null || prevqy === null) {
                prevqx = qx;
                prevqy = qy;
                continue;
            }

            // Figure out which grid line we've crossed; direction doesn't matter, so we just get
            // the index of the line, which matches the coordinate of the cell to the right/bottom
            // FIXME 'continue' means we skip the update of prevs, solution is really annoying
            // FIXME if you trace around just the outside of a tile, you'll get absolute nonsense:
            // +---+---+
            // |   |   |
            // |   |.+ |
            // |   |.| |
            // +---+.--+
            // | ....  |
            // | +-|   |
            // |   |   |
            // +---+---+
            let wire_direction;
            let x, y;
            if (qx === prevqx) {
                // Vertical
                let line = Math.max(qy, prevqy);
                // Even crossings don't correspond to a wire
                if (line % 2 === 0) {
                    prevqx = qx;
                    prevqy = qy;
                    continue;
                }

                // Convert to real coordinates
                x = Math.floor(qx / 4);
                y = Math.floor(line / 4);

                if (line % 4 === 1) {
                    // Consult the diagram!
                    wire_direction = 'north';
                }
                else {
                    wire_direction = 'south';
                }
            }
            else {
                // Horizontal; same as above
                let line = Math.max(qx, prevqx);
                if (line % 2 === 0) {
                    prevqx = qx;
                    prevqy = qy;
                    continue;
                }

                x = Math.floor(line / 4);
                y = Math.floor(qy / 4);

                if (line % 4 === 1) {
                    wire_direction = 'west';
                }
                else {
                    wire_direction = 'east';
                }
            }

            if (! this.editor.is_in_bounds(x, y)) {
                prevqx = qx;
                prevqy = qy;
                continue;
            }

            let cell = this.cell(x, y);
            for (let tile of Array.from(cell).reverse()) {
                // TODO probably a better way to do this
                if (['floor', 'steel', 'button_pink', 'button_black', 'teleport_blue', 'teleport_red', 'light_switch_on', 'light_switch_off', 'circuit_block'].indexOf(tile.type.name) < 0)
                    continue;

                tile.wire_directions = tile.wire_directions ?? 0;
                if (this.alt_mode) {
                    // Erase
                    tile.wire_directions &= ~DIRECTIONS[wire_direction].bit;
                }
                else {
                    // Draw
                    tile.wire_directions |= DIRECTIONS[wire_direction].bit;
                }
                // TODO this.editor.mark_tile_dirty(tile);
                break;
            }

            prevqx = qx;
            prevqy = qy;
        }
    }
}

// Tiles the "adjust" tool will turn into each other
const ADJUST_TOGGLES_CW = {};
const ADJUST_TOGGLES_CCW = {};
{
    for (let cycle of [
        ['chip', 'chip_extra'],
        // TODO shouldn't this convert regular walls into regular floors then?
        ['floor_custom_green', 'wall_custom_green'],
        ['floor_custom_pink', 'wall_custom_pink'],
        ['floor_custom_yellow', 'wall_custom_yellow'],
        ['floor_custom_blue', 'wall_custom_blue'],
        ['fake_floor', 'fake_wall'],
        ['popdown_floor', 'popdown_wall'],
        ['wall_invisible', 'wall_appearing'],
        ['green_floor', 'green_wall'],
        ['green_bomb', 'green_chip'],
        ['purple_floor', 'purple_wall'],
        ['thief_keys', 'thief_tools'],
        ['swivel_nw', 'swivel_ne', 'swivel_se', 'swivel_sw'],
        ['ice_nw', 'ice_ne', 'ice_se', 'ice_sw'],
        ['force_floor_n', 'force_floor_e', 'force_floor_s', 'force_floor_w'],
        ['ice', 'force_floor_all'],
        ['water', 'turtle'],
        ['no_player1_sign', 'no_player2_sign'],
        ['flame_jet_off', 'flame_jet_on'],
        ['light_switch_off', 'light_switch_on'],
    ])
    {
        for (let [i, tile] of cycle.entries()) {
            let other = cycle[(i + 1) % cycle.length];
            ADJUST_TOGGLES_CW[tile] = other;
            ADJUST_TOGGLES_CCW[other] = tile;
        }
    }
}
class AdjustOperation extends MouseOperation {
    start() {
        let cell = this.cell(this.gx1, this.gy1);
        if (this.modifier === 'ctrl') {
            for (let tile of cell) {
                if (TILES_WITH_PROPS[tile.type.name] !== undefined) {
                    // TODO use the tile's bbox, not the mouse position
                    this.editor.open_tile_prop_overlay(tile, this.mx0, this.my0);
                    break;
                }
            }
            return;
        }
        // FIXME implement shift to always target floor, or maybe start from bottom
        for (let i = cell.length - 1; i >= 0; i--) {
            let tile = cell[i];

            let rotated;
            if (this.alt_mode) {
                // Reverse, go counterclockwise
                rotated = this.editor.rotate_tile_left(tile);
            }
            else {
                rotated = this.editor.rotate_tile_right(tile);
            }
            if (rotated) {
                this.editor.mark_tile_dirty(tile);
                break;
            }

            // Toggle tiles that go in obvious pairs
            let other = (this.alt_mode ? ADJUST_TOGGLES_CCW : ADJUST_TOGGLES_CW)[tile.type.name];
            if (other) {
                tile.type = TILE_TYPES[other];
                this.editor.mark_tile_dirty(tile);
                break;
            }
        }
    }
    // Adjust tool doesn't support dragging
    // TODO should it?
    // TODO if it does then it should end as soon as you spawn a popup
}

// FIXME currently allows creating outside the map bounds and moving beyond the right/bottom, sigh
class CameraOperation extends MouseOperation {
    start(ev) {
        this.offset_x = 0;
        this.offset_y = 0;
        this.resize_x = 0;
        this.resize_y = 0;

        let cursor;

        this.target = ev.target.closest('.overlay-camera');
        if (! this.target) {
            // Clicking in empty space creates a new camera region
            this.mode = 'create';
            cursor = 'move';
            this.region = new DOMRect(this.gx0, this.gy0, 1, 1);
            this.target = mk_svg('rect.overlay-camera', {
                x: this.gx0, y: this.gy1, width: 1, height: 1,
                'data-region-index': this.editor.stored_level.camera_regions.length,
            });
            this.editor.connections_g.append(this.target);
        }
        else {
            this.region = this.editor.stored_level.camera_regions[parseInt(this.target.getAttribute('data-region-index'), 10)];

            // If we're grabbing an edge, resize it
            let rect = this.target.getBoundingClientRect();
            let grab_left = (this.mx0 < rect.left + 16);
            let grab_right = (this.mx0 > rect.right - 16);
            let grab_top = (this.my0 < rect.top + 16);
            let grab_bottom = (this.my0 > rect.bottom - 16);
            if (grab_left || grab_right || grab_top || grab_bottom) {
                this.mode = 'resize';

                if (grab_left) {
                    this.resize_edge_x = -1;
                }
                else if (grab_right) {
                    this.resize_edge_x = 1;
                }
                else {
                    this.resize_edge_x = 0;
                }

                if (grab_top) {
                    this.resize_edge_y = -1;
                }
                else if (grab_bottom) {
                    this.resize_edge_y = 1;
                }
                else {
                    this.resize_edge_y = 0;
                }

                if ((grab_top && grab_left) || (grab_bottom && grab_right)) {
                    cursor = 'nwse-resize';
                }
                else if ((grab_top && grab_right) || (grab_bottom && grab_left)) {
                    cursor = 'nesw-resize';
                }
                else if (grab_top || grab_bottom) {
                    cursor = 'ns-resize';
                }
                else {
                    cursor = 'ew-resize';
                }
            }
            else {
                this.mode = 'move';
                cursor = 'move';
            }
        }

        this.editor.viewport_el.style.cursor = cursor;

        // Create a text element to show the size while editing
        this.size_text = mk_svg('text.overlay-edit-tip', {
            // Center it within the rectangle probably (x and y are set in _update_size_text)
            'text-anchor': 'middle', 'dominant-baseline': 'middle',
        });
        this._update_size_text();
        this.editor.svg_overlay.append(this.size_text);
    }
    _update_size_text() {
        this.size_text.setAttribute('x', this.region.x + this.offset_x + (this.region.width + this.resize_x) / 2);
        this.size_text.setAttribute('y', this.region.y + this.offset_y + (this.region.height + this.resize_y) / 2);
        this.size_text.textContent = `${this.region.width + this.resize_x} × ${this.region.height + this.resize_y}`;
    }
    step(mx, my, gxf, gyf, gx, gy) {
        // FIXME not right if we zoom, should use gxf
        let dx = Math.floor((mx - this.mx0) / this.editor.conductor.tileset.size_x + 0.5);
        let dy = Math.floor((my - this.my0) / this.editor.conductor.tileset.size_y + 0.5);

        let stored_level = this.editor.stored_level;
        if (this.mode === 'create') {
            // Just make the new region span between the original click and the new position
            this.region.x = Math.min(gx, this.gx0);
            this.region.y = Math.min(gy, this.gy0);
            this.region.width = Math.max(gx, this.gx0) + 1 - this.region.x;
            this.region.height = Math.max(gy, this.gy0) + 1 - this.region.y;
        }
        else if (this.mode === 'move') {
            // Keep it within the map!
            this.offset_x = Math.max(- this.region.x, Math.min(stored_level.size_x - this.region.width, dx));
            this.offset_y = Math.max(- this.region.y, Math.min(stored_level.size_y - this.region.height, dy));
        }
        else {
            // Resize, based on the edge we originally grabbed
            if (this.resize_edge_x < 0) {
                // Left
                dx = Math.max(-this.region.x, Math.min(this.region.width - 1, dx));
                this.resize_x = -dx;
                this.offset_x = dx;
            }
            else if (this.resize_edge_x > 0) {
                // Right
                dx = Math.max(-(this.region.width - 1), Math.min(stored_level.size_x - this.region.right, dx));
                this.resize_x = dx;
                this.offset_x = 0;
            }

            if (this.resize_edge_y < 0) {
                // Top
                dy = Math.max(-this.region.y, Math.min(this.region.height - 1, dy));
                this.resize_y = -dy;
                this.offset_y = dy;
            }
            else if (this.resize_edge_y > 0) {
                // Bottom
                dy = Math.max(-(this.region.height - 1), Math.min(stored_level.size_y - this.region.bottom, dy));
                this.resize_y = dy;
                this.offset_y = 0;
            }
        }

        this.target.setAttribute('x', this.region.x + this.offset_x);
        this.target.setAttribute('y', this.region.y + this.offset_y);
        this.target.setAttribute('width', this.region.width + this.resize_x);
        this.target.setAttribute('height', this.region.height + this.resize_y);
        this._update_size_text();
    }
    commit() {
        if (this.mode === 'create') {
            // Region is already updated, just add it to the level
            this.editor.stored_level.camera_regions.push(this.region);
        }
        else {
            // Actually edit the underlying region
            this.region.x += this.offset_x;
            this.region.y += this.offset_y;
            this.region.width += this.resize_x;
            this.region.height += this.resize_y;
        }
    }
    abort() {
        if (this.mode === 'create') {
            // The element was fake, so delete it
            this.target.remove();
        }
        else {
            // Move the element back to its original location
            this.target.setAttribute('x', this.region.x);
            this.target.setAttribute('y', this.region.y);
            this.target.setAttribute('width', this.region.width);
            this.target.setAttribute('height', this.region.height);
        }
    }
    cleanup() {
        this.editor.viewport_el.style.cursor = '';
        this.size_text.remove();
    }
}

class CameraEraseOperation extends MouseOperation {
    start(ev) {
        let target = ev.target.closest('.overlay-camera');
        if (target) {
            let index = parseInt(target.getAttribute('data-region-index'), 10);
            target.remove();
            this.editor.stored_level.camera_regions.splice(index, 1);
        }
    }
}

const EDITOR_TOOLS = {
    pencil: {
        icon: 'icons/tool-pencil.png',
        name: "Pencil",
        desc: "Place, erase, and select tiles.\nLeft click: draw\nRight click: erase\nShift: Replace all layers\nCtrl-click: eyedrop",
        uses_palette: true,
        op1: PencilOperation,
        op2: PencilOperation,
        //hover: show current selection under cursor
    },
    line: {
        // TODO not implemented
        icon: 'icons/tool-line.png',
        name: "Line",
        desc: "Draw straight lines",
        uses_palette: true,
    },
    box: {
        // TODO not implemented
        icon: 'icons/tool-box.png',
        name: "Box",
        desc: "Fill a rectangular area with tiles",
        uses_palette: true,
    },
    fill: {
        // TODO not implemented
        icon: 'icons/tool-fill.png',
        name: "Fill",
        desc: "Flood-fill an area with tiles",
        uses_palette: true,
    },
    'force-floors': {
        icon: 'icons/tool-force-floors.png',
        name: "Force floors",
        desc: "Draw force floors following the cursor.",
        op1: ForceFloorOperation,
    },
    tracks: {
        icon: 'icons/tool-tracks.png',
        name: "Tracks",
        desc: "Draw tracks following the cursor.\nLeft click: Lay tracks\nRight click: Erase tracks\nCtrl-click: Toggle track switch",
        op1: TrackOperation,
        op2: TrackOperation,
    },
    adjust: {
        icon: 'icons/tool-adjust.png',
        name: "Adjust",
        desc: "Edit existing tiles.\nLeft click: rotate actor or toggle terrain\nRight click: rotate or toggle in reverse\nShift: always target terrain\nCtrl-click: edit properties of complex tiles\n(wires, railroads, hints, etc.)",
        op1: AdjustOperation,
        op2: AdjustOperation,
    },
    connect: {
        // TODO not implemented
        icon: 'icons/tool-connect.png',
        name: "Connect",
        desc: "Set up CC1 clone and trap connections",
    },
    wire: {
        // TODO not implemented
        icon: 'icons/tool-wire.png',
        name: "Wire",
        desc: "Edit CC2 wiring.\nLeft click: draw wires\nRight click: erase wires\nCtrl-click: toggle tunnels (floor only)",
        op1: WireOperation,
        op2: WireOperation,
    },
    camera: {
        icon: 'icons/tool-camera.png',
        name: "Camera",
        desc: "Draw and edit custom camera regions",
        help: "Draw and edit camera regions.\n(LL only.  When the player is within a camera region,\nthe camera stays locked inside it.)\nLeft click: create or edit a region\nRight click: erase a region",
        op1: CameraOperation,
        op2: CameraEraseOperation,
    },
    // TODO text tool; thin walls tool; ice tool; map generator?; subtools for select tool (copy, paste, crop)
    // TODO interesting option: rotate an actor as you draw it by dragging?  or hold a key like in
    // slade when you have some selected?
    // TODO ah, railroads...
};
const EDITOR_TOOL_ORDER = ['pencil', 'adjust', 'force-floors', 'tracks', 'wire', 'camera'];

// TODO this MUST use a LL tileset!
const EDITOR_PALETTE = [{
    title: "Basics",
    tiles: [
        'player', 'player2',
        'chip', 'chip_extra',
        'floor', 'wall', 'hint', 'socket', 'exit',
    ],
}, {
    title: "Terrain",
    tiles: [
        'popwall',
        'steel',
        'wall_invisible',
        'wall_appearing',
        'fake_floor',
        'fake_wall',
        'popdown_floor',
        'popdown_wall',

        'floor_letter',
        'gravel',
        'dirt',
        'slime',
        'thief_keys',
        'thief_tools',
        'no_player1_sign',
        'no_player2_sign',

        'floor_custom_green', 'floor_custom_pink', 'floor_custom_yellow', 'floor_custom_blue',
        'wall_custom_green', 'wall_custom_pink', 'wall_custom_yellow', 'wall_custom_blue',

        'door_blue', 'door_red', 'door_yellow', 'door_green',
        'swivel_nw',
        'railroad/straight',
        'railroad/curve',
        'railroad/switch',

        'water', 'turtle', 'fire',
        'ice', 'ice_nw',
        'force_floor_n', 'force_floor_all',
    ],
}, {
    title: "Items",
    tiles: [
        'key_blue', 'key_red', 'key_yellow', 'key_green',
        'flippers', 'fire_boots', 'cleats', 'suction_boots',
        'bribe', 'railroad_sign', 'hiking_boots', 'speed_boots',
        'xray_eye', 'helmet', 'foil', 'lightning_bolt',
        'bowling_ball', 'dynamite', 'no_sign', 'gift_bow',
        'score_10', 'score_100', 'score_1000', 'score_2x',
    ],
}, {
    title: "Creatures",
    tiles: [
        'tank_blue',
        'tank_yellow',
        'ball',
        'walker',
        'fireball',
        'glider',
        'bug',
        'paramecium',

        'doppelganger1',
        'doppelganger2',
        'teeth',
        'teeth_timid',
        'floor_mimic',
        'ghost',
        'rover',
        'blob',
    ],
}, {
    title: "Mechanisms",
    tiles: [
        'dirt_block',
        'ice_block',
        'frame_block/0',
        'frame_block/1',
        'frame_block/2a',
        'frame_block/2o',
        'frame_block/3',
        'frame_block/4',

        'green_floor',
        'green_wall',
        'green_chip',
        'green_bomb',
        'button_green',
        'button_blue',
        'button_yellow',
        'bomb',

        'button_red', 'cloner',
        'button_brown', 'trap',
        'button_orange', 'flame_jet_off', 'flame_jet_on',
        'transmogrifier',

        'teleport_blue',
        'teleport_red',
        'teleport_green',
        'teleport_yellow',
        'stopwatch_bonus',
        'stopwatch_penalty',
        'stopwatch_toggle',
    ],
    // TODO missing:
    // - wires, wire tunnels        probably a dedicated tool, placing tunnels like a tile makes no sense
    // - canopy                     normal tile; layering problem
    // - thin walls                 special rotate logic, like force floors; layering problem
    // - light switches
    // TODO should tiles that respond to wiring and/or gray buttons be highlighted, highlightable?
}, {
    title: "Logic",
    tiles: [
        'logic_gate/not',
        'logic_gate/and',
        'logic_gate/or',
        'logic_gate/xor',
        'logic_gate/nand',
        'logic_gate/latch-cw',
        'logic_gate/latch-ccw',
        'logic_gate/counter',
        'button_pink',
        'button_black',
        'light_switch_off',
        'light_switch_on',
        'purple_floor',
        'purple_wall',
        'button_gray',
        'circuit_block/xxx',
    ],
}];

const SPECIAL_PALETTE_ENTRIES = {
    'frame_block/0':  { name: 'frame_block', direction: 'south', arrows: new Set },
    'frame_block/1':  { name: 'frame_block', direction: 'north', arrows: new Set(['north']) },
    'frame_block/2a': { name: 'frame_block', direction: 'north', arrows: new Set(['north', 'east']) },
    'frame_block/2o': { name: 'frame_block', direction: 'south', arrows: new Set(['north', 'south']) },
    'frame_block/3':  { name: 'frame_block', direction: 'south', arrows: new Set(['north', 'east', 'south']) },
    'frame_block/4':  { name: 'frame_block', direction: 'south', arrows: new Set(['north', 'east', 'south', 'west']) },
    // FIXME these should be additive/subtractive, but a track picked up from the level should replace
    'railroad/straight':    { name: 'railroad', tracks: 1 << 5, track_switch: null, entered_direction: 'north' },
    'railroad/curve':       { name: 'railroad', tracks: 1 << 0, track_switch: null, entered_direction: 'north' },
    'railroad/switch':      { name: 'railroad', tracks: 0, track_switch: 0, entered_direction: 'north' },
    'logic_gate/not':       { name: 'logic_gate', direction: 'north', gate_type: 'not' },
    'logic_gate/and':       { name: 'logic_gate', direction: 'north', gate_type: 'and' },
    'logic_gate/or':        { name: 'logic_gate', direction: 'north', gate_type: 'or' },
    'logic_gate/xor':       { name: 'logic_gate', direction: 'north', gate_type: 'xor' },
    'logic_gate/nand':      { name: 'logic_gate', direction: 'north', gate_type: 'nand' },
    'logic_gate/latch-cw':  { name: 'logic_gate', direction: 'north', gate_type: 'latch-cw' },
    'logic_gate/latch-ccw': { name: 'logic_gate', direction: 'north', gate_type: 'latch-ccw' },
    'logic_gate/counter':   { name: 'logic_gate', direction: 'north', gate_type: 'counter', memory: 0 },
    'circuit_block/xxx':    { name: 'circuit_block', direction: 'south', wire_directions: 0xf },
};
const _RAILROAD_ROTATED_LEFT = [3, 0, 1, 2, 5, 4];
const _RAILROAD_ROTATED_RIGHT = [1, 2, 3, 0, 5, 4];
const SPECIAL_PALETTE_BEHAVIOR = {
    frame_block: {
        pick_palette_entry(tile) {
            if (tile.arrows.size === 2) {
                let [a, b] = tile.arrows.keys();
                if (a === DIRECTIONS[b].opposite) {
                    return 'frame_block/2o';
                }
                else {
                    return 'frame_block/2a';
                }
            }
            else {
                return `frame_block/${tile.arrows.size}`;
            }
        },
        rotate_left(tile) {
            tile.arrows = new Set(Array.from(tile.arrows, arrow => DIRECTIONS[arrow].left));
        },
        rotate_right(tile) {
            tile.arrows = new Set(Array.from(tile.arrows, arrow => DIRECTIONS[arrow].right));
        },
    },
    logic_gate: {
        pick_palette_entry(tile) {
            return `logic_gate/${tile.gate_type}`;
        },
        rotate_left(tile) {
            if (tile.gate_type === 'counter') {
                tile.memory = (tile.memory + 9) % 10;
            }
            else {
                tile.direction = DIRECTIONS[tile.direction].left;
            }
        },
        rotate_right(tile) {
            if (tile.gate_type === 'counter') {
                tile.memory = (tile.memory + 1) % 10;
            }
            else {
                tile.direction = DIRECTIONS[tile.direction].right;
            }
        },
    },
    railroad: {
        pick_palette_entry(tile) {
            // This is a little fuzzy, since railroads are compound, but we just go with the first
            // one that matches and fall back to the switch if it's empty
            if (tile.tracks & 0x30) {
                return 'railroad/straight';
            }
            if (tile.tracks) {
                return 'railroad/curve';
            }
            return 'railroad/switch';
        },
        rotate_left(tile) {
            let new_tracks = 0;
            for (let i = 0; i < 6; i++) {
                if (tile.tracks & (1 << i)) {
                    new_tracks |= 1 << _RAILROAD_ROTATED_LEFT[i];
                }
            }
            tile.tracks = new_tracks;

            if (tile.track_switch !== null) {
                tile.track_switch = _RAILROAD_ROTATED_LEFT[tile.track_switch];
            }

            if (tile.entered_direction) {
                tile.entered_direction = DIRECTIONS[tile.entered_direction].left;
            }
        },
        rotate_right(tile) {
            let new_tracks = 0;
            for (let i = 0; i < 6; i++) {
                if (tile.tracks & (1 << i)) {
                    new_tracks |= 1 << _RAILROAD_ROTATED_RIGHT[i];
                }
            }
            tile.tracks = new_tracks;

            if (tile.track_switch !== null) {
                tile.track_switch = _RAILROAD_ROTATED_RIGHT[tile.track_switch];
            }

            if (tile.entered_direction) {
                tile.entered_direction = DIRECTIONS[tile.entered_direction].right;
            }
        },
    },
    circuit_block: {
        pick_palette_entry(tile) {
            return 'circuit_block/xxx';
        },
    },
};
// Fill in some special behavior that boils down to rotating tiles which happen to be encoded as
// different tile types
for (let cycle of [
    ['force_floor_n', 'force_floor_e', 'force_floor_s', 'force_floor_w'],
    ['ice_nw', 'ice_ne', 'ice_se', 'ice_sw'],
    ['swivel_nw', 'swivel_ne', 'swivel_se', 'swivel_sw'],
]) {
    for (let [i, name] of cycle.entries()) {
        let left = cycle[(i - 1 + cycle.length) % cycle.length];
        let right = cycle[(i + 1) % cycle.length];
        SPECIAL_PALETTE_BEHAVIOR[name] = {
            pick_palette_entry(tile) {
                return name;
            },
            rotate_left(tile) {
                tile.type = TILE_TYPES[left];
            },
            rotate_right(tile) {
                tile.type = TILE_TYPES[right];
            },
        };
    }
}


export class Editor extends PrimaryView {
    constructor(conductor) {
        super(conductor, document.body.querySelector('main#editor'));

        this.viewport_el = this.root.querySelector('.editor-canvas .-container');

        // Load editor state; we may need this before setup() since we create new levels before
        // actually loading the editor proper
        this.stash = load_json_from_storage("Lexy's Labyrinth editor");
        if (! this.stash) {
            this.stash = {
                packs: {},  // key: { title, level_count, last_modified }
                // More pack data is stored separately under the key, as {
                //   levels: [{key, title}],
                // }
                // Levels are also stored under separate keys, encoded as C2M.
            };
        }
        this.pack_stash = null;
        this.level_stash = null;

        // FIXME don't hardcode size here, convey this to renderer some other way
        this.renderer = new CanvasRenderer(this.conductor.tileset, 32);
        this.renderer.perception = 2;

        // FIXME need this in load_level which is called even if we haven't been setup yet
        this.connections_g = mk_svg('g');
        // This SVG draws vectors on top of the editor, like monster paths and button connections
        this.svg_overlay = mk_svg('svg.level-editor-overlay', {viewBox: '0 0 32 32'}, this.connections_g);
        this.viewport_el.append(this.renderer.canvas, this.svg_overlay);
    }

    setup() {
        // Keyboard shortcuts
        window.addEventListener('keydown', ev => {
            if (! this.active)
                return;

            if (ev.key === ',') {
                if (ev.shiftKey) {
                    this.rotate_palette_left();
                }
                else if (this.palette_selection) {
                    this.rotate_tile_left(this.palette_selection);
                }
            }
            else if (ev.key === '.') {
                if (ev.shiftKey) {
                    this.rotate_palette_right();
                }
                else if (this.palette_selection) {
                    this.rotate_tile_right(this.palette_selection);
                }
            }
        });
        // Level canvas and mouse handling
        this.mouse_op = null;
        this.viewport_el.addEventListener('mousedown', ev => {
            this.cancel_mouse_operation();

            if (ev.button === 0) {
                // Left button: activate tool
                let op_type = EDITOR_TOOLS[this.current_tool].op1;
                if (! op_type)
                    return;

                this.mouse_op = new op_type(this, ev);
                ev.preventDefault();
                ev.stopPropagation();

                // FIXME eventually this should be automatic
                this.renderer.draw();
            }
            else if (ev.button === 1) {
                // Middle button: always pan
                this.mouse_op = new PanOperation(this, ev);

                ev.preventDefault();
                ev.stopPropagation();
            }
            else if (ev.button === 2) {
                // Right button: activate tool's alt mode
                let op_type = EDITOR_TOOLS[this.current_tool].op2;
                if (! op_type)
                    return;

                this.mouse_op = new op_type(this, ev);
                ev.preventDefault();
                ev.stopPropagation();

                this.renderer.draw();
            }
        });
        // Once the mouse is down, we should accept mouse movement anywhere
        window.addEventListener('mousemove', ev => {
            if (! this.active)
                return;
            if (! this.mouse_op)
                return;
            if ((ev.buttons & this.mouse_op.button_mask) === 0) {
                this.cancel_mouse_operation();
                return;
            }

            this.mouse_op.do_mousemove(ev);

            // FIXME !!!
            this.renderer.draw();
        });
        // TODO should this happen for a mouseup anywhere?
        this.viewport_el.addEventListener('mouseup', ev => {
            if (this.mouse_op) {
                this.mouse_op.do_commit();
                this.mouse_op = null;
                ev.stopPropagation();
                ev.preventDefault();
            }
        });
        // Disable context menu, which interferes with right-click tools
        this.viewport_el.addEventListener('contextmenu', ev => {
            ev.preventDefault();
        });
        window.addEventListener('blur', ev => {
            this.cancel_mouse_operation();
        });

        // Toolbox
        // Selected tile
        this.selected_tile_el = this.root.querySelector('.controls #editor-tile');
        this.selected_tile_el.addEventListener('click', ev => {
            if (this.palette_selection && TILES_WITH_PROPS[this.palette_selection.type.name]) {
                // FIXME use tile bounds
                this.open_tile_prop_overlay(this.palette_selection, ev.clientX, ev.clientY);
            }
        });
        // Tools themselves
        let toolbox = mk('div.icon-button-set', {id: 'editor-toolbar'});
        this.root.querySelector('.controls').append(toolbox);
        this.tool_button_els = {};
        for (let toolname of EDITOR_TOOL_ORDER) {
            let tooldef = EDITOR_TOOLS[toolname];
            let button = mk(
                'button', {
                    type: 'button',
                    'data-tool': toolname,
                },
                mk('img', {
                    src: tooldef.icon,
                    alt: tooldef.name,
                }),
                mk('div.-help', mk('h3', tooldef.name), tooldef.desc),
            );
            this.tool_button_els[toolname] = button;
            toolbox.append(button);
        }
        this.current_tool = 'pencil';
        this.tool_button_els['pencil'].classList.add('-selected');
        toolbox.addEventListener('click', ev => {
            let button = ev.target.closest('.icon-button-set button');
            if (! button)
                return;

            this.select_tool(button.getAttribute('data-tool'));
        });

        // Rotation buttons, which affect both the palette tile and the entire palette
        this.palette_rotation_index = 0;
        this.palette_actor_direction = 'south';
        let rotate_left_button = mk('button.--image', {type: 'button'}, mk('img', {src: '/icons/rotate-left.png'}));
        rotate_left_button.addEventListener('click', ev => {
            this.rotate_palette_left();
        });
        // TODO finish this up: this.root.querySelector('.controls').append(rotate_left_button);

        // Toolbar buttons for saving, exporting, etc.
        let button_container = mk('div.-buttons');
        this.root.querySelector('.controls').append(button_container);
        let _make_button = (label, onclick) => {
            let button = mk('button', {type: 'button'}, label);
            button.addEventListener('click', onclick);
            button_container.append(button);
            return button;
        };
        _make_button("Pack properties...", ev => {
            new EditorPackMetaOverlay(this.conductor, this.conductor.stored_game).open();
        });
        _make_button("Level properties...", ev => {
            new EditorLevelMetaOverlay(this.conductor, this.stored_level).open();
        });
        this.save_button = _make_button("Save", ev => {
            // TODO need feedback.  or maybe not bc this should be replaced with autosave later
            // TODO also need to update the pack data's last modified time
            let stored_game = this.conductor.stored_game;
            if (! stored_game.editor_metadata)
                return;

            // Update the pack index; we need to do this to update the last modified time anyway, so
            // there's no point in checking whether anything actually changed
            let pack_key = stored_game.editor_metadata.key;
            this.stash.packs[pack_key].title = stored_game.title;
            this.stash.packs[pack_key].last_modified = Date.now();

            // Update the pack itself
            // TODO maybe should keep this around, but there's a tricky order of operations thing
            // with it
            let pack_stash = load_json_from_storage(pack_key);
            pack_stash.title = stored_game.title;
            pack_stash.last_modified = Date.now();

            // Serialize the level itself
            let buf = c2g.synthesize_level(this.stored_level);
            let stringy_buf = string_from_buffer_ascii(buf);

            // Save everything at once, level first, to minimize chances of an error getting things
            // out of sync
            window.localStorage.setItem(this.stored_level.editor_metadata.key, stringy_buf);
            save_json_to_storage(pack_key, pack_stash);
            save_json_to_storage("Lexy's Labyrinth editor", this.stash);
        });
        if (this.stored_level) {
            this.save_button.disabled = ! this.conductor.stored_game.editor_metadata;
        }
        _make_button("Download", ev => {
            // TODO also allow download as CCL
            // TODO support getting warnings + errors out of synthesis
            let buf = c2g.synthesize_level(this.stored_level);
            let blob = new Blob([buf]);
            let url = URL.createObjectURL(blob);
            // To download a file, um, make an <a> and click it.  Not kidding
            let a = mk('a', {
                href: url,
                download: (this.stored_level.title || 'untitled') + '.c2m',
            });
            document.body.append(a);
            a.click();
            // Absolutely no idea when I'm allowed to revoke this, but surely a minute is safe
            window.setTimeout(() => {
                a.remove();
                URL.revokeObjectURL(url);
            }, 60 * 1000);
        });
        _make_button("Share", ev => {
            let data = util.b64encode(c2g.synthesize_level(this.stored_level));
            let url = new URL(location);
            url.searchParams.delete('level');
            url.searchParams.delete('setpath');
            url.searchParams.append('level', data);
            new EditorShareOverlay(this.conductor, url.toString()).open();
        });
        //_make_button("Toggle green objects");

        // Tile palette
        let palette_el = this.root.querySelector('.palette');
        this.palette = {};  // name => element
        for (let sectiondef of EDITOR_PALETTE) {
            let section_el = mk('section');
            palette_el.append(mk('h2', sectiondef.title), section_el);
            for (let key of sectiondef.tiles) {
                let entry;
                if (SPECIAL_PALETTE_ENTRIES[key]) {
                    let tile = SPECIAL_PALETTE_ENTRIES[key];
                    entry = this.renderer.create_tile_type_canvas(tile.name, tile);
                }
                else {
                    entry = this.renderer.create_tile_type_canvas(key);
                }
                entry.setAttribute('data-palette-key', key);
                entry.classList = 'palette-entry';
                this.palette[key] = entry;
                section_el.append(entry);
            }
        }
        palette_el.addEventListener('click', ev => {
            let entry = ev.target.closest('canvas.palette-entry');
            if (! entry)
                return;

            let key = entry.getAttribute('data-palette-key');
            if (SPECIAL_PALETTE_ENTRIES[key]) {
                // Tile with preconfigured stuff on it
                let tile = Object.assign({}, SPECIAL_PALETTE_ENTRIES[key]);
                tile.type = TILE_TYPES[tile.name];
                delete tile.name;
                this.select_palette(tile);
            }
            else {
                // Regular tile name
                this.select_palette(key);
            }
        });
        this.palette_selection = null;
        this.select_palette('floor');
    }

    activate() {
        super.activate();
        this.renderer.draw();
    }

    _make_cell() {
        let cell = new format_base.StoredCell;
        cell.push({type: TILE_TYPES['floor']});
        return cell;
    }

    _make_empty_level(number, size_x, size_y) {
        let stored_level = new format_base.StoredLevel(number);
        stored_level.title = "untitled level";
        stored_level.size_x = size_x;
        stored_level.size_y = size_y;
        stored_level.viewport_size = 10;
        for (let i = 0; i < size_x * size_y; i++) {
            stored_level.linear_cells.push(this._make_cell());
        }
        stored_level.linear_cells[0].push({type: TILE_TYPES['player'], direction: 'south'});
        return stored_level;
    }

    create_pack() {
        // TODO get a dialog for asking about level meta first?  or is jumping directly into the editor better?
        let stored_level = this._make_empty_level(1, 32, 32);

        let pack_key = `LLP-${Date.now()}`;
        let level_key = `LLL-${Date.now()}`;
        let stored_pack = new format_base.StoredPack(pack_key);
        stored_pack.editor_metadata = {
            key: pack_key,
        };
        stored_level.editor_metadata = {
            key: level_key,
        };
        // FIXME should convert this to the storage-backed version when switching levels, rather
        // than keeping it around?
        stored_pack.level_metadata.push({
            stored_level: stored_level,
            key: level_key,
            title: stored_level.title,
            index: 0,
            number: 1,
        });
        this.conductor.load_game(stored_pack);

        this.stash.packs[pack_key] = {
            title: "Untitled pack",
            level_count: 1,
            last_modified: Date.now(),
        };
        save_json_to_storage("Lexy's Labyrinth editor", this.stash);

        save_json_to_storage(pack_key, {
            levels: [{
                key: level_key,
                title: stored_level.title,
                last_modified: Date.now(),
            }],
        });

        let buf = c2g.synthesize_level(stored_level);
        let stringy_buf = string_from_buffer_ascii(buf);
        window.localStorage.setItem(level_key, stringy_buf);

        this.conductor.switch_to_editor();
    }

    create_scratch_level() {
        let stored_level = this._make_empty_level(1, 32, 32);

        let stored_pack = new format_base.StoredPack(null);
        stored_pack.title = "scratch pack";
        stored_pack.level_metadata.push({
            stored_level: stored_level,
        });
        this.conductor.load_game(stored_pack);

        this.conductor.switch_to_editor();
    }

    load_editor_pack(pack_key) {
        let pack_stash = load_json_from_storage(pack_key);

        let stored_pack = new format_base.StoredPack(pack_key, meta => {
            let buf = bytestring_to_buffer(localStorage.getItem(meta.key));
            let stored_level = c2g.parse_level(buf, meta.number);
            stored_level.editor_metadata = {
                key: meta.key,
            };
            return stored_level;
        });
        // TODO should this also be in the pack's stash...?
        stored_pack.title = this.stash.packs[pack_key].title;
        stored_pack.editor_metadata = {
            key: pack_key,
        };

        for (let [i, leveldata] of pack_stash.levels.entries()) {
            stored_pack.level_metadata.push({
                key: leveldata.key,
                title: leveldata.title,
                index: i,
                number: i + 1,
            });
        }
        this.conductor.load_game(stored_pack);

        this.conductor.switch_to_editor();
    }

    append_new_level() {
        let stored_pack = this.conductor.stored_game;
        let index = stored_pack.level_metadata.length;
        let number = index + 1;
        let stored_level = this._make_empty_level(number, 32, 32);
        let level_key = `LLL-${Date.now()}`;
        stored_level.editor_metadata = {
            key: level_key,
        };
        // FIXME should convert this to the storage-backed version when switching levels, rather
        // than keeping it around?
        stored_pack.level_metadata.push({
            stored_level: stored_level,
            key: level_key,
            title: stored_level.title,
            index: index,
            number: number,
        });

        let pack_key = stored_pack.editor_metadata.key;
        let stash_pack_entry = this.stash.packs[pack_key];
        stash_pack_entry.level_count = number;
        stash_pack_entry.last_modified = Date.now();
        save_json_to_storage("Lexy's Labyrinth editor", this.stash);

        let pack_stash = load_json_from_storage(pack_key);
        pack_stash.levels.push({
            key: level_key,
            title: stored_level.title,
            last_modified: Date.now(),
        });
        save_json_to_storage(pack_key, pack_stash);

        let buf = c2g.synthesize_level(stored_level);
        let stringy_buf = string_from_buffer_ascii(buf);
        window.localStorage.setItem(level_key, stringy_buf);

        this.conductor.change_level(index);
    }

    load_game(stored_game) {
    }

    _xxx_update_stored_level_cells(stored_level) {
        // XXX need this for renderer compat, not used otherwise, PLEASE delete
        stored_level.cells = [];
        let row;
        for (let [i, cell] of stored_level.linear_cells.entries()) {
            if (i % stored_level.size_x === 0) {
                row = [];
                stored_level.cells.push(row);
            }
            row.push(cell);
        }
    }

    load_level(stored_level) {
        // TODO support a game too i guess
        this.stored_level = stored_level;
        this.update_viewport_size();

        this._xxx_update_stored_level_cells(this.stored_level);

        // Load connections
        this.connections_g.textContent = '';
        for (let [src, dest] of Object.entries(this.stored_level.custom_trap_wiring)) {
            let [sx, sy] = this.stored_level.scalar_to_coords(src);
            let [dx, dy] = this.stored_level.scalar_to_coords(dest);
            this.connections_g.append(
                mk_svg('rect.overlay-cxn', {x: sx, y: sy, width: 1, height: 1}),
                mk_svg('line.overlay-cxn', {x1: sx + 0.5, y1: sy + 0.5, x2: dx + 0.5, y2: dy + 0.5}),
            );
        }
        // TODO why are these in connections_g lol
        for (let [i, region] of this.stored_level.camera_regions.entries()) {
            let el = mk_svg('rect.overlay-camera', {x: region.x, y: region.y, width: region.width, height: region.height});
            this.connections_g.append(el);
        }

        this.renderer.set_level(stored_level);
        if (this.active) {
            this.renderer.draw();
        }

        if (this.save_button) {
            this.save_button.disabled = ! this.conductor.stored_game.editor_metadata;
        }
    }

    update_viewport_size() {
        this.renderer.set_viewport_size(this.stored_level.size_x, this.stored_level.size_y);
        this.svg_overlay.setAttribute('viewBox', `0 0 ${this.stored_level.size_x} ${this.stored_level.size_y}`);
    }

    open_level_browser() {
        new EditorLevelBrowserOverlay(this.conductor).open();
    }

    select_tool(tool) {
        if (tool === this.current_tool)
            return;
        if (! this.tool_button_els[tool])
            return;

        this.tool_button_els[this.current_tool].classList.remove('-selected');
        this.current_tool = tool;
        this.tool_button_els[this.current_tool].classList.add('-selected');
    }

    select_palette(name_or_tile) {
        let name, tile;
        if (typeof name_or_tile === 'string') {
            name = name_or_tile;
            tile = { type: TILE_TYPES[name] };

            if (tile.type.is_actor) {
                tile.direction = 'south';
            }
            if (TILES_WITH_PROPS[name]) {
                TILES_WITH_PROPS[name].configure_tile_defaults(tile);
            }
        }
        else {
            tile = Object.assign({}, name_or_tile);
            name = tile.type.name;
        }

        // Deselect any previous selection
        if (this.palette_selection_el) {
            this.palette_selection_el.classList.remove('--selected');
        }

        // Store the tile
        this.palette_selection = tile;

        // Select it in the palette, if possible
        let key = name;
        if (SPECIAL_PALETTE_BEHAVIOR[name]) {
            key = SPECIAL_PALETTE_BEHAVIOR[name].pick_palette_entry(tile);
        }
        this.palette_selection_el = this.palette[key] ?? null;
        if (this.palette_selection_el) {
            this.palette_selection_el.classList.add('--selected');
        }

        this.mark_tile_dirty(tile);

        // Some tools obviously don't work with a palette selection, in which case changing tiles
        // should default you back to the pencil
        if (! EDITOR_TOOLS[this.current_tool].uses_palette) {
            this.select_tool('pencil');
        }
    }

    rotate_tile_left(tile) {
        if (SPECIAL_PALETTE_BEHAVIOR[tile.type.name]) {
            SPECIAL_PALETTE_BEHAVIOR[tile.type.name].rotate_left(tile);
        }
        else if (TILE_TYPES[tile.type.name].is_actor) {
            tile.direction = DIRECTIONS[tile.direction ?? 'south'].left;
        }
        else {
            return false;
        }

        this.mark_tile_dirty(tile);
        return true;
    }

    rotate_tile_right(tile) {
        if (SPECIAL_PALETTE_BEHAVIOR[tile.type.name]) {
            SPECIAL_PALETTE_BEHAVIOR[tile.type.name].rotate_right(tile);
        }
        else if (TILE_TYPES[tile.type.name].is_actor) {
            tile.direction = DIRECTIONS[tile.direction ?? 'south'].right;
        }
        else {
            return false;
        }

        this.mark_tile_dirty(tile);
        return true;
    }

    rotate_palette_left() {
        this.palette_rotation_index += 1;
        this.palette_rotation_index %= 4;
        this.palette_actor_direction = DIRECTIONS[this.palette_actor_direction].left;
    }

    mark_tile_dirty(tile) {
        // TODO partial redraws!  until then, redraw everything
        if (tile === this.palette_selection) {
            // FIXME should redraw in an existing canvas
            this.selected_tile_el.textContent = '';
            this.selected_tile_el.append(this.renderer.create_tile_type_canvas(tile.type.name, tile));
        }
        else {
            this.renderer.draw();
        }
    }

    mark_cell_dirty(cell) {
        this.renderer.draw();
    }

    is_in_bounds(x, y) {
        return 0 <= x && x < this.stored_level.size_x && 0 <= y && y < this.stored_level.size_y;
    }

    cell(x, y) {
        if (this.is_in_bounds(x, y)) {
            return this.stored_level.linear_cells[this.stored_level.coords_to_scalar(x, y)];
        }
        else {
            return null;
        }
    }

    place_in_cell(x, y, tile) {
        // TODO weird api?
        if (! tile)
            return;

        let cell = this.cell(x, y);
        // Replace whatever's on the same layer
        // TODO probably not the best heuristic yet, since i imagine you can
        // combine e.g. the tent with thin walls
        // TODO should preserve wiring if possible too
        for (let i = cell.length - 1; i >= 0; i--) {
            if (cell[i].type.draw_layer === tile.type.draw_layer) {
                cell.splice(i, 1);
            }
        }
        cell.push(Object.assign({}, tile));
        cell.sort((a, b) => a.type.draw_layer - b.type.draw_layer);
    }

    open_tile_prop_overlay(tile, x0, y0) {
        this.cancel_mouse_operation();
        // FIXME keep these around, don't recreate them constantly
        let overlay_class = TILES_WITH_PROPS[tile.type.name];
        let overlay = new overlay_class(this.conductor);
        overlay.edit_tile(tile);
        overlay.open();

        // FIXME move this into TransientOverlay or some other base class
        let root = overlay.root;
        // Vertical position: either above or below, preferring the side that has more space
        if (y0 > document.body.clientHeight / 2) {
            // Above
            root.classList.add('--above');
            root.style.top = `${y0 - root.offsetHeight}px`;
        }
        else {
            // Below
            root.classList.remove('--above');
            root.style.top = `${y0}px`;
        }
        // Horizontal position: centered, but kept within the screen
        let left;
        let margin = 8;  // prefer to not quite touch the edges
        if (document.body.clientWidth < root.offsetWidth + margin * 2) {
            // It doesn't fit on the screen at all, so there's nothing we can do; just center it
            left = (document.body.clientWidth - root.offsetWidth) / 2;
        }
        else {
            left = Math.max(margin, Math.min(document.body.clientWidth - root.offsetWidth - margin,
                x0 - root.offsetWidth / 2));
        }
        root.style.left = `${left}px`;
        root.style.setProperty('--chevron-offset', `${x0 - left}px`);
    }

    cancel_mouse_operation() {
        if (this.mouse_op) {
            this.mouse_op.do_abort();
            this.mouse_op = null;
        }
    }

    resize_level(size_x, size_y, x0 = 0, y0 = 0) {
        let new_cells = [];
        for (let y = y0; y < y0 + size_y; y++) {
            for (let x = x0; x < x0 + size_x; x++) {
                new_cells.push(this.cell(x, y) ?? this._make_cell());
            }
        }

        this.stored_level.linear_cells = new_cells;
        this.stored_level.size_x = size_x;
        this.stored_level.size_y = size_y;
        this._xxx_update_stored_level_cells(this.stored_level);
        this.update_viewport_size();
        this.renderer.draw();
    }
}


