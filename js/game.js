import * as algorithms from './algorithms.js';
import { DIRECTIONS, DIRECTION_ORDER, LAYERS, INPUT_BITS, PICKUP_PRIORITIES, TICS_PER_SECOND } from './defs.js';
import { LevelInterface } from './format-base.js';
import TILE_TYPES from './tiletypes.js';

export class Tile {
    constructor(type, direction = 'south') {
        this.type = type;
        if (type.is_actor) {
            this.direction = direction;
        }
        this.cell = null;

        if (type.is_actor) {
            this.slide_mode = null;
            this.movement_cooldown = 0;
        }

        // Pre-seed actors who are expected to have inventories, with one
        // TODO do i need this at all?
        if (type.item_pickup_priority <= PICKUP_PRIORITIES.normal) {
            this.keyring = {};
            this.toolbelt = [];
        }
    }

    static from_template(tile_template) {
        let type = tile_template.type;
        if (! type) console.error(tile_template);
        let tile = new this(type, tile_template.direction);
        // Copy any extra properties in verbatim
        return Object.assign(tile, tile_template);
    }

    movement_progress(update_progress, update_rate) {
        return (this.movement_speed - this.movement_cooldown + update_rate * (update_progress - 1)) / this.movement_speed;
    }

    // Gives the effective position of an actor in motion, given smooth scrolling
    visual_position(update_progress = 0, update_rate = 0) {
        if (! this.previous_cell || this.movement_speed === null) {
            return [this.cell.x, this.cell.y];
        }

        let cell = this.destination_cell ?? this.cell;
        // For a movement speed of N, the cooldown is set to N - R at the end of the frame/tic an
        // actor starts moving, and we interpolate it from N to that
        let p = this.movement_progress(update_progress, update_rate);
        return [
            (1 - p) * this.previous_cell.x + p * cell.x,
            (1 - p) * this.previous_cell.y + p * cell.y,
        ];
    }

    // TODO don't love that the arg order is different here vs tile type, but also don't love that
    // the name is the same?
    blocks(other, direction, level) {
        // Extremely awkward special case: items don't block monsters if the cell also contains an
        // item modifier (i.e. "no" sign) or a real player
        // TODO would love to get this outta here
        if ((this.type.is_item || this.type.is_chip) && ! level.compat.monsters_blocked_by_items) {
            let item_mod = this.cell.get_item_mod();
            if (item_mod && item_mod.type.item_modifier)
                return false;

            let actor = this.cell.get_actor();
            if (actor && actor.type.is_real_player)
                return false;
        }

        if (level.compat.monsters_ignore_keys && this.type.is_key)
            return false;

        if (this.type.blocks_collision & other.type.collision_mask)
            return true;

        // FIXME bowling ball isn't affected by helmet?  also not sure bowling ball is stopped by
        // helmet?
        if (this.has_item('helmet') || (this.type.is_actor && ! this.type.ttl && other.has_item('helmet')))
            return true;

        // Blocks being pulled are blocked by their pullers (which are, presumably, the only things
        // they can be moving towards)
        // FIXME something about this broke pulling blocks through teleporters; see #99 Delirium
        if (this.type.is_actor && other.type.is_block && other.is_pulled)
            return true;

        // FIXME get this out of here
        if (this.type.thin_walls &&
            this.type.thin_walls.has(DIRECTIONS[direction].opposite) &&
            other.type.name !== 'ghost')
            return true;

        if (this.type.blocks && this.type.blocks(this, level, other, direction))
            return true;

        if (other.type.blocked_by && other.type.blocked_by(other, level, this))
            return true;

        return false;
    }

    ignores(name) {
        if (
        (this.type.ignores && this.type.ignores.has(name)))
        {
            return true;
        }

        if (this.toolbelt) {
            for (let item of this.toolbelt) {
                if (! item)
                    continue;
                let item_type = TILE_TYPES[item];
                if (item_type.item_ignores && item_type.item_ignores.has(name))
                    return true;
            }
        }

        return false;
    }

    slide_ignores(name) {
        if (this.type.slide_ignores && this.type.slide_ignores.has(name))
            return true;

        if (this.toolbelt) {
            for (let item of this.toolbelt) {
                if (! item)
                    continue;
                let item_type = TILE_TYPES[item];
                if (item_type.item_slide_ignores && item_type.item_slide_ignores.has(name))
                    return true;
            }
        }

        return false;
    }

    can_push(tile, direction, level) {
        // This tile already has a push queued, sorry
        if (tile.pending_push)
            return false;

        if (! (this.type.pushes && this.type.pushes[tile.type.name] &&
            (! tile.type.allows_push || tile.type.allows_push(tile, direction))))
        {
            return false;
        }

        // CC2 strikes again: blocks cannot push sliding blocks, except that frame blocks can push
        // sliding dirt blocks!
        if (this.type.is_block && tile.slide_mode && ! (
            this.type.name === 'frame_block' && tile.type.name === 'dirt_block'))
        {
            return false;
        }

        // Obey railroad curvature
        direction = tile.cell.redirect_exit(tile, direction);
        // Need to explicitly check this here, otherwise you could /attempt/ to push a block,
        // which would fail, but it would still change the block's direction
        // XXX this expects to take a level but it only matters with push_mode === 'push'
        return tile.cell.try_leaving(tile, direction, level);
    }

    can_pull(tile, direction) {
        // FIXME starting to think fx should not count as actors
        if (tile.type.ttl)
            return false;
        if (tile.type.name === 'shark') {
            return true;
        }

        // FIXME i don't actually know the precise rules here.  dirt blocks and ghosts can pull
        // other blocks even though they can't usually push them.  given the existence of monster
        // hooking, i suspect /anything/ can be hooked but on monsters it has a weird effect?
        // figure this out?
        return (! tile.type.allows_push || tile.type.allows_push(tile, direction));
    }

    // Inventory stuff
    has_item(name) {
        if (TILE_TYPES[name].is_key) {
            return this.keyring && (this.keyring[name] ?? 0) > 0;
        }
        else {
            return this.toolbelt && this.toolbelt.some(item => item === name);
        }
    }
}
Tile.prototype.emitting_edges = 0;
Tile.prototype.powered_edges = 0;
Tile.prototype.wire_directions = 0;
Tile.prototype.wire_tunnel_directions = 0;

export class Cell extends Array {
    constructor(x, y) {
        super(LAYERS.MAX);
        this.x = x;
        this.y = y;
    }

    _add(tile) {
        let index = tile.type.layer;
        if (this[index]) {
            if (index !== LAYERS.vfx) {
                console.error("ATTEMPTING TO ADD", tile, "TO CELL", this, "WHICH ERASES EXISTING TILE", this[index]);
            }
            this[index].cell = null;
        }
        this[index] = tile;
        tile.cell = this;
    }

    // DO NOT use me to remove a tile permanently, only to move it!
    // Should only be called from Level, which handles some bookkeeping!
    _remove(tile) {
        let index = tile.type.layer;
        if (this[index] !== tile)
            throw new Error("Asked to remove tile that doesn't seem to exist");

        this[index] = null;
        tile.cell = null;
    }

    get_wired_tile() {
        let ret = null;
        for (let tile of this) {
            if (tile && (tile.wire_directions || tile.wire_tunnel_directions) && ! tile.movement_cooldown) {
                ret = tile;
                // Don't break; we want the topmost tile!
            }
        }
        return ret;
    }

    get_terrain() {
        return this[LAYERS.terrain] ?? null;
    }

    get_actor() {
        return this[LAYERS.actor] ?? null;
    }

    get_item() {
        return this[LAYERS.item] ?? null;
    }

    get_item_mod() {
        return this[LAYERS.item_mod] ?? null;
    }

    has(name) {
        let current = this[TILE_TYPES[name].layer];
        return current && current.type.name === name;
    }

    // FIXME honestly no longer sure why these two are on Cell, or even separate really
    try_leaving(actor, direction, level, push_mode) {
        // The only tiles that can trap us are thin walls and terrain, so for perf (this is very hot
        // code), only bother checking those)
        let terrain = this[LAYERS.terrain];
        let thin_walls = this[LAYERS.thin_wall];
        let blocker;

        if (thin_walls && thin_walls.type.blocks_leaving && thin_walls.type.blocks_leaving(thin_walls, actor, direction)) {
            blocker = thin_walls;
        }
        else if (terrain.type.traps && terrain.type.traps(terrain, level, actor)) {
            blocker = terrain;
        }
        else if (terrain.type.blocks_leaving && terrain.type.blocks_leaving(terrain, actor, direction)) {
            blocker = terrain;
        }

        if (blocker) {
            if (push_mode === 'push') {
                if (actor.type.on_blocked) {
                    actor.type.on_blocked(actor, level, direction, blocker);
                }
            }
            return false;
        }

        return true;
    }

    // Check if this actor can move this direction into this cell.  Returns true on success.  May
    // have side effects, depending on the value of push_mode:
    // - null: Default.  Do not impact game state.  Treat pushable objects as blocking.
    // - 'bump': Fire bump triggers.  Don't move pushable objects, but do check whether they /could/
    //   be pushed, recursively if necessary.
    // - 'slap': Like 'bump', but also sets the 'decision' of pushable objects.
    // - 'push': Fire bump triggers.  Attempt to move pushable objects out of the way immediately.
    try_entering(actor, direction, level, push_mode = null) {
        let pushable_tiles = [];
        // Subtleties ahoy!  This is **EXTREMELY** sensitive to ordering.  Consider:
        // - An actor with foil MUST NOT bump a wall on the other side of a thin wall.
        // - A ghost with foil MUST bump a wall (even on the other side of a thin wall) and be
        //   deflected by the resulting steel.
        // - A bowling ball MUST NOT destroy an actor on the other side of a thin wall, or on top of
        //   a regular wall.
        // - A fireball MUST melt an ice block AND ALSO still be deflected by it, even if the ice
        //   block is on top of an item (which blocks the fireball), but NOT one on the other side
        //   of a thin wall.
        // - A rover MUST NOT bump walls underneath a canopy (which blocks it).
        // It seems the order is thus: canopy + thin wall; terrain; actor; item.  Which is the usual
        // ordering from the top down, except that terrain is checked before actors.  Really, the
        // ordering is from "outermost" to "innermost", which makes physical sense.
        let still_blocked = false;
        for (let layer of [
            LAYERS.canopy, LAYERS.thin_wall, LAYERS.terrain, LAYERS.swivel,
            LAYERS.actor, LAYERS.item_mod, LAYERS.item])
        {
            let tile = this[layer];
            if (! tile)
                continue;

            let original_name = tile.type.name;
            // TODO check ignores here?
            if (tile.type.on_bumped) {
                tile.type.on_bumped(tile, level, actor);
            }

            if (! tile.blocks(actor, direction, level))
                continue;

            if (tile.type.on_after_bumped) {
                tile.type.on_after_bumped(tile, level, actor);
            }

            if (push_mode === null)
                return false;

            if (actor.can_push(tile, direction, level) || (
                level.compat.tanks_teeth_push_ice_blocks && tile.type.name === 'ice_block' &&
                (actor.type.name === 'teeth' || actor.type.name === 'teeth_timid' || actor.type.name === 'tank_blue')
            )) {
                // Collect pushables for later, so we don't inadvertently push through a wall
                pushable_tiles.push(tile);
            }
            else {
                // It's in our way and we can't push it, so we're done here
                if (push_mode === 'push') {
                    if (actor.type.on_blocked) {
                        actor.type.on_blocked(actor, level, direction, tile);
                    }
                    // Lynx (or at least TW?) allows pushing blocks off of particular wall types
                    if (level.compat.allow_pushing_blocks_off_faux_walls &&
                        ['fake_wall', 'wall_invisible', 'wall_appearing'].includes(original_name))
                    {
                        still_blocked = true;
                        continue;
                    }
                }
                return false;
            }
        }

        // If we got this far, all that's left is to deal with pushables
        if (pushable_tiles.length > 0) {
            // This ends recursive push attempts, which can happen with a row of ice clogged by ice
            // blocks that are trying to slide
            actor._trying_to_push = true;
            try {
                for (let tile of pushable_tiles) {
                    if (tile._trying_to_push)
                        return false;
                    if (push_mode === 'bump' || push_mode === 'slap') {
                        // FIXME this doesn't take railroad curves into account, e.g. it thinks a
                        // rover can't push a block through a curve
                        if (tile.movement_cooldown > 0 ||
                            ! level.check_movement(tile, tile.cell, direction, push_mode))
                        {
                            return false;
                        }
                        else if (push_mode === 'slap') {
                            if (actor === level.player) {
                                level._set_tile_prop(actor, 'is_pushing', true);
                                level.sfx.play_once('push');
                            }
                            tile.decision = direction;
                        }
                    }
                    else if (push_mode === 'push') {
                        if (actor === level.player) {
                            level._set_tile_prop(actor, 'is_pushing', true);
                        }
                        // We can't directly push a sliding block, even one on a force floor that's
                        // stuck on a wall.  Instead, it becomes a pending move for the block, which
                        // will use this as a decision next time it's allowed to move
                        // FIXME this is clumsy and creates behavior dependent on actor order.  my
                        // original implementation only did this if the push /failed/; is that worth
                        // a compat option?  also, how does any of this work under lynx rules?
                        if (tile.slide_mode === 'force' ||
                            (tile.slide_mode !== null && tile.movement_cooldown > 0))
                        {
                            level._set_tile_prop(tile, 'pending_push', direction);
                            // FIXME if the block has already made a decision then this is necessary
                            // to override it.  but i don't like it; (a) it might cause blocks to
                            // get stuck against walls on force floors, because the code to fix that
                            // is at decision time; (b) it's done for pulling too and just feels
                            // hacky?
                            tile.decision = direction;
                            return false;
                        }

                        if (level.attempt_out_of_turn_step(tile, direction)) {
                            if (actor === level.player) {
                                level.sfx.play_once('push');
                            }
                        }
                        else {
                            return false;
                        }
                    }
                }
            }
            finally {
                delete actor._trying_to_push;
            }

            // In push mode, check one last time for being blocked, in case we e.g. pushed a block
            // off of a recessed wall
            // TODO unclear if this is the right way to emulate spring mining, but without the check
            // for a player, it happens /too/ often; try allowing for ann actors and running the 163
            // BLOX replay, and right at the end ice blocks spring mine each other.  also, the wiki
            // suggests something about another actor moving away at the same time?
            if (! (level.compat.emulate_spring_mining && actor.type.is_real_player) &&
                push_mode === 'push' && this.some(tile => tile && tile.blocks(actor, direction, level)))
                return false;
        }

        return ! still_blocked;
    }

    // Special railroad ability: change the direction we attempt to leave
    redirect_exit(actor, direction) {
        let terrain = this.get_terrain();
        if (terrain && terrain.type.redirect_exit) {
            return terrain.type.redirect_exit(terrain, actor, direction);
        }
        return direction;
    }
}

// The undo stack is implemented with a ring buffer, and this is its size.  One entry per tic.
// Based on Chrome measurements made against the pathological level CCLP4 #40 (Periodic Lasers) and
// sitting completely idle, undo consumes about 2 MB every five seconds, so this shouldn't go beyond
// 12 MB for any remotely reasonable level.
const UNDO_BUFFER_SIZE = TICS_PER_SECOND * 30;
// The CC1 inventory has a fixed boot order
const CC1_INVENTORY_ORDER = ['cleats', 'suction_boots', 'fire_boots', 'flippers'];
export class Level extends LevelInterface {
    constructor(stored_level, compat = {}) {
        super();
        this.stored_level = stored_level;
        this.restart(compat);
    }

    get update_rate() {
        if (this.compat.use_lynx_loop && this.compat.emulate_60fps) {
            return 1;
        }
        else {
            return 3;
        }
    }

    restart(compat) {
        this.compat = compat;

        // playing: normal play
        // success: has been won
        // failure: died
        // note that pausing is NOT handled here, but by whatever's driving our
        // event loop!
        this.state = 'playing';

        this.width = this.stored_level.size_x;
        this.height = this.stored_level.size_y;
        this.size_x = this.stored_level.size_x;
        this.size_y = this.stored_level.size_y;

        this.linear_cells = [];
        this.player = null;
        this.p1_input = 0;
        this.p1_released = 0xff;
        this.actors = [];
        this.chips_remaining = this.stored_level.chips_required ?? 0;
        this.bonus_points = 0;
        this.aid = 0;

        // Time
        this.done_on_begin = false;
        if (this.stored_level.time_limit === 0) {
            this.time_remaining = null;
        }
        else {
            this.time_remaining = this.stored_level.time_limit * 20;
        }
        this.timer_paused = false;
        // Note that this clock counts *up*, even on untimed levels, and is unaffected by CC2's
        // clock alteration shenanigans
        this.tic_counter = 0;
        // 0 to 2, counting which frame within a tic we're on in CC2
        this.frame_offset = 0;
        // 0 to 7, indicating the first tic that teeth can move on.
        // 0 is equivalent to even step; 4 is equivalent to odd step.
        // 5 is the default in CC2.  Lynx can use any of the 8.  MSCC uses
        // either 0 or 4, and defaults to 0, but which you get depends on the
        // global clock which doesn't get reset between levels (!).
        this.step_parity = 5;

        // TODO in lynx/steam, this carries over between levels; in tile world, you can set it manually
        this.force_floor_direction = 'north';
        // PRNG is initialized to zero
        this._rng1 = 0;
        this._rng2 = 0;
        this._tw_rng = Math.floor(Math.random() * 0x80000000);
        if (this.stored_level.blob_behavior === 0) {
            this._blob_modifier = 0x55;
        }
        else {
            // The other two modes are initialized to a random seed
            this._blob_modifier = Math.floor(Math.random() * 256);
        }

        this.undo_buffer = new Array(UNDO_BUFFER_SIZE);
        for (let i = 0; i < UNDO_BUFFER_SIZE; i++) {
            this.undo_buffer[i] = null;
        }
        this.undo_buffer_index = 0;
        this.pending_undo = this.create_undo_entry();
        // If undo_enabled is false, we won't create any undo entries.
        // Undo is only disabled during bulk testing, where a) there's no
        // possibility of needing to undo and b) the overhead is noticable.
        this.undo_enabled = true;

        let n = 0;
        let connectables = [];
        this.remaining_players = 0;
        this.ankh_tile = null;
        // If there's exactly one yellow teleporter when the level loads, it cannot be picked up
        let yellow_teleporter_count = 0;
        this.allow_taking_yellow_teleporters = false;
        // Sokoban buttons function as a group
        this.sokoban_buttons_unpressed = {};
        for (let y = 0; y < this.height; y++) {
            let row = [];
            for (let x = 0; x < this.width; x++) {
                let cell = new Cell(x, y);
                row.push(cell);
                this.linear_cells.push(cell);

                let stored_cell = this.stored_level.linear_cells[n];
                n++;
                for (let template_tile of stored_cell) {
                    if (! template_tile)
                        continue;

                    let tile = Tile.from_template(template_tile);
                    if (tile.type.is_hint) {
                        // Copy over the tile-specific hint, if any
                        tile.hint_text = template_tile.hint_text ?? null;
                    }

                    if (tile.type.is_real_player) {
                        this.remaining_players += 1;
                        if (this.player === null) {
                            this.player = tile;
                        }
                    }
                    if (tile.type.is_required_chip && this.stored_level.chips_required === null) {
                        this.chips_remaining++;
                    }
                    if (tile.type.is_actor) {
                        this.actors.push(tile);
                    }
                    cell._add(tile);

                    if (tile.type.connects_to) {
                        connectables.push(tile);
                    }

                    if (tile.type.name === 'teleport_yellow' && ! this.allow_taking_yellow_teleporters) {
                        yellow_teleporter_count += 1;
                        if (yellow_teleporter_count > 1) {
                            this.allow_taking_yellow_teleporters = true;
                        }
                    }
                    else if (tile.type.name === 'sokoban_button') {
                        this.sokoban_buttons_unpressed[tile.color] =
                            (this.sokoban_buttons_unpressed[tile.color] ?? 0) + 1;
                    }
                }
            }
        }
        if (this.compat.player_moves_last) {
            let i = this.actors.indexOf(this.player);
            if (i > 0) {
                [this.actors[0], this.actors[i]] = [this.actors[i], this.actors[0]];
            }
        }
        // TODO complain if no player
        // Used for doppelgängers
        this.player1_move = null;
        this.player2_move = null;

        // Connect buttons and teleporters
        let num_cells = this.width * this.height;
        for (let connectable of connectables) {
            this.connect_button(connectable);
        }

        this.recalculate_circuitry_next_wire_phase = false;
        this.undid_past_recalculate_circuitry = false;
        this.recalculate_circuitry(true);

        // Finally, let all tiles do custom init behavior...  but backwards, to match actor order
        for (let i = this.linear_cells.length - 1; i >= 0; i--) {
            let cell = this.linear_cells[i];
            for (let tile of cell) {
                if (! tile)
                    continue;
                if (tile.type.on_ready) {
                    tile.type.on_ready(tile, this);
                }
            }
        }
        // Erase undo, in case any on_ready added to it (we don't want to undo initialization!)
        this.pending_undo = this.create_undo_entry();
    }

    connect_button(connectable) {
        let cell = connectable.cell;
        let x = cell.x;
        let y = cell.y;
        // FIXME this is a single string for red/brown buttons (to match iter_tiles_in_RO) but a
        // set for orange buttons (because flame jet states are separate tiles), which sucks ass
        let goals = connectable.type.connects_to;

        // Check for custom wiring, for MSCC .DAT levels
        // TODO would be neat if this applied to orange buttons too
        if (this.stored_level.has_custom_connections) {
            let n = this.stored_level.coords_to_scalar(x, y);
            let target_cell_n = null;
            if (connectable.type.name === 'button_brown') {
                target_cell_n = this.stored_level.custom_trap_wiring[n] ?? null;
            }
            else if (connectable.type.name === 'button_red') {
                target_cell_n = this.stored_level.custom_cloner_wiring[n] ?? null;
            }
            if (target_cell_n && target_cell_n < this.width * this.height) {
                let [tx, ty] = this.stored_level.scalar_to_coords(target_cell_n);
                for (let tile of this.cell(tx, ty)) {
                    if (tile && goals === tile.type.name) {
                        connectable.connection = tile;
                        break;
                    }
                }
            }
            return;
        }

        // Orange buttons do a really weird diamond search
        if (connectable.type.connect_order === 'diamond') {
            for (let cell of this.iter_cells_in_diamond(connectable.cell)) {
                let target = null;
                for (let tile of cell) {
                    if (tile && goals.has(tile.type.name)) {
                        target = tile;
                        break;
                    }
                }
                if (target !== null) {
                    connectable.connection = target;
                    break;
                }
            }
            return;
        }

        // Otherwise, look in reading order
        for (let tile of this.iter_tiles_in_reading_order(cell, goals)) {
            // TODO ideally this should be a weak connection somehow, since dynamite can destroy
            // empty cloners and probably traps too
            connectable.connection = tile;
            // Just grab the first
            break;
        }
    }

    recalculate_circuitry(first_time = false, undoing = false) {
        // Build circuits out of connected wires
        // TODO document this idea

        if (!first_time) {
            for (let circuit of this.circuits) {
                for (let tile of circuit.tiles) {
                    tile[0].circuits = [null, null, null, null];
                }
            }
        }

        this.circuits = [];
        this.power_sources = [];
        let wired_outputs = new Set;
        this.wired_outputs = [];
        let add_to_edge_map = (map, item, edges) => {
            map.set(item, (map.get(item) ?? 0) | edges);
        };
        for (let cell of this.linear_cells) {
            // We're interested in static circuitry, which means terrain
            // OR circuit blocks on top
            let terrain = cell.get_terrain();
            if (! terrain)  // ?!
                continue;

            if (terrain.type.is_power_source) {
                this.power_sources.push(terrain);
            }

            let actor = cell.get_actor();
            let wire_directions = terrain.wire_directions;
            // FIXME this doesn't allow a blank circuit block to erase wires,
            // but it can't anyway because Tile.wire_directions = 0; need some
            // other way to identify a tile as wired, or at least an actor
            if (actor && actor.wire_directions &&
                (actor.movement_cooldown === 0 || this.compat.tiles_react_instantly))
            {
                wire_directions = actor.wire_directions;
            }

            if (! wire_directions && ! terrain.wire_tunnel_directions) {
                // No wires, not interesting...  unless it's a logic gate, which defines its own
                // wires!  We only care about outgoing ones here, on the off chance that they point
                // directly into a non-wired tile, in which case a wire scan won't find them
                if (terrain.type.name === 'logic_gate') {
                    let dir = terrain.direction;
                    let cxns = terrain.type._gate_types[terrain.gate_type];
                    if (! cxns) {
                        // Voodoo tile
                        continue;
                    }
                    for (let i = 0; i < 4; i++) {
                        let cxn = cxns[i];
                        if (cxn && cxn.match(/^out/)) {
                            wire_directions |= DIRECTIONS[dir].bit;
                        }
                        dir = DIRECTIONS[dir].right;
                    }
                }
                else {
                    continue;
                }
            }

            for (let [direction, dirinfo] of Object.entries(DIRECTIONS)) {
                if (! ((wire_directions | terrain.wire_tunnel_directions) & dirinfo.bit))
                    continue;

                if (terrain.circuits && terrain.circuits[dirinfo.index])
                    continue;

                let circuit = {
                    is_powered: first_time ? false : null,
                    tiles: new Map,
                    inputs: new Map,
                };
                this.circuits.push(circuit);
                // At last, a wired cell edge we have not yet handled.  Floodfill from here
                algorithms.trace_floor_circuit(
                    this, terrain.cell, direction,
                    // Wire handling
                    (tile, edges) => {
                        if (! tile.circuits) {
                            tile.circuits = [null, null, null, null];
                        }
                        for (let [direction, dirinfo] of Object.entries(DIRECTIONS)) {
                            if (edges & dirinfo.bit) {
                                tile.circuits[dirinfo.index] = circuit;
                            }
                        }
                        add_to_edge_map(circuit.tiles, tile, edges);
                        if (tile.type.on_power) {
                            // Red teleporters contain wires and /also/ have an on_power
                            // FIXME this isn't quite right since there's seemingly a 1-frame delay
                            wired_outputs.add(tile);
                        }

                        if (tile.type.is_power_source) {
                            // TODO could just do this in a pass afterwards
                            add_to_edge_map(circuit.inputs, tile, edges);
                        }
                    },
                    // Dead end handling (potentially logic gates, etc.)
                    (cell, edge) => {
                        for (let tile of cell) {
                            if (! tile) {
                                continue;
                            }
                            else if (tile.type.name === 'logic_gate') {
                                // Logic gates are the one non-wired tile that get attached to circuits,
                                // mostly so blue teleporters can follow them
                                if (! tile.circuits) {
                                    tile.circuits = [null, null, null, null];
                                }
                                tile.circuits[DIRECTIONS[edge].index] = circuit;

                                let wire = tile.type._gate_types[tile.gate_type][
                                    (DIRECTIONS[edge].index - DIRECTIONS[tile.direction].index + 4) % 4];
                                if (! wire)
                                    return;
                                add_to_edge_map(circuit.tiles, tile, DIRECTIONS[edge].bit);
                                if (wire.match(/^out/)) {
                                    add_to_edge_map(circuit.inputs, tile, DIRECTIONS[edge].bit);
                                }
                            }
                            else if (tile.type.on_power) {
                                // FIXME this isn't quite right since there's seemingly a 1-frame delay
                                add_to_edge_map(circuit.tiles, tile, DIRECTIONS[edge].bit);
                                wired_outputs.add(tile);
                            }
                        }
                    },
                );
            }
        }
        this.wired_outputs = Array.from(wired_outputs);
        this.wired_outputs.sort((a, b) => this.coords_to_scalar(a.cell.x, a.cell.y) - this.coords_to_scalar(b.cell.x, b.cell.y));

        if (!first_time) {
            //update wireables
             for (var i = 0; i < this.width; ++i)
            {
                for (var j = 0; j < this.height; ++j)
                {
                    let terrain = this.cell(i, j).get_terrain();
                    if (terrain.is_wired !== undefined)
                    {
                        terrain.type.on_begin(terrain, this);
                    }
                }
            }

            if (!undoing) {
                this._push_pending_undo(() => this.undid_past_recalculate_circuitry = true);
            }
        }
    }

    can_accept_input() {
        // We can accept input anytime the player can move, i.e. when they're not already moving and
        // not in an un-overrideable slide
        return this.player.movement_cooldown === 0 &&
            (this.player.slide_mode === null || (
                this.player.slide_mode === 'force' && this.player.last_move_was_force));
    }

    // Lynx PRNG, used unchanged in CC2
    prng() {
        let n = (this._rng1 >> 2) - this._rng1;
        if (!(this._rng1 & 0x02)) {
            n -= 1;
        }
        this._rng1 = ((this._rng1 >> 1) | (this._rng2 & 0x80)) & 0xff;
        this._rng2 = ((this._rng2 << 1) | (n & 0x01)) & 0xff;
        return this._rng1 ^ this._rng2;
    }

    // Tile World's PRNG, used for blobs in Tile World Lynx
    _advance_tw_prng() {
        this._tw_rng = ((Math.imul(this._tw_rng, 1103515245) & 0x7fffffff) + 12345) & 0x7fffffff;
    }
    tw_prng_random4() {
        let x = this._tw_rng;
        this._advance_tw_prng();
        return this._tw_rng >> 29;
    }

    // Weird thing done by CC2 to make blobs...  more...  random
    get_blob_modifier() {
        let mod = this._blob_modifier;

        if (this.stored_level.blob_behavior === 1) {
            // "4 patterns" just increments by 1 every time (but /after/ returning)
            //this._blob_modifier = (this._blob_modifier + 1) % 4;
            mod = (mod + 1) % 4;
            this._blob_modifier = mod;
        }
        else {
            // Other modes do this curious operation
            mod *= 2;
            if (mod < 255) {
                mod ^= 0x1d;
            }
            mod &= 0xff;
            this._blob_modifier = mod;
        }

        return mod;
    }

    // Move the game state forwards by one tic.
    // Input is a bit mask of INPUT_BITS.
    advance_tic(p1_input) {
        if (this.state !== 'playing') {
            console.warn(`Attempting to advance game when state is ${this.state}`);
            return;
        }

        // If someone is mixing tics and frames, run in frames until the end of the tic
        if (this.frame_offset > 0) {
            for (let i = this.frame_offset; i < 3; i++) {
                this.advance_frame(p1_input);
            }
            return;
        }

        this._do_init_phase();
        this._set_p1_input(p1_input);

        if (this.compat.use_lynx_loop) {
            if (this.compat.emulate_60fps) {
                this._advance_tic_lynx60();
            }
            else {
                this._advance_tic_lynx();
            }
        }
        else {
            this._advance_tic_lexy();
        }
    }

    // Default loop: run at 20 tics per second, split things into some more loops
    _advance_tic_lexy() {
        // Under CC2 rules, there are two wire updates at the very beginning of the game before the
        // player can actually move.  That means the first tic has five wire phases total.
        if (this.tic_counter === 0) {
            this._do_wire_phase();
            this._do_wire_phase();
        }

        this._do_decision_phase();

        // Lexy's separate movement loop
        for (let i = this.actors.length - 1; i >= 0; i--) {
            let actor = this.actors[i];
            if (! actor.cell)
                continue;

            this._do_actor_movement(actor, actor.decision);
        }

        // Advance everyone's cooldowns
        // Note that we iterate in reverse order, DESPITE keeping dead actors around with null
        // cells, to match the Lynx and CC2 behavior.  This is actually important in some cases;
        // check out the start of CCLP3 #54, where the gliders will eat the blue key immediately if
        // they act in forward order!  (More subtly, even the decision pass does things like
        // advance the RNG, so for replay compatibility it needs to be in reverse order too.)
        for (let i = this.actors.length - 1; i >= 0; i--) {
            let actor = this.actors[i];
            // Actors with no cell were destroyed
            if (! actor.cell)
                continue;

            if (! actor.type.ttl) {
                this._do_actor_cooldown(actor, 3);
            }
        }

        // Mini extra pass: deal with teleporting separately.  Otherwise, actors may have been in
        // the way of the teleporter but finished moving away during the above loop; this is
        // particularly bad when it happens with a block you're pushing.  (CC2 doesn't need to do
        // this because blocks you're pushing are always a frame ahead of you anyway.)
        // This is also where we handle tiles with persistent standing behavior.
        for (let i = this.actors.length - 1; i >= 0; i--) {
            let actor = this.actors[i];
            if (! actor.cell)
                continue;
            if (actor.type.ttl)
                continue;

            this._do_actor_idle(actor);
        }

        this._swap_players();

        // Wire updates every frame, which means thrice per tic
        this._do_wire_phase();
        this._do_wire_phase();
        this._do_wire_phase();

        this._do_cleanup_phase();
    }

    // Lynx loop: everyone decides, then everyone moves/cools in a single pass
    _advance_tic_lynx() {
        this._do_decision_phase();
        this._do_combined_action_phase(3);
        this._do_wire_phase();
        this._do_wire_phase();
        this._do_wire_phase();

        this._do_cleanup_phase();
    }

    // CC2 loop: similar to the Lynx loop, but run three times per tic, and non-forced decisions can
    // only be made every third frame
    _advance_tic_lynx60() {
        this._do_decision_phase(true);
        this._do_combined_action_phase(1, true);
        this._do_wire_phase();

        this.frame_offset = 1;
        this._do_decision_phase(true);
        this._do_combined_action_phase(1, true);
        this._do_wire_phase();

        this.frame_offset = 2;
        this._do_decision_phase();
        this._do_combined_action_phase(1);
        this._do_wire_phase();

        this.frame_offset = 0;
        this._do_cleanup_phase();
    }

    // Attempt to advance by one FRAME at a time.  Primarily useful for running 60 FPS mode at,
    // well, 60 FPS.
    advance_frame(p1_input) {
        if (this.compat.use_lynx_loop && this.compat.emulate_60fps) {
            // Lynx 60, i.e. CC2
            if (this.frame_offset === 0) {
                this._do_init_phase(p1_input);
            }
            this._set_p1_input(p1_input);
            let is_decision_frame = this.frame_offset === 2;

            this._do_decision_phase(! is_decision_frame);
            this._do_combined_action_phase(1, ! is_decision_frame);
            this._do_wire_phase();

            if (this.frame_offset === 2) {
                this._do_cleanup_phase();
            }
        }
        else {
            // This is either Lexy mode or Lynx mode, and either way we run at 20 tps
            if (this.frame_offset === 0) {
                this.advance_tic(p1_input);
            }
        }

        this.frame_offset = (this.frame_offset + 1) % 3;
    }

    _set_p1_input(p1_input) {
        this.p1_input = p1_input;
        this.p1_released |= ~p1_input;  // Action keys released since we last checked them
        this.swap_player1 = false;
    }

    _do_init_phase() {
        // At the beginning of the very first tic, some tiles want to do initialization that's not
        // appropriate to do before the game begins.  (For example, bombs blow up anything that
        // starts on them in CC2, but we don't want to do that before the game has run at all.  We
        // DEFINITELY don't want to blow the PLAYER up before the game starts!)
        if (! this.done_on_begin) {
            // Run backwards, to match actor order
            for (let i = this.linear_cells.length - 1; i >= 0; i--) {
                let cell = this.linear_cells[i];
                for (let tile of cell) {
                    if (tile && tile.type.on_begin) {
                        tile.type.on_begin(tile, this);
                    }
                }
            }
            // It's not possible to rewind to before this happened, so clear undo and permanently
            // set a flag
            this.pending_undo = this.create_undo_entry();
            this.done_on_begin = true;
        }

        if (this.undo_enabled) {
            // Store some current level state in the undo entry.  (These will often not be modified, but
            // they only take a few bytes each so that's fine.)
            for (let key of [
                    '_rng1', '_rng2', '_blob_modifier', '_tw_rng', 'force_floor_direction',
                    'tic_counter', 'frame_offset', 'time_remaining', 'timer_paused',
                    'chips_remaining', 'bonus_points', 'state',
                    'player1_move', 'player2_move', 'remaining_players', 'player',
            ]) {
                this.pending_undo.level_props[key] = this[key];
            }
        }

        this.sfx.set_player_position(this.player.cell);
    }

    // Decision phase: all actors decide on their movement "simultaneously"
    _do_decision_phase(forced_only = false) {
        // Before decisions happen, remember the player's /current/ direction, which may be affected
        // by sliding.  This will be used by doppelgängers earlier in actor order than the player.
        if (! forced_only) {
            // Check whether the player is /attempting/ to move: either they did, or they're blocked
            if (this.player.movement_cooldown > 0 || this.player.is_blocked) {
                this.remember_player_move(this.player.direction);
            }
            else {
                this.remember_player_move(null);
            }
        }

        for (let i = this.actors.length - 1; i >= 0; i--) {
            let actor = this.actors[i];

            // Clear any old decisions ASAP.  Note that this prop is only used internally within a
            // single tic, so it doesn't need to be undoable
            actor.decision = null;
            // This is a renderer prop and only exists between two loops
            if (actor.destination_cell) {
                this._set_tile_prop(actor, 'destination_cell', null);
            }

            if (! actor.cell)
                continue;

            if (actor.type.ttl) {
                // Animations, bizarrely, do their cooldown at decision time, so they're removed
                // early on the tic that they expire
                this._do_actor_cooldown(actor, this.compat.emulate_60fps ? 1 : 3);
                continue;
            }

            if (actor.movement_cooldown > 0)
                continue;

            // Erase old traces of movement now
            if (actor.movement_speed) {
                this._set_tile_prop(actor, 'previous_cell', null);
                this._set_tile_prop(actor, 'movement_speed', null);
                if (actor.is_pulled) {
                    this._set_tile_prop(actor, 'is_pulled', false);
                }
                if (actor.not_swimming) {
                    this._set_tile_prop(actor, 'not_swimming', false);
                }
            }

            if (actor === this.player) {
                this.make_player_decision(actor, this.p1_input, forced_only);
            }
            else {
                this.make_actor_decision(actor, forced_only);
            }
        }
    }

    // Lynx's combined action phase: each actor attempts to move, then cools down, in order
    _do_combined_action_phase(cooldown, forced_only = false) {
        for (let i = this.actors.length - 1; i >= 0; i--) {
            let actor = this.actors[i];
            if (! actor.cell)
                continue;

            this._do_actor_movement(actor, actor.decision);
            if (actor.type.ttl)
                continue;

            this._do_actor_cooldown(actor, cooldown);
            this._do_actor_idle(actor);
        }

        this._swap_players();
    }

    // Have an actor attempt to move
    _do_actor_movement(actor, direction) {
        // Check this again, since an earlier pass may have caused us to start moving
        if (actor.movement_cooldown > 0)
            return;

        if (! direction)
            return true;

        // Clear this here since we use it to prevent pushing a block that's already been pushed.
        // Also avoids a perverse CC2 ordering issue: a player with a hook sets this on a block at
        // decision time; the block makes its decision (based on this); but then the player acts and
        // sets this /again/ so it carries over and the block tries to move an extra time next turn.
        if (actor.pending_push) {
            this._set_tile_prop(actor, 'pending_push', null);
        }
        // Turntable slide wears off after a single /attempted/ move
        if (actor.slide_mode === 'turntable') {
            this.make_slide(actor, null);
        }

        // Actor is allowed to move, so do so
        let success = this.attempt_step(actor, direction);

        // CC2 handles bonking for all kinds of sliding here -- bonking on ice causes an immediate
        // turnaround, and bonking on a force floor tries again (including rolling a new RFF)
        // TODO this assumes the slide comes from the terrain, which is always the case atm
        if (! success) {
            let terrain = actor.cell.get_terrain();
            if (terrain && (
                // Actors bonk on ice even if they're not already sliding (whether because they
                // started on ice or dropped boots on ice)
                // TODO weird cc2 quirk/bug: ghosts bonk on ice even though they don't slide on it
                // FIXME and if they have cleats, they get stuck instead (?!)
                (terrain.type.slide_mode === 'ice' && (
                    ! actor.ignores(terrain.type.name) || actor.type.name === 'ghost')) ||
                // But they only bonk on a force floor if it affects them
                (terrain.type.slide_mode === 'force' &&
                    actor.slide_mode && ! actor.ignores(terrain.type.name))))
            {
                // Turn the actor around so ice corners bonk correctly
                if (terrain.type.slide_mode === 'ice') {
                    this.set_actor_direction(actor, DIRECTIONS[direction].opposite);
                }
                // Pretend they stepped on the tile again
                // Note that ghosts bonk even on ice corners, which they can otherwise pass through,
                // argh!
                if (terrain.type.on_arrive && actor.type.name !== 'ghost') {
                    terrain.type.on_arrive(terrain, this, actor);
                }
                // If we got a new direction, try moving again
                if (direction !== actor.direction && ! this.compat.bonking_isnt_instant) {
                    success = this.attempt_step(actor, actor.direction);
                }
            }
            else if (actor.slide_mode === 'teleport') {
                // Failed teleport slides only last for a single attempt.  (Successful teleports
                // continue the slide until landing on a new tile, as normal; otherwise you couldn't
                // push a block coming out of a teleporter.)
                this.make_slide(actor, null);
            }
        }

        // Track whether the player is blocked, both for visual effect and for doppelgangers
        if (actor === this.player && ! success) {
            if (actor.last_blocked_direction !== actor.direction) {
                // This is only used for checking when to play the mmf sound, doesn't need undoing;
                // it's cleared when we make a successful move or a null decision
                actor.last_blocked_direction = actor.direction;
                this.sfx.play_once('blocked');
            }
            this._set_tile_prop(actor, 'is_blocked', true);
        }

        return success;
    }

    _do_actor_cooldown(actor, cooldown = 3) {
        if (actor.movement_cooldown <= 0)
            return;

        if (actor.last_extra_cooldown_tic === this.tic_counter)
            return;

        this._set_tile_prop(actor, 'movement_cooldown', Math.max(0, actor.movement_cooldown - cooldown));

        if (actor.movement_cooldown <= 0) {
            if (actor.type.ttl) {
                // This is an animation that just finished, so destroy it
                this.remove_tile(actor);
                return;
            }

            if (! this.compat.tiles_react_instantly) {
                this.step_on_cell(actor, actor.cell);
            }
            // Note that we don't erase the movement bookkeeping until next decision phase, because
            // the renderer interpolates back in time and needs to know to draw us finishing the
            // move; this should be fine since everything checks for "in motion" by looking at
            // movement_cooldown, which is already zero.  (Also saves some undo budget, since
            // movement_speed is never null for an actor in constant motion.)
        }
    }

    _do_actor_idle(actor) {
        if (actor.movement_cooldown <= 0) {
            let terrain = actor.cell.get_terrain();
            if (terrain.type.on_stand && ! actor.ignores(terrain.type.name)) {
                terrain.type.on_stand(terrain, this, actor);
            }
        }
        // Lynx gives everything in an open trap an extra cooldown, which makes things walk into
        // open traps at double speed and does weird things to the ejection timing
        if (this.compat.traps_like_lynx) {
            let terrain = actor.cell.get_terrain();
            if (terrain && terrain.type.name === 'trap' && terrain.presses > 0) {
                this._do_extra_cooldown(actor);
            }
        }
        if (actor.just_stepped_on_teleporter) {
            this.attempt_teleport(actor);
        }
    }

    _swap_players() {
        if (this.remaining_players <= 0) {
            this.win();
        }

        // Possibly switch players
        // FIXME cc2 has very poor interactions between this feature and cloners; come up with some
        // better rules as a default
        if (this.swap_player1) {
            this.swap_player1 = false;
            // Reset the set of keys released since last tic (but not the swap key, or holding it
            // will swap us endlessly)
            // FIXME this doesn't even quite work, it just swaps less aggressively?  wtf
            this.p1_released = 0xff & ~INPUT_BITS.swap;
            // Clear remembered moves
            this.player1_move = null;
            this.player2_move = null;

            // Iterate backwards over the actor list looking for a viable next player to control
            let i0 = this.actors.indexOf(this.player);
            if (i0 < 0) {
                i0 = 0;
            }
            let i = i0;
            while (true) {
                i -= 1;
                if (i < 0) {
                    i += this.actors.length;
                }
                if (i === i0)
                    break;

                let actor = this.actors[i];
                if (! actor.cell)
                    continue;

                if (actor.type.is_real_player) {
                    this.player = actor;
                    if (this.compat.player_moves_last && i !== 0) {
                        [this.actors[0], this.actors[i]] = [this.actors[i], this.actors[0]];
                    }
                    break;
                }
            }
        }
    }

    _do_cleanup_phase() {
        // Lynx compat: Any blue tank that still has the reversal flag set here, but is in motion,
        // should ignore it.  Unfortunately this has to be done as its own pass (as it is in Lynx!)
        // because of acting order issues
        if (this.compat.tanks_ignore_button_while_moving) {
            for (let actor of this.actors) {
                if (actor.cell && actor.pending_reverse && actor.movement_cooldown > 0) {
                    this._set_tile_prop(actor, 'pending_reverse', false);
                }
            }
        }

        // Strip out any destroyed actors from the acting order
        // FIXME this is O(n), where n is /usually/ small, but i still don't love it.  not strictly
        // necessary, either; maybe only do it every few tics?
        let p = 0;
        for (let i = 0, l = this.actors.length; i < l; i++) {
            let actor = this.actors[i];
            if (actor.cell || (
                // Don't strip out actors under Lynx, where slots were reused -- unless they're VFX,
                // which aren't in the original game and thus are exempt
                this.compat.reuse_actor_slots && actor.type.layer !== LAYERS.vfx))
            {
                if (p !== i) {
                    this.actors[p] = actor;
                }
                p++;
            }
            else {
                let local_p = p;
                this._push_pending_undo(() => this.actors.splice(local_p, 0, actor));
            }
        }
        this.actors.length = p;

        // Advance the clock
        // TODO i suspect cc2 does this at the beginning of the tic, but even if you've won?  if you
        // step on a penalty + exit you win, but you see the clock flicker 1 for a single frame.
        // maybe the win check happens at the start of the frame too?
        this.tic_counter += 1;
        if (this.time_remaining !== null && ! this.timer_paused) {
            this.time_remaining -= 1;
            if (this.time_remaining <= 0) {
                this.fail('time');
            }
            else if (this.time_remaining % 20 === 0 && this.time_remaining < 30 * 20) {
                this.sfx.play_once('tick');
            }
        }

        this.commit();
    }

    // TODO this only has one caller
    _extract_player_directions(input) {
        // Extract directions from an input mask
        let dir1 = null, dir2 = null;
        if (((input & INPUT_BITS['up']) && (input & INPUT_BITS['down'])) ||
            ((input & INPUT_BITS['left']) && (input & INPUT_BITS['right'])))
        {
            // If two opposing directions are held at the same time, all input is ignored, so we
            // can't end up with more than 2 directions
        }
        else {
            for (let [direction, dirinfo] of Object.entries(DIRECTIONS)) {
                if (input & INPUT_BITS[dirinfo.action]) {
                    if (dir1 === null) {
                        dir1 = direction;
                    }
                    else {
                        dir2 = direction;
                        break;
                    }
                }
            }
        }
        return [dir1, dir2];
    }

    make_player_decision(actor, input, forced_only = false) {
        // Only reset the player's is_pushing between movement, so it lasts for the whole push
        this._set_tile_prop(actor, 'is_pushing', false);
        // This effect only lasts one tic, after which we can move again.  Note that this one has
        // gameplay impact -- doppelgangers use it to know if they should copy your facing direction
        // even if you're not moving
        if (! forced_only) {
            this._set_tile_prop(actor, 'is_blocked', false);
        }

        // TODO player in a cloner can't move (but player in a trap can still turn)

        let try_direction = (direction, push_mode) => {
            direction = actor.cell.redirect_exit(actor, direction);
            // FIXME if the player steps into a monster cell here, they die instantly!  but only
            // if the cell doesn't block them??
            return this.check_movement(actor, actor.cell, direction, push_mode);
        };

        // The player is unusual in several ways.
        // - Only the current player can override a force floor (and only if their last move was an
        //   involuntary force floor slide, perhaps before some number of ice slides).
        // - The player "block slaps", a phenomenon where they physically attempt to make both of
        //   their desired movements, having an impact on the world if appropriate, before deciding
        //   which of them to use.
        // - These two properties combine in a subtle way.  If we're on a force floor sliding right
        //   under a row of blue walls, then if we hold up, we will bump every wall along the way.
        //   If we hold up /and right/, we will only bump every other wall.  That is, if we're on a
        //   force floor and attempt to override but /fail/, it's not held against us -- but if we
        //   succeed, even if overriding in the same direction we're already moving, that does count
        //   as an override.
        let terrain = actor.cell.get_terrain();
        let may_move = ! forced_only && (
            ! actor.slide_mode ||
            (actor.slide_mode === 'force' && actor.last_move_was_force) ||
            ((actor.slide_mode === 'teleport' || actor.slide_mode === 'teleport-forever') &&
                actor.cell.get_terrain().type.teleport_allow_override));
        let [dir1, dir2] = this._extract_player_directions(input);

        // Check for special player actions, which can only happen at decision time.  Dropping can
        // only be done when the player is allowed to make a move (i.e. override), but the other two
        // can be done freely while sliding.
        // FIXME cc2 seems to rely on key repeat for this; if you have four bowling balls and hold
        // Q, you'll throw the first, wait a second or so, then release the rest rapid-fire.  absurd
        if (! forced_only) {
            let new_input = input & this.p1_released;
            if (new_input & INPUT_BITS.cycle) {
                this.cycle_inventory(this.player);
                this.p1_released &= ~INPUT_BITS.cycle;
            }
            if ((new_input & INPUT_BITS.drop) && may_move) {
                if (this.drop_item(this.player)) {
                    this.sfx.play_once('drop');
                }
                this.p1_released &= ~INPUT_BITS.drop;
            }
            if ((new_input & INPUT_BITS.swap) && this.remaining_players > 1) {
                // This is delayed until the end of the tic to avoid screwing up anything
                // checking this.player
                this.swap_player1 = true;
                this.p1_released &= ~INPUT_BITS.swap;
            }
        }

        if (actor.slide_mode && ! (may_move && dir1)) {
            // This is a forced move and we're not overriding it, so we're done
            actor.decision = actor.direction;

            if (actor.slide_mode === 'force') {
                this._set_tile_prop(actor, 'last_move_was_force', true);
            }
        }
        else if (dir1 === null || forced_only) {
            // Not attempting to move, so do nothing
        }
        else {
            // At this point, we have exactly 1 or 2 directions, and deciding between them requires
            // checking which ones are blocked.  Note that we do this even if only one direction is
            // requested, meaning that we get to push blocks before anything else has moved!
            let push_mode = this.compat.no_early_push ? 'slap' : 'push';
            let open;
            if (dir2 === null) {
                // Only one direction is held, but for consistency, "check" it anyway
                open = try_direction(dir1, push_mode);
                actor.decision = dir1;
            }
            else {
                // We have two directions.  If one of them is our current facing, we prefer that
                // one, UNLESS it's blocked AND the other isn't.
                // Note that if this is an override, then the forced direction is still used to
                // interpret our input!
                if (dir1 === actor.direction || dir2 === actor.direction) {
                    let other_direction = dir1 === actor.direction ? dir2 : dir1;
                    let curr_open = try_direction(actor.direction, push_mode);
                    let other_open = try_direction(other_direction, push_mode);
                    if (! curr_open && other_open) {
                        actor.decision = other_direction;
                        open = true;
                    }
                    else {
                        actor.decision = actor.direction;
                        open = curr_open;
                    }
                }
                else {
                    // Neither direction is the way we're moving, so try both and prefer horizontal
                    // FIXME i'm told cc2 prefers orthogonal actually, but need to check on that
                    // FIXME lynx only checks horizontal, what about cc2?  it must check both
                    // because of the behavior where pushing into a corner always pushes horizontal
                    let open1 = try_direction(dir1, push_mode);
                    let open2 = try_direction(dir2, push_mode);
                    if (open1 && ! open2) {
                        actor.decision = dir1;
                        open = true;
                    }
                    else if (! open1 && open2) {
                        actor.decision = dir2;
                        open = true;
                    }
                    else if (dir1 === 'east' || dir1 === 'west') {
                        actor.decision = dir1;
                        open = open1;
                    }
                    else {
                        actor.decision = dir2;
                        open = open2;
                    }
                }
            }

            // If we're overriding a force floor but the direction we're moving in is blocked, this
            // counts as a forced move (but only under the CC2 behavior of instant bonking)
            if (actor.slide_mode === 'force' && ! open && ! this.compat.bonking_isnt_instant) {
                this._set_tile_prop(actor, 'last_move_was_force', true);
            }
            else {
                // Otherwise this is 100% a conscious move so we lose our override power next tic
                // TODO how does this interact with teleports
                this._set_tile_prop(actor, 'last_move_was_force', false);
            }
        }

        if (actor.decision === null && ! forced_only) {
            actor.last_blocked_direction = null;
        }

        // Remember our decision so doppelgängers can copy it
        this.remember_player_move(actor.decision);
    }

    make_actor_decision(actor, forced_only = false) {
        if (actor.pending_push) {
            // Blocks that were pushed while sliding will move in the push direction as soon as
            // they can make a decision, even if they're still sliding or are off-tic.  Also used
            // for hooking.  (Note that if the block is on a force floor and is blocked in the push
            // direction, under CC2 rules it'll then try the force floor; see attempt_step.)
            // This isn't cleared until the block actually attempts a move; see _do_actor_movement.
            actor.decision = actor.pending_push;
            return;
        }

        let direction_preference;
        let terrain = actor.cell.get_terrain();
        if (actor.slide_mode ||
            // TODO weird cc2 quirk/bug: ghosts bonk on ice even though they don't slide on it
            // FIXME and if they have cleats, they get stuck instead (?!)
            (actor.type.name === 'ghost' && terrain.type.slide_mode === 'ice'))
        {
            // Actors can't make voluntary moves while sliding; they just, ah, slide.
            actor.decision = actor.direction;
            return;
        }
        if (forced_only)
            return;
        if (terrain.type.traps && terrain.type.traps(terrain, this, actor)) {
            // An actor in a cloner or a closed trap can't turn
            // TODO because of this, if a tank is trapped when a blue button is pressed, then
            // when released, it will make one move out of the trap and /then/ turn around and
            // go back into the trap.  this is consistent with CC2 but not ms/lynx
            return;
        }
        if (actor.type.decide_movement) {
            direction_preference = actor.type.decide_movement(actor, this);
        }

        // Check which of those directions we *can*, probably, move in
        if (! direction_preference)
            return;
        for (let [i, direction] of direction_preference.entries()) {
            if (! direction) {
                // This actor is giving up!  Alas.
                actor.decision = null;
                break;
            }
            if (typeof direction === 'function') {
                // Lazy direction calculation (used for walkers)
                direction = direction();
            }

            direction = actor.cell.redirect_exit(actor, direction);

            if (this.check_movement(actor, actor.cell, direction, 'bump')) {
                // We found a good direction!  Stop here
                actor.decision = direction;
                break;
            }

            // If every other preference be blocked, actors unconditionally try the last one
            // (and might even be able to move that way by the time their turn comes!)
            if (i === direction_preference.length - 1) {
                actor.decision = direction;
            }
        }
    }

    check_movement(actor, orig_cell, direction, push_mode) {
        // Lynx: Players can't override backwards on force floors, and it functions like blocking,
        // but does NOT act like a bonk (hence why it's here)
        if (this.compat.no_backwards_override && actor === this.player &&
            actor.slide_mode === 'force' && direction === DIRECTIONS[actor.direction].opposite)
        {
            return false;
        }

        let dest_cell = this.get_neighboring_cell(orig_cell, direction);
        if (! dest_cell) {
            if (push_mode === 'push') {
                if (actor.type.on_blocked) {
                    actor.type.on_blocked(actor, this, direction, null);
                }
            }
            return false;
        }

        let success = (
            orig_cell.try_leaving(actor, direction, this, push_mode) &&
            dest_cell.try_entering(actor, direction, this, push_mode));

        // If we have the hook, pull anything behind us, now that we're out of the way.
        // In CC2, this has to happen here to make hook-slapping work and allow hooking a moving
        // block to stop us, and it has to use pending decisions rather than an immediate move
        // because we're still in the way (so the block can't move) and also to prevent a block from
        // being able to follow us through a swivel (which we haven't swiveled at decision time).
        if (this.compat.use_legacy_hooking && success && actor.has_item('hook')) {
            let behind_cell = this.get_neighboring_cell(orig_cell, DIRECTIONS[direction].opposite);
            if (behind_cell) {
                let behind_actor = behind_cell.get_actor();
                if (behind_actor && actor.can_pull(behind_actor, direction)) {
                    if (behind_actor.movement_cooldown) {
                        return false;
                    }
                    else if (behind_actor.type.is_block && push_mode === 'push') {
                        this._set_tile_prop(behind_actor, 'is_pulled', true);
                        this._set_tile_prop(behind_actor, 'pending_push', direction);
                        behind_actor.decision = direction;
                    }
                }
            }
        }

        return success;
    }

    // Try to move the given actor one tile in the given direction and update their cooldown.
    // Return true if successful.
    attempt_step(actor, direction) {
        // In mid-movement, we can't even change direction!
        if (actor.movement_cooldown > 0)
            return false;

        let redirected_direction = actor.cell.redirect_exit(actor, direction);
        if (direction !== redirected_direction) {
            // Some tiles (ahem, frame blocks) rotate when their attempted direction is redirected
            if (actor.type.on_rotate) {
                let turn = ['right', 'left', 'opposite'].filter(t => {
                    return DIRECTIONS[direction][t] === redirected_direction;
                })[0];
                actor.type.on_rotate(actor, this, turn);
            }

            direction = redirected_direction;
        }

        // Grab speed /first/, in case the movement or on_blocked turns us into an animation
        // immediately (and then we won't have a speed!)
        // FIXME that's a weird case actually since the explosion ends up still moving
        let speed = actor.type.movement_speed;

        let success = this.check_movement(actor, actor.cell, direction, 'push');
        // Only set direction after checking movement; check_movement needs it for preventing
        // backwards overriding in Lynx
        this.set_actor_direction(actor, direction);
        if (! success)
            return false;

        // We're clear!  Compute our speed and move us
        // FIXME this feels clunky
        let goal_cell = this.get_neighboring_cell(actor.cell, direction);
        let terrain = goal_cell.get_terrain();
        if (terrain && terrain.type.speed_factor && ! actor.ignores(terrain.type.name) && !actor.slide_ignores(terrain.type.name)) {
            speed /= terrain.type.speed_factor;
        }
        //speed boots speed us up UNLESS we're entering a terrain with a speed factor and an unignored slide mode (so e.g. we gain 2x on teleports, ice + ice skates, force floors + suction boots, sand and dash floors, but we don't gain 2x sliding on ice or force floors unless it's the turn we're leaving them)
        if (actor.has_item('speed_boots')
        && !(terrain.type.speed_factor && terrain.type.slide_mode && !actor.ignores(terrain.type.name) && !actor.slide_ignores(terrain.type.name)))
        {
            speed /= 2;
        }
        //sharks move at double speed while pursuing
        if (actor.mood && actor.mood == 'teeth') {
            speed /= 2;
        }

        let orig_cell = actor.cell;
        this._set_tile_prop(actor, 'previous_cell', orig_cell);
        let duration = speed * 3;
        this._set_tile_prop(actor, 'movement_cooldown', duration);
        this._set_tile_prop(actor, 'movement_speed', duration);
        this.move_to(actor, goal_cell);

        // Do Lexy-style hooking here: only attempt to pull things just after we've actually moved
        // successfully, which means the hook can never stop us from moving and hook slapping is not
        // a thing, and also make them a real move rather than a weird pending thing
        if (! this.compat.use_legacy_hooking && actor.has_item('hook')) {
            let behind_cell = this.get_neighboring_cell(orig_cell, DIRECTIONS[direction].opposite);
            if (behind_cell) {
                let behind_actor = behind_cell.get_actor();
                if (behind_actor && actor.can_pull(behind_actor, direction) && (behind_actor.type.is_block || behind_actor.type.name === 'shark')) {
                    this._set_tile_prop(behind_actor, 'is_pulled', true);
                    this.attempt_out_of_turn_step(behind_actor, direction);
                }
            }
        }

        if (actor === this.player) {
            actor.last_blocked_direction = null;
        }

        return true;
    }

    attempt_out_of_turn_step(actor, direction) {
        if (actor.slide_mode === 'turntable') {
            // Something is (e.g.) pushing a block that just landed on a turntable and is waiting to
            // slide out of it.  Ignore the push direction and move in its current direction;
            // otherwise a player will push a block straight through, then turn, which sucks
            direction = actor.direction;
        }
        let success = this.attempt_step(actor, direction);
        if (success) {
            this._do_extra_cooldown(actor);
        }
        return success;
    }

    _do_extra_cooldown(actor) {
        this._do_actor_cooldown(actor, this.compat.emulate_60fps ? 1 : 3);
        // Only Lexy has double-cooldown protection
        if (! this.compat.use_lynx_loop) {
            this._set_tile_prop(actor, 'last_extra_cooldown_tic', this.tic_counter);
        }
    }

    // Move the given actor to the given position and perform any appropriate
    // tile interactions.  Does NOT check for whether the move is actually
    // legal; use attempt_step for that!
    move_to(actor, goal_cell) {
        if (actor.cell === goal_cell)
            return;

        if (actor.type.on_starting_move) {
            actor.type.on_starting_move(actor, this);
        }

        let original_cell = actor.cell;
        // Physically remove the actor first, so that it won't get in the way of e.g. a splash
        // spawned from stepping off of a lilypad
        this.remove_tile(actor, true);

        // Announce we're leaving, for the handful of tiles that care about it
        for (let tile of original_cell) {
            if (! tile)
                continue;
            if (tile === actor)
                continue;
            if (actor.ignores(tile.type.name))
                continue;

            // FIXME ah, stepping off a lilypad will add a splash but we're still here?  but then
            // why did the warning not catch it
            if (tile.type.on_depart) {
                tile.type.on_depart(tile, this, actor);
            }
        }

        // Announce we're approaching.  Slide mode is set here, since it's about the tile we're
        // moving towards and needs to last through our next decision
        this.make_slide(actor, null);
        for (let tile of goal_cell) {
            if (! tile)
                continue;
            if (tile === actor)
                continue;
            if (actor.ignores(tile.type.name))
                continue;
            if (actor.slide_ignores(tile.type.name))
                continue;

            // Possibly kill a player
            if (actor.has_item('helmet') || tile.has_item('helmet')) {
                // Helmet disables this, do nothing
            }
            else if (actor.type.is_real_player && tile.type.is_monster) {
                this.kill_actor(actor, tile);
            }
            else if (actor.type.is_monster && tile.type.is_real_player) {
                this.kill_actor(tile, actor);
            }
            else if (actor.type.is_block && tile.type.is_real_player && ! actor.is_pulled) {
                // Note that blocks squish players if they move for ANY reason, even if pushed by
                // another player!  The only exception is being pulled
                this.kill_actor(tile, actor, null, null, 'squished');
            }

            if (tile.type.on_approach) {
                tile.type.on_approach(tile, this, actor);
            }
            if (tile.type.slide_mode) {
                this.make_slide(actor, tile.type.slide_mode);
            }
        }

        // Now add the actor back; we have to wait this long because e.g. monsters erase splashes
        if (goal_cell.get_actor()) {
            // FIXME a monster or block killing the player will still move into her cell!!!  i don't
            // know what to do about this, i feel like i tried making monster/player block each
            // other before and it did not go well.  maybe it was an ordering issue though?
            this.add_tile(actor, original_cell);
            return;
        }
        else {
            this.add_tile(actor, goal_cell);
        }

        // If we're a monster stepping on the player's tail, that also kills her immediately; the
        // player and a monster must be strictly more than 4 tics apart
        // FIXME this only works for the /current/ player but presumably applies to all of them,
        // though i'm having trouble coming up with a test
        // TODO the rules in lynx might be slightly different?
        if (actor.type.is_monster && goal_cell === this.player.previous_cell &&
            // Player has decided to leave their cell, but hasn't actually taken a step yet
            this.player.movement_cooldown === this.player.movement_speed &&
            ! actor.has_item('helmet') && ! this.player.has_item('helmet'))
        {
            this.kill_actor(this.player, actor);
        }

        if (this.compat.tiles_react_instantly) {
            this.step_on_cell(actor, actor.cell);
        }
    }

    // Step on every tile in a cell we just arrived in
    step_on_cell(actor, cell) {
        if (actor.type.on_finishing_move) {
            actor.type.on_finishing_move(actor, this);
        }

        // Step on topmost things first -- notably, it's safe to step on water with flippers on top
        // TODO is there a custom order here similar to collision checking?
        for (let layer = LAYERS.MAX - 1; layer >= 0; layer--) {
            let tile = cell[layer];
            if (! tile)
                continue;
            if (tile === actor)
                continue;
            if (actor.ignores(tile.type.name))
                continue;

            if (tile.type.teleport_dest_order) {
                // This is used by an extra pass just after our caller, so it doesn't need to undo.
                // It DOES need to happen before items, though, or yellow teleporters never work!
                actor.just_stepped_on_teleporter = tile;
            }
            else if (tile.type.item_priority !== undefined) {
                // Possibly try to pick items up
                // TODO maybe this should be a method
                let mod = cell.get_item_mod();
                let try_pickup = (
                    tile.type.item_priority >= actor.type.item_pickup_priority ||
                    (mod && mod.type.item_modifier === 'pickup'));
                if (this.compat.monsters_ignore_keys && tile.type.is_key && actor.type.is_monster) {
                    try_pickup = false;
                }
                if (try_pickup && this.attempt_take(actor, tile)) {
                    if (tile.type.is_key) {
                        this.sfx.play_once('get-key', cell);
                    }
                    else if (tile.type.is_item) {
                        this.sfx.play_once('get-tool', cell);
                    }
                    continue;
                }
            }

            else if (tile.type.on_arrive) {
                tile.type.on_arrive(tile, this, actor);
            }
        }
        
        //can't think of a cleaner implementation - second pass for hidden tiles
        for (let layer = LAYERS.MAX - 1; layer >= 0; layer--) {
            let tile = cell[layer];
            if (! tile)
                continue;
            if (tile === actor)
                continue;
            if (actor.ignores(tile.type.name))
                continue;
                
            if (tile.type.after_arrive) {
                tile.type.after_arrive(tile, this, actor);
            }
        }

        // Play step sound
        if (actor === this.player) {
            let terrain = cell.get_terrain();
            if (actor.slide_mode === 'ice') {
                this.sfx.play_once('slide-ice');
            }
            else if (actor.slide_mode === 'force') {
                this.sfx.play_once('slide-force');
            }
            else if (terrain.type.name === 'popdown_floor') {
                this.sfx.play_once('step-popdown');
            }
            else if (terrain.type.name === 'gravel' || terrain.type.name === 'railroad') {
                this.sfx.play_once('step-gravel');
            }
            else if (terrain.type.name === 'water' || terrain.type.name === 'cloud_water_after') {
                if (actor.ignores(terrain.type.name)) {
                    this.sfx.play_once('step-water');
                }
            }
            else if (terrain.type.name === 'fire') {
                if (actor.has_item('fire_boots')) {
                    this.sfx.play_once('step-fire');
                }
            }
            else if (terrain.type.slide_mode === 'force') {
                this.sfx.play_once('step-force');
            }
            else if (terrain.type.slide_mode === 'ice') {
                this.sfx.play_once('step-ice');
            }
            else {
                this.sfx.play_once('step-floor');
            }
        }
    }

    attempt_teleport(actor) {
        let teleporter = actor.just_stepped_on_teleporter;
        delete actor.just_stepped_on_teleporter;

        // We're about to abruptly move the actor, and the renderer needs to know to interpolate its
        // movement towards the teleporter it just stepped on, not the teleporter it's moved to
        this._set_tile_prop(actor, 'destination_cell', actor.cell);

        if (teleporter.type.name === 'teleport_red' && ! teleporter.is_active) {
            // Curious special-case red teleporter behavior: if you pass through a wired but
            // inactive one, you keep sliding indefinitely.  Players can override out of it, but
            // other actors cannot.  (Normally, a teleport slide ends after one decision phase.)
            // XXX this is useful when the exit is briefly blocked, but it can also get monsters
            // stuck forever  :(
            this.make_slide(actor, 'teleport-forever');
            // Also, there's no sound and whatnot, so everything else is skipped outright.
            return;
        }

        // Explicitly set us as teleport sliding, since in some very obscure cases (auto-dropping a
        // yellow teleporter because you picked up an item with a full inventory and immediately
        // teleporting through it) it may not have been applied
        this.make_slide(actor, 'teleport');

        let original_direction = actor.direction;
        let success = false;
        let dest, direction;
        for ([dest, direction] of teleporter.type.teleport_dest_order(teleporter, this, actor)) {
            // Teleporters already containing an actor are blocked and unusable
            // FIXME should check collision?  otherwise this catches non-blocking vfx...
            if (dest.cell.some(tile => tile && tile.type.is_actor && tile !== actor && ! tile.type.ttl))
                continue;

            // XXX lynx treats this as a slide and does it in a pass in the main loop

            // FIXME bleugh hardcode
            if (dest === teleporter && teleporter.type.name === 'teleport_yellow') {
                break;
            }
            // Note that this uses 'bump' even for players; it would be very bad if we could
            // initiate movement in this pass (in Lexy rules, anyway), because we might try to push
            // something that's still waiting to teleport itself!
            // XXX is this correct?  it does mean you won't try to teleport to a teleporter that's
            // "blocked" by a block that won't be there anyway by the time you try to move, but that
            // seems very obscure and i haven't run into a case with it yet.  offhand i don't think
            // it can even come up under cc2 rules, since teleporting is done after an actor cools
            // down and before the next actor even gets a chance to act
            if (this.check_movement(actor, dest.cell, direction, 'bump')) {
                success = true;
                // Sound plays from the origin cell simply because that's where the sfx player
                // thinks the player is currently; position isn't updated til next turn
                this.sfx.play_once('teleport', teleporter.cell);
                break;
            }
        }

        if (! success) {
            if (teleporter.type.item_priority !== undefined &&
                teleporter.type.item_priority >= actor.type.item_pickup_priority &&
                this.allow_taking_yellow_teleporters)
            {
                // Super duper special yellow teleporter behavior: you pick it the fuck up
                this.make_slide(actor, null);
                this.attempt_take(actor, teleporter);
                if (actor === this.player) {
                    this.sfx.play_once('get-tool', teleporter.cell);
                }
                return;
            }
        }

        this.set_actor_direction(actor, direction);

        this.spawn_animation(actor.cell, 'teleport_flash');
        if (dest.cell !== actor.cell) {
            this.spawn_animation(dest.cell, 'teleport_flash');
        }

        // Now physically move the actor, but their movement waits until next decision phase
        this.remove_tile(actor, true);
        this.add_tile(actor, dest.cell);
    }

    remember_player_move(direction) {
        if (this.player.type.name === 'player') {
            this.player1_move = direction;
            this.player2_move = null;
        }
        else {
            this.player1_move = null;
            this.player2_move = direction;
        }
    }

    cycle_inventory(actor) {
        if (this.stored_level.use_cc1_boots)
            return;
        if (actor.movement_cooldown > 0)
            return;

        // Cycle leftwards, i.e., the oldest item moves to the end of the list
        if (actor.toolbelt && actor.toolbelt.length > 1) {
            actor.toolbelt.push(actor.toolbelt.shift());
            this._push_pending_undo(() => actor.toolbelt.unshift(actor.toolbelt.pop()));
        }
    }

    drop_item(actor) {
        if (this.stored_level.use_cc1_boots)
            return false;
        if (actor.movement_cooldown > 0)
            return false;
        if (! actor.toolbelt || actor.toolbelt.length === 0)
            return false;

        // Drop the oldest item, i.e. the first one
        let name = actor.toolbelt[0];
        if (this._place_dropped_item(name, actor.cell, actor)) {
            actor.toolbelt.shift();
            this._push_pending_undo(() => actor.toolbelt.unshift(name));
            return true;
        }
        return false;
    }

    // Attempt to place an item in the world, as though dropped by an actor
    _place_dropped_item(name, cell, dropping_actor) {
        let type = TILE_TYPES[name];
        if (type.layer === LAYERS.terrain) {
            // Terrain items (i.e., yellow teleports) can only be dropped on regular floor
            let terrain = cell.get_terrain();
            if (terrain.type.name !== 'floor')
                return false;

            this.transmute_tile(terrain, name);
        }
        else {
            // Note that we can't drop a bowling ball if there's already an item, even though a
            // dropped bowling ball is really an actor
            if (cell.get_item())
                return false;

            if (type.on_drop) {
                // FIXME quirky things happen if a dropped bowling ball can't enter the facing cell
                // (mostly it disappears) (also arguably a bug)
                // FIXME does this even need to be a function lol
                name = type.on_drop(this);
                if (name) {
                    type = TILE_TYPES[name];
                }
            }
            let tile = new Tile(type);
            if (type.is_actor) {
                // This is tricky -- the item has become an actor, but whatever dropped it is
                // already in this cell's actor layer.  But we also know for sure that there's no
                // item in this cell, so we'll cheat a little: remove the dropping actor, set the
                // item moving, then put the dropping actor back before anyone notices.
                this.remove_tile(dropping_actor);
                this.add_tile(tile, cell);
                if (! this.attempt_out_of_turn_step(tile, dropping_actor.direction)) {
                    // It was unable to move; if it exploded, we have a special non-blocking VFX for
                    // that, but otherwise there's nothing we can do but erase it (as CC2 does)
                    if (tile.type.name === 'explosion') {
                        this.transmute_tile(tile, 'explosion_nb', true);
                    }
                    else {
                        this.remove_tile(tile);
                    }
                }
                if (tile.cell) {
                    this.add_actor(tile);
                }
                this.add_tile(dropping_actor, cell);
            }
            else {
                this.add_tile(tile, cell);
            }
        }

        return true;
    }

    _do_wire_phase() {
        let force_next_wire_phase = false;
        if (this.recalculate_circuitry_next_wire_phase)
        {
            this.recalculate_circuitry();
            this.recalculate_circuitry_next_wire_phase = false;
            force_next_wire_phase = true;
        }

        if (this.circuits.length === 0)
            return;

        // Prepare a big slab of undo.  The only thing we directly change here (aside from
        // emitting_edges, a normal tile property) is Tile.powered_edges, which tends to change for
        // large numbers of tiles at a time, so store it all in one map and undo it in one shot.
        let powered_edges_changes = new Map;
        let _set_edges = (tile, new_edges) => {
            if (this.undo_enabled) {
                if (powered_edges_changes.has(tile)) {
                    if (powered_edges_changes.get(tile) === new_edges) {
                        powered_edges_changes.delete(tile);
                    }
                }
                else {
                    powered_edges_changes.set(tile, tile.powered_edges);
                }
            }
            tile.powered_edges = new_edges;
        };
        let power_edges = (tile, edges) => {
            let new_edges = tile.powered_edges | edges;
            _set_edges(tile, new_edges);
        };
        let depower_edges = (tile, edges) => {
            let new_edges = tile.powered_edges & ~edges;
            _set_edges(tile, new_edges);
        };

        // Update the state of any tiles that can generate power.  If none of them changed since
        // last wiring update, stop here.  First, static power sources.
        let any_changed = false;
        for (let tile of this.power_sources) {
            if (! tile.cell)
                continue;
            let emitting = 0;
            if (tile.type.get_emitting_edges) {
                // This method may not exist any more, if the tile was destroyed by e.g. dynamite
                emitting = tile.type.get_emitting_edges(tile, this);
            }
            if (emitting !== tile.emitting_edges) {
                any_changed = true;
                this._set_tile_prop(tile, 'emitting_edges', emitting);
            }
        }
        // Next, actors who are standing still, on floor/electrified, and holding a lightning bolt
        let externally_powered_circuits = new Set;
        for (let actor of this.actors) {
            if (! actor.cell)
                continue;
            let emitting = 0;
            if (actor.movement_cooldown === 0 && actor.has_item('lightning_bolt')) {
                let wired_tile = actor.cell.get_wired_tile();
                if (wired_tile && (wired_tile === actor || wired_tile.type.name === 'floor' || wired_tile.type.name === 'electrified_floor')) {
                    emitting = wired_tile.wire_directions;
                    for (let circuit of wired_tile.circuits) {
                        if (circuit) {
                            externally_powered_circuits.add(circuit);
                        }
                    }
                }
            }
            if (emitting !== actor.emitting_edges) {
                any_changed = true;
                this._set_tile_prop(actor, 'emitting_edges', emitting);
            }
        }

        if (! any_changed && !force_next_wire_phase) {
            return;
        }

        for (let tile of this.wired_outputs) {
            // This is only used within this function, no need to undo
            // TODO if this can overlap with power_sources then this is too late?
            tile._prev_powered_edges = tile.powered_edges;
        }

        // Now go through every circuit, compute whether it's powered, and if that changed, inform
        // its outputs
        let circuit_changes = new Map;
        for (let circuit of this.circuits) {
            let is_powered = false;

            if (externally_powered_circuits.has(circuit)) {
                is_powered = true;
            }
            else {
                for (let [input_tile, edges] of circuit.inputs.entries()) {
                    if (input_tile.emitting_edges & edges) {
                        is_powered = true;
                        break;
                    }
                }
            }

            let was_powered = circuit.is_powered;
            if (is_powered === was_powered)
                continue;

            circuit.is_powered = is_powered;
            if (this.undo_enabled) {
                circuit_changes.set(circuit, was_powered);
            }

            for (let [tile, edges] of circuit.tiles.entries()) {
                if (is_powered) {
                    power_edges(tile, edges);
                }
                else {
                    depower_edges(tile, edges);
                }
            }
        }

        for (let tile of this.wired_outputs) {
            if (tile.powered_edges && ! tile._prev_powered_edges && tile.type.on_power) {
                tile.type.on_power(tile, this);
            }
            else if (! tile.powered_edges && tile._prev_powered_edges && tile.type.on_depower) {
                tile.type.on_depower(tile, this);
            }
        }

        this._push_pending_undo(() => {
            for (let [tile, edges] of powered_edges_changes.entries()) {
                tile.powered_edges = edges;
            }
            for (let [circuit, is_powered] of circuit_changes.entries()) {
                circuit.is_powered = is_powered;
            }
        });
    }

    // -------------------------------------------------------------------------
    // Board inspection

    get_neighboring_cell(cell, direction) {
        let move = DIRECTIONS[direction].movement;
        let goal_x = cell.x + move[0];
        let goal_y = cell.y + move[1];
        return this.cell(cell.x + move[0], cell.y + move[1]);
    }

    // Iterates over the grid in (reverse?) reading order and yields all tiles with the given name.
    // The starting cell is iterated last.
    *iter_tiles_in_reading_order(start_cell, name, reverse = false) {
        let i = this.coords_to_scalar(start_cell.x, start_cell.y);
        let index = TILE_TYPES[name].layer;
        while (true) {
            if (reverse) {
                i -= 1;
                if (i < 0) {
                    i += this.size_x * this.size_y;
                }
            }
            else {
                i += 1;
                i %= this.size_x * this.size_y;
            }

            let cell = this.linear_cells[i];
            let tile = cell[index];
            if (tile && tile.type.name === name) {
                yield tile;
            }

            if (cell === start_cell)
                return;
        }
    }

    //same as above, but accepts multiple tiles
    *iter_tiles_in_reading_order_multiple(start_cell, names, reverse = false) {
        let i = this.coords_to_scalar(start_cell.x, start_cell.y);
        let index = TILE_TYPES[names[0]].layer;
        while (true) {
            if (reverse) {
                i -= 1;
                if (i < 0) {
                    i += this.size_x * this.size_y;
                }
            }
            else {
                i += 1;
                i %= this.size_x * this.size_y;
            }

            let cell = this.linear_cells[i];
            let tile = cell[index];
            if (tile && names.indexOf(tile.type.name) >= 0) {
                yield tile;
            }

            if (cell === start_cell)
                return;
        }
    }

    // Iterates over the grid in a diamond pattern, spreading out from the given start cell (but not
    // including it).  Only used for connecting orange buttons.
    *iter_cells_in_diamond(start_cell) {
        let max_search_radius = Math.max(this.size_x, this.size_y) + 1;
        for (let dist = 1; dist <= max_search_radius; dist++) {
            // Start east and move counterclockwise
            let sx = start_cell.x + dist;
            let sy = start_cell.y;
            for (let direction of [[-1, -1], [-1, 1], [1, 1], [1, -1]]) {
                for (let i = 0; i < dist; i++) {
                    let cell = this.cell(sx, sy);
                    if (cell) {
                        yield cell;
                    }
                    sx += direction[0];
                    sy += direction[1];
                }
            }
        }
    }

    // FIXME require_stub should really just care whether we ourselves /can/ contain wire, and also
    // we should check that on our neighbor
    is_tile_wired(tile, require_stub = true) {
        for (let [direction, dirinfo] of Object.entries(DIRECTIONS)) {
            if (require_stub && (tile.wire_directions & dirinfo.bit) === 0)
                continue;

            let neighbor = this.get_neighboring_cell(tile.cell, direction);
            if (! neighbor)
                continue;

            let terrain = neighbor.get_terrain();
            if (terrain.type.name === 'logic_gate' &&
                terrain.type.get_wires(terrain).includes(dirinfo.opposite))
            {
                return true;
            }

            let wired = neighbor.get_wired_tile();
            if (! wired)
                continue;

            if (wired.type.wire_propagation_mode === 'none' && ! wired.type.is_power_source)
                // Being next to e.g. a red teleporter doesn't count (but pink button is ok)
                continue;

            if ((wired.wire_directions & dirinfo.opposite_bit) &&
                ! (wired.wire_tunnel_directions & dirinfo.opposite_bit))
            {
                return true;
            }
        }
        return false;
    }

    // -------------------------------------------------------------------------
    // Undo handling

    create_undo_entry() {
        let entry = [];
        entry.tile_changes = new Map;
        entry.level_props = {};
        return entry;
    }

    has_undo() {
        let prev_index = this.undo_buffer_index - 1;
        if (prev_index < 0) {
            prev_index += UNDO_BUFFER_SIZE;
        }

        return this.undo_buffer[prev_index] !== null;
    }

    commit() {
        if (! this.undo_enabled) {
            return;
        }
        this.undo_buffer[this.undo_buffer_index] = this.pending_undo;
        this.pending_undo = this.create_undo_entry();

        this.undo_buffer_index += 1;
        this.undo_buffer_index %= UNDO_BUFFER_SIZE;
    }

    undo() {
        this.aid = Math.max(1, this.aid);

        // In turn-based mode, we might still be in mid-tic with a partial undo stack; do that first
        this._undo_entry(this.pending_undo);
        this.pending_undo = this.create_undo_entry();

        this.undo_buffer_index -= 1;
        if (this.undo_buffer_index < 0) {
            this.undo_buffer_index += UNDO_BUFFER_SIZE;
        }
        this._undo_entry(this.undo_buffer[this.undo_buffer_index]);
        this.undo_buffer[this.undo_buffer_index] = null;

        if (this.undid_past_recalculate_circuitry) {
            this.recalculate_circuitry_next_wire_phase = true;
            this.undid_past_recalculate_circuitry = false;
        }
    }

    // Reverse a single undo entry
    _undo_entry(entry) {
        if (! entry) {
            return;
        }

        // Undo in reverse order!  There's no redo, so it's okay to destroy this
        entry.reverse();
        for (let undo of entry) {
            undo();
        }
        for (let [tile, changes] of entry.tile_changes) {
            for (let [key, value] of changes) {
                tile[key] = value;
            }
        }
        for (let [key, value] of Object.entries(entry.level_props)) {
            this[key] = value;
        }
    }

    _push_pending_undo(thunk) {
        if (this.undo_enabled) {
            this.pending_undo.push(thunk)
        }
    }

    // -------------------------------------------------------------------------
    // Level alteration methods.  EVERYTHING that changes the state of a level,
    // including the state of a single tile, should do it through one of these
    // for undo/rewind purposes

    _set_tile_prop(tile, key, val) {
        if (Number.isNaN(val)) throw new Error(`got a NaN for ${key} on ${tile.type.name} at ${tile.cell.x}, ${tile.cell.y}`);
        if (! this.undo_enabled) {
            tile[key] = val;
            return;
        }
        if (tile[key] === val)
            return;

        let changes = this.pending_undo.tile_changes.get(tile);
        if (! changes) {
            changes = new Map;
            this.pending_undo.tile_changes.set(tile, changes);
        }

        // If we haven't yet done so, log the original value
        if (! changes.has(key)) {
            changes.set(key, tile[key]);
        }
        // If there's an original value already logged, and it's the value we're about to change
        // back to, then delete the change
        else if (changes.get(key) === val) {
            changes.delete(key);
        }

        tile[key] = val;
    }

    collect_chip() {
        if (this.chips_remaining > 0) {
            if (this.chips_remaining > 1) {
                this.sfx.play_once('get-chip');
            }
            else {
                this.sfx.play_once('get-chip-last');
            }
            this.chips_remaining--;
        }
        else {
            this.sfx.play_once('get-chip-extra');
        }
    }

    adjust_bonus(add, mult = 1) {
        this.bonus_points = Math.floor(this.bonus_points * mult) + add;
    }

    pause_timer() {
        if (this.time_remaining === null)
            return;

        this.timer_paused = ! this.timer_paused;
    }

    adjust_timer(dt) {
        // Untimed levels become timed levels with 0 seconds remaining
        this.time_remaining = Math.max(0, (this.time_remaining ?? 0) + dt * 20);
        if (this.time_remaining <= 0) {
            // If the timer isn't paused, this will kill the player at the end of the tic
            this.time_remaining = 1;
        }
    }

    kill_actor(actor, killer, animation_name = null, sfx = null, fail_reason = null) {
        if (actor.type.is_real_player) {
            // Resurrect using the ankh tile, if possible
            if (this.ankh_tile) {
                let ankh_cell = this.ankh_tile.cell;
                let existing_actor = ankh_cell.get_actor();
                if (! existing_actor) {
                    // FIXME water should still splash, etc
                    this.sfx.play_once('revive');

                    this._set_tile_prop(actor, 'movement_cooldown', null);
                    this._set_tile_prop(actor, 'movement_speed', null);
                    this.make_slide(actor, null);
                    this.move_to(actor, ankh_cell);

                    this.transmute_tile(this.ankh_tile, 'floor');
                    this.spawn_animation(ankh_cell, 'resurrection');
                    let old_tile = this.ankh_tile;
                    this.ankh_tile = null;
                    this._push_pending_undo(() => {
                        this.ankh_tile = old_tile;
                    });
                    return;
                }
            }

            // Otherwise, lose the game
            this.fail(fail_reason || killer.type.name, null, actor);
            return;
        }

        if (actor.type.on_death) {
            actor.type.on_death(actor, this);
        }

        if (sfx) {
            this.sfx.play_once(sfx, actor.cell);
        }
        if (animation_name) {
            this.transmute_tile(actor, animation_name);
        }
        else {
            this.remove_tile(actor);
        }
    }

    fail(reason, killer = null, player = null) {
        if (this.state !== 'playing')
            return;

        if (player === null) {
            player = this.player;
        }

        if (reason === 'time') {
            this.sfx.play_once('timeup');
        }
        else {
            this.sfx.play_once('lose');
        }

        this._push_pending_undo(() => {
            this.fail_reason = null;
            if (player != null) { player.fail_reason = null; }
        });
        this.state = 'failure';
        this.fail_reason = reason;
        if (player != null) { player.fail_reason = reason; }
    }

    win() {
        if (this.state !== 'playing')
            return;

        this.sfx.play_once('win');
        this.state = 'success';
        this._set_tile_prop(this.player, 'exited', true);
    }

    get_scorecard() {
        if (this.state !== 'success') {
            return null;
        }

        // FIXME should probably remember tics here, not just seconds?
        let time = Math.ceil((this.time_remaining ?? 0) / TICS_PER_SECOND);
        return {
            time: time,
            abstime: this.tic_counter,
            bonus: this.bonus_points,
            score: this.stored_level.number * 500 + time * 10 + this.bonus_points,
            aid: this.aid,
        };
    }

    // Get the next direction a random force floor will use.  They share global
    // state and cycle clockwise.
    get_force_floor_direction() {
        if (this.compat.rff_actually_random) {
            return DIRECTION_ORDER[this.prng() % 4];
        }

        let d = this.force_floor_direction;
        this.force_floor_direction = DIRECTIONS[d].right;
        return d;
    }

    // Tile stuff in particular
    // TODO should add in the right layer?  maybe?  hard to say what that is when mscc levels might
    // have things stacked in a weird order though
    // TODO would be nice to make these not be closures but order matters much more here

    remove_tile(tile) {
        let cell = tile.cell;
        cell._remove(tile);
        this._push_pending_undo(() => cell._add(tile));
    }

    add_tile(tile, cell) {
        cell._add(tile);
        this._push_pending_undo(() => cell._remove(tile));
    }

    add_actor(actor) {
        if (this.compat.reuse_actor_slots && actor.type.layer !== LAYERS.vfx) {
            // Place the new actor in the first slot taken up by a nonexistent one, but not VFX
            // which aren't supposed to impact gameplay
            for (let i = 0, l = this.actors.length; i < l; i++) {
                let old_actor = this.actors[i];
                if (old_actor !== this.player && ! old_actor.cell) {
                    this.actors[i] = actor;
                    this._push_pending_undo(() => this.actors[i] = old_actor);
                    return;
                }
            }
        }

        this.actors.push(actor);
        this._push_pending_undo(() => this.actors.pop());
    }

    _init_animation(tile) {
        // Co-opt movement_cooldown/speed for these despite that they aren't moving, since those
        // properties are also used to animate everything else anyway.  Decrement the cooldown
        // immediately, as Lynx does; note that Lynx also ticks /and destroys/ animations early in
        // the decision phase, but this seems to work out just as well
        let duration = tile.type.ttl;
        if (this.compat.force_lynx_animation_lengths) {
            // Lynx animation duration is 12 tics, but it drops one if necessary to make the
            // animation end on an odd tic (???) and that takes step parity into account
            // because I guess it uses the global clock (?????????????????).  Also, unlike CC2, Lynx
            // animations are removed once their cooldown goes BELOW zero, so to simulate that we
            // make the animation one tic longer.
            // XXX wait am i sure that cc2 doesn't work that way too?
            duration = (12 + (this.tic_counter + this.step_parity) % 2) * 3;
        }
        this._set_tile_prop(tile, 'movement_speed', duration);
        this._set_tile_prop(tile, 'movement_cooldown', duration);
        this._do_extra_cooldown(tile);
    }

    spawn_animation(cell, name) {
        let type = TILE_TYPES[name];
        // Spawned VFX silently erase any existing VFX
        if (type.layer === LAYERS.vfx) {
            let vfx = cell[type.layer];
            if (vfx) {
                this.remove_tile(vfx);
            }
        }
        let tile = new Tile(type);
        this._init_animation(tile);
        this.add_tile(tile, cell);
        this.add_actor(tile);
    }

    transmute_tile(tile, name, force = false) {
        if (tile.type.ttl && ! force) {
            // If this is already an animation, don't turn it into a different one; this can happen
            // if a block is pushed onto a cell containing both a mine and slime, both of which try
            // to destroy it
            return;
        }

        let old_type = tile.type;
        if (old_type.on_death) {
            old_type.on_death(tile, this);
            //might have been destroyed by that
            if (tile.cell == null) {
                return;
            }
        }
        let new_type = TILE_TYPES[name];
        if (old_type.layer !== new_type.layer) {
            // Move it to the right layer!
            let cell = tile.cell;
            cell._remove(tile);
            tile.type = new_type;
            cell._add(tile);
            this._push_pending_undo(() => {
                cell._remove(tile);
                tile.type = old_type;
                cell._add(tile);
            });
        }
        else {
            tile.type = new_type;
            this._push_pending_undo(() => tile.type = old_type);
        }

        // For transmuting into an animation, set up the timer immediately
        if (tile.type.ttl) {
            if (! old_type.is_actor) {
                console.warn("Transmuting a non-actor into an animation!");
            }
            // This is effectively a completely new object, so remove double cooldown prevention;
            // the initial cooldown MUST happen, because the renderer can't handle cooldown == speed
            if (tile.last_extra_cooldown_tic) {
                this._set_tile_prop(tile, 'last_extra_cooldown_tic', null);
            }
            this._init_animation(tile);
            this._set_tile_prop(tile, 'previous_cell', null);
            this.make_slide(tile, null);
        }
    }

    // Have an actor try to pick up a particular tile; it's prevented if there's a no sign, and the
    // tile is removed if successful
    // FIXME do not allow overflow dropping before picking up the new item
    attempt_take(actor, tile) {
        let cell = tile.cell;
        let mod = cell.get_item_mod();
        if (mod && mod.type.item_modifier === 'ignore')
            return false;

        // Some faux items have custom pickup behavior, e.g. chips and bonuses
        if (tile.type.on_pickup) {
            if (tile.type.on_pickup(tile, this, actor)) {
                this.remove_tile(tile);
                return true;
            }
            else {
                return false;
            }
        }

        // Handling a full inventory is a teeny bit complicated.  We want the following:
        // - At no point are two items in the same cell
        // - A yellow teleporter cannot be dropped in exchange for another yellow teleporter
        // - If the oldest item can't be dropped, the pickup fails
        // Thus we have to check whether dropping is possible FIRST, but only place the dropped item
        // AFTER the pickup.
        let dropped_item;
        if (! tile.type.is_key && ! this.stored_level.use_cc1_boots &&
            actor.toolbelt && actor.toolbelt.length >= 4)
        {
            let oldest_item_type = TILE_TYPES[actor.toolbelt[0]];
            if (oldest_item_type.layer === LAYERS.terrain && cell.get_terrain().type.name !== 'floor') {
                // This is a yellow teleporter, and we are not standing on floor; abort!
                return false;
            }
            // Otherwise, it's either an item or a yellow teleporter we're allowed to drop, so steal
            // it out of their inventory to be dropped later
            dropped_item = actor.toolbelt.shift();
            this._push_pending_undo(() => actor.toolbelt.unshift(dropped_item));
        }

        if (this.give_actor(actor, tile.type.name)) {
            if (tile.type.layer === LAYERS.terrain) {
                // This should only happen for the yellow teleporter
                this.transmute_tile(tile, 'floor');
            }
            else {
                this.remove_tile(tile);
            }
            if (mod && mod.type.item_modifier === 'pickup') {
                this.remove_tile(mod);
            }

            // Drop any overflowed item
            if (dropped_item) {
                // TODO what if this fails??
                this._place_dropped_item(dropped_item, cell, actor);
            }

            return true;
        }
        // TODO what happens to the dropped item if the give fails somehow?
        return false;
    }

    // Give an item to an actor, even if it's not supposed to have an inventory
    give_actor(actor, name) {
        if (! actor.type.is_actor)
            return false;

        let type = TILE_TYPES[name];
        if (type.is_key) {
            if (! actor.keyring) {
                actor.keyring = {};
            }
            actor.keyring[name] = (actor.keyring[name] ?? 0) + 1;
            this._push_pending_undo(() => actor.keyring[name] -= 1);
        }
        else {
            // tool, presumably
            if (! actor.toolbelt) {
                actor.toolbelt = [];
            }

            if (this.stored_level.use_cc1_boots) {
                // CC1's boot inventory is different; it has fixed slots, and duplicate items are
                // silently ignored.  CC2 items cannot be picked up.
                let i = CC1_INVENTORY_ORDER.indexOf(name);
                if (i < 0)
                    return false;

                if (! actor.toolbelt[i]) {
                    this._push_pending_undo(() => actor.toolbelt[i] = null);
                }
                actor.toolbelt[i] = name;
            }
            else {
                // "Normal" (CC2) inventory mode.
                // Nothing can hold more than four items, so try to drop one first.  Note that
                // normally, this should already have happened in attempt_take, so this should only
                // come up when forcibly given an item via debug tools
                if (actor.toolbelt.length >= 4) {
                    if (! this.drop_item(actor))
                        return false;
                }

                actor.toolbelt.push(name);
                this._push_pending_undo(() => actor.toolbelt.pop());
            }

            // FIXME hardcodey, but, this doesn't seem to fit anywhere else
            if (name === 'cleats' && actor.slide_mode === 'ice') {
                this.make_slide(actor, null);
            }
            else if (name === 'suction_boots' && actor.slide_mode === 'force') {
                this.make_slide(actor, null);
            }
        }
        return true;
    }

    take_key_from_actor(actor, name, ignore_infinity = false) {
        if (actor.keyring && (actor.keyring[name] ?? 0) > 0) {
            if (!ignore_infinity && actor.type.infinite_items && actor.type.infinite_items[name]) {
                // Some items can't be taken away normally, by which I mean, green or yellow keys
                return true;
            }

            this._push_pending_undo(() => actor.keyring[name] += 1);
            actor.keyring[name] -= 1;
            return true;
        }

        return false;
    }

    // Note that this doesn't support CC1 mode, but only CC2 and LL tools are individually taken
    take_tool_from_actor(actor, name) {
        if (actor.toolbelt) {
            let index = actor.toolbelt.indexOf(name);
            if (index >= 0) {
                actor.toolbelt.splice(index, 1);
                this._push_pending_undo(() => actor.toolbelt.splice(index, 0, name));
                return true;
            }
        }

        return false;
    }

    take_all_keys_from_actor(actor) {
        if (actor.keyring && Object.values(actor.keyring).some(n => n > 0)) {
            let keyring = actor.keyring;
            this._push_pending_undo(() => actor.keyring = keyring);
            actor.keyring = {};
            return true;
        }
    }

    take_all_tools_from_actor(actor) {
        if (actor.toolbelt && actor.toolbelt.length > 0) {
            let toolbelt = actor.toolbelt;
            this._push_pending_undo(() => actor.toolbelt = toolbelt);
            actor.toolbelt = [];
            return true;
        }
    }

    // Mark an actor as sliding
    make_slide(actor, mode) {
        this._set_tile_prop(actor, 'slide_mode', mode);
    }

    // Change an actor's direction
    set_actor_direction(actor, direction) {
        this._set_tile_prop(actor, 'direction', direction);
    }
}
