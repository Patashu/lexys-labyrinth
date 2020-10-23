import { DIRECTIONS } from './defs.js';
import { random_choice } from './util.js';

// Draw layers
const LAYER_TERRAIN = 0;
const LAYER_ITEM = 1;
const LAYER_NO_SIGN = 2;
const LAYER_ACTOR = 3;
const LAYER_OVERLAY = 4;
// TODO cc2 order is: swivel, thinwalls, canopy (and yes you can have them all in the same tile)

function player_visual_state(me) {
    if (! me) {
        return 'normal';
    }

    if (me.fail_reason === 'drowned') {
        return 'drowned';
    }
    else if (me.fail_reason === 'burned') {
        return 'burned';
    }
    else if (me.fail_reason === 'exploded') {
        return 'exploded';
    }
    else if (me.fail_reason) {
        return 'failed';
    }
    else if (me.cell && (me.previous_cell || me.cell).some(t => t.type.name === 'water')) {
        // CC2 shows a swimming pose while still in water, or moving away from water
        return 'swimming';
    }
    else if (me.slide_mode === 'ice') {
        return 'skating';
    }
    else if (me.slide_mode === 'force') {
        return 'forced';
    }
    else if (me.is_blocked) {
        return 'blocked';
    }
    else if (me.is_pushing) {
        return 'pushing';
    }
    else if (me.animation_speed) {
        return 'moving';
    }
    else {
        return 'normal';
    }
}

const TILE_TYPES = {
    // Floors and walls
    floor: {
        draw_layer: LAYER_TERRAIN,
    },
    floor_letter: {
        draw_layer: LAYER_TERRAIN,
    },
    floor_custom_green: {
        draw_layer: LAYER_TERRAIN,
    },
    floor_custom_pink: {
        draw_layer: LAYER_TERRAIN,
    },
    floor_custom_yellow: {
        draw_layer: LAYER_TERRAIN,
    },
    floor_custom_blue: {
        draw_layer: LAYER_TERRAIN,
    },
    wall: {
        draw_layer: LAYER_TERRAIN,
        blocks_all: true,
    },
    wall_custom_green: {
        draw_layer: LAYER_TERRAIN,
        blocks_all: true,
    },
    wall_custom_pink: {
        draw_layer: LAYER_TERRAIN,
        blocks_all: true,
    },
    wall_custom_yellow: {
        draw_layer: LAYER_TERRAIN,
        blocks_all: true,
    },
    wall_custom_blue: {
        draw_layer: LAYER_TERRAIN,
        blocks_all: true,
    },
    wall_invisible: {
        draw_layer: LAYER_TERRAIN,
        // FIXME cc2 seems to make these flicker briefly
        blocks_all: true,
    },
    wall_appearing: {
        draw_layer: LAYER_TERRAIN,
        blocks_all: true,
        on_bump(me, level, other) {
            if (other.type.can_reveal_walls) {
                level.transmute_tile(me, 'wall');
            }
        },
    },
    popwall: {
        draw_layer: LAYER_TERRAIN,
        blocks_monsters: true,
        blocks_blocks: true,
        on_ready(me, level) {
            if (level.compat.auto_convert_ccl_popwalls &&
                me.cell.some(tile => tile.type.is_actor))
            {
                // Fix blocks and other actors on top of popwalls by turning them into double
                // popwalls, which preserves CC2 popwall behavior
                me.type = TILE_TYPES['popwall2'];
            }
        },
        on_depart(me, level, other) {
            level.transmute_tile(me, 'wall');
        },
    },
    // LL specific tile that can only be stepped on /twice/, originally used to repair differences
    // with popwall behavior between Lynx and Steam
    popwall2: {
        draw_layer: LAYER_TERRAIN,
        blocks_monsters: true,
        blocks_blocks: true,
        on_depart(me, level, other) {
            level.transmute_tile(me, 'popwall');
        },
    },
    // FIXME in a cc1 tileset, these tiles are opaque  >:S
    thinwall_n: {
        draw_layer: LAYER_OVERLAY,
        thin_walls: new Set(['north']),
    },
    thinwall_s: {
        draw_layer: LAYER_OVERLAY,
        thin_walls: new Set(['south']),
    },
    thinwall_e: {
        draw_layer: LAYER_OVERLAY,
        thin_walls: new Set(['east']),
    },
    thinwall_w: {
        draw_layer: LAYER_OVERLAY,
        thin_walls: new Set(['west']),
    },
    thinwall_se: {
        draw_layer: LAYER_OVERLAY,
        thin_walls: new Set(['south', 'east']),
    },
    fake_wall: {
        draw_layer: LAYER_TERRAIN,
        blocks_all: true,
        on_ready(me, level) {
            if (level.compat.auto_convert_ccl_blue_walls &&
                me.cell.some(tile => tile.type.is_actor))
            {
                // Blocks can be pushed off of blue walls in TW Lynx, which only works due to a tiny
                // quirk of the engine that I don't want to replicate, so replace them with popwalls
                me.type = TILE_TYPES['popwall'];
            }
        },
        on_bump(me, level, other) {
            if (other.type.can_reveal_walls) {
                level.transmute_tile(me, 'wall');
            }
        },
    },
    fake_floor: {
        draw_layer: LAYER_TERRAIN,
        blocks_monsters: true,
        blocks_blocks: true,
        on_bump(me, level, other) {
            if (other.type.can_reveal_walls) {
                level.transmute_tile(me, 'floor');
            }
        },
    },
    popdown_wall: {
        draw_layer: LAYER_TERRAIN,
        blocks_all: true,
    },
    popdown_floor: {
        draw_layer: LAYER_TERRAIN,
        blocks_blocks: true,
        // FIXME should be on_approach
        on_arrive(me, level, other) {
            // FIXME could probably do this with state?  or, eh
            level.transmute_tile(me, 'popdown_floor_visible');
        },
    },
    popdown_floor_visible: {
        draw_layer: LAYER_TERRAIN,
        blocks_blocks: true,
        on_depart(me, level, other) {
            // FIXME possibly changes back too fast, not even visible for a tic for me (much like stepping on a button oops)
            level.transmute_tile(me, 'popdown_floor');
        },
    },
    // TODO these also block the corresponding mirror actors
    no_player1_sign: {
        draw_layer: LAYER_TERRAIN,
        blocks(me, level, other) {
            return (other.type.name === 'player');
        },
    },
    no_player2_sign: {
        draw_layer: LAYER_TERRAIN,
        blocks(me, level, other) {
            return (other.type.name === 'player2');
        },
    },
    steel: {
        draw_layer: LAYER_TERRAIN,
        blocks_all: true,
    },
    canopy: {
        draw_layer: LAYER_OVERLAY,
    },

    // Swivel doors
    swivel_floor: {
        draw_layer: LAYER_TERRAIN,
    },
    swivel_ne: {
        draw_layer: LAYER_OVERLAY,
        thin_walls: new Set(['north', 'east']),
        is_swivel: true,
        on_depart(me, level, other) {
            if (other.direction === 'north') {
                level.transmute_tile(me, 'swivel_se');
            }
            else if (other.direction === 'east') {
                level.transmute_tile(me, 'swivel_nw');
            }
        },
    },
    swivel_se: {
        draw_layer: LAYER_OVERLAY,
        thin_walls: new Set(['south', 'east']),
        is_swivel: true,
        on_depart(me, level, other) {
            if (other.direction === 'south') {
                level.transmute_tile(me, 'swivel_ne');
            }
            else if (other.direction === 'east') {
                level.transmute_tile(me, 'swivel_sw');
            }
        },
    },
    swivel_sw: {
        draw_layer: LAYER_OVERLAY,
        thin_walls: new Set(['south', 'west']),
        is_swivel: true,
        on_depart(me, level, other) {
            if (other.direction === 'south') {
                level.transmute_tile(me, 'swivel_nw');
            }
            else if (other.direction === 'west') {
                level.transmute_tile(me, 'swivel_se');
            }
        },
    },
    swivel_nw: {
        draw_layer: LAYER_OVERLAY,
        thin_walls: new Set(['north', 'west']),
        is_swivel: true,
        on_depart(me, level, other) {
            if (other.direction === 'north') {
                level.transmute_tile(me, 'swivel_sw');
            }
            else if (other.direction === 'west') {
                level.transmute_tile(me, 'swivel_ne');
            }
        },
    },

    // Railroad
    railroad: {
        draw_layer: LAYER_TERRAIN,
        // TODO a lot!!
    },

    // Locked doors
    door_red: {
        draw_layer: LAYER_TERRAIN,
        blocks(me, level, other) {
            // TODO not quite sure if this one is right; there are complex interactions with monsters, e.g. most monsters can eat blue keys but can't actually use them
            return ! (other.type.has_inventory && other.has_item('key_red'));
        },
        on_arrive(me, level, other) {
            if (level.take_key_from_actor(other, 'key_red')) {
                level.sfx.play_once('door', me.cell);
                level.transmute_tile(me, 'floor');
            }
        },
    },
    door_blue: {
        draw_layer: LAYER_TERRAIN,
        blocks(me, level, other) {
            return ! (other.type.has_inventory && other.has_item('key_blue'));
        },
        on_arrive(me, level, other) {
            if (level.take_key_from_actor(other, 'key_blue')) {
                level.sfx.play_once('door', me.cell);
                level.transmute_tile(me, 'floor');
            }
        },
    },
    door_yellow: {
        draw_layer: LAYER_TERRAIN,
        blocks(me, level, other) {
            return ! (other.type.has_inventory && other.has_item('key_yellow'));
        },
        on_arrive(me, level, other) {
            if (level.take_key_from_actor(other, 'key_yellow')) {
                level.sfx.play_once('door', me.cell);
                level.transmute_tile(me, 'floor');
            }
        },
    },
    door_green: {
        draw_layer: LAYER_TERRAIN,
        blocks(me, level, other) {
            return ! (other.type.has_inventory && other.has_item('key_green'));
        },
        on_arrive(me, level, other) {
            if (level.take_key_from_actor(other, 'key_green')) {
                level.sfx.play_once('door', me.cell);
                level.transmute_tile(me, 'floor');
            }
        },
    },

    // Terrain
    dirt: {
        draw_layer: LAYER_TERRAIN,
        blocks_monsters: true,
        blocks_blocks: true,
        blocks(me, level, other) {
            return (other.type.name === 'player2' && ! other.has_item('hiking_boots'));
        },
        on_arrive(me, level, other) {
            level.transmute_tile(me, 'floor');
        },
    },
    gravel: {
        draw_layer: LAYER_TERRAIN,
        blocks_monsters: true,
        blocks(me, level, other) {
            return (other.type.name === 'player2' && ! other.has_item('hiking_boots'));
        },
    },

    // Hazards
    fire: {
        draw_layer: LAYER_TERRAIN,
        blocks(me, level, other) {
            return (other.type.is_monster && other.type.name !== 'fireball');
        },
        on_arrive(me, level, other) {
            if (other.type.name === 'ice_block') {
                level.remove_tile(other);
                level.transmute_tile(me, 'water');
            }
            else if (other.type.is_player) {
                level.fail('burned');
            }
            else {
                level.remove_tile(other);
            }
        },
    },
    water: {
        draw_layer: LAYER_TERRAIN,
        on_arrive(me, level, other) {
            // TODO cc1 allows items under water, i think; water was on the upper layer
            level.sfx.play_once('splash', me.cell);
            if (other.type.name === 'dirt_block') {
                level.transmute_tile(other, 'splash');
                level.transmute_tile(me, 'dirt');
            }
            else if (other.type.name === 'ice_block') {
                level.transmute_tile(other, 'splash');
                level.transmute_tile(me, 'ice');
            }
            else if (other.type.is_player) {
                level.fail('drowned');
            }
            else {
                level.transmute_tile(other, 'splash');
            }
        },
    },
    turtle: {
        draw_layer: LAYER_TERRAIN,
        on_depart(me, level, other) {
            level.transmute_tile(me, 'water');
            // TODO feels like we should spawn water underneath us, then transmute ourselves into the splash?
            level.spawn_animation(me.cell, 'splash');
        },
    },
    ice: {
        draw_layer: LAYER_TERRAIN,
        slide_mode: 'ice',
    },
    ice_sw: {
        draw_layer: LAYER_TERRAIN,
        thin_walls: new Set(['south', 'west']),
        slide_mode: 'ice',
        on_arrive(me, level, other) {
            if (other.direction === 'south') {
                level.set_actor_direction(other, 'east');
            }
            else {
                level.set_actor_direction(other, 'north');
            }
        },
    },
    ice_nw: {
        draw_layer: LAYER_TERRAIN,
        thin_walls: new Set(['north', 'west']),
        slide_mode: 'ice',
        on_arrive(me, level, other) {
            if (other.direction === 'north') {
                level.set_actor_direction(other, 'east');
            }
            else {
                level.set_actor_direction(other, 'south');
            }
        },
    },
    ice_ne: {
        draw_layer: LAYER_TERRAIN,
        thin_walls: new Set(['north', 'east']),
        slide_mode: 'ice',
        on_arrive(me, level, other) {
            if (other.direction === 'north') {
                level.set_actor_direction(other, 'west');
            }
            else {
                level.set_actor_direction(other, 'south');
            }
        },
    },
    ice_se: {
        draw_layer: LAYER_TERRAIN,
        thin_walls: new Set(['south', 'east']),
        slide_mode: 'ice',
        on_arrive(me, level, other) {
            if (other.direction === 'south') {
                level.set_actor_direction(other, 'west');
            }
            else {
                level.set_actor_direction(other, 'north');
            }
        },
    },
    force_floor_n: {
        draw_layer: LAYER_TERRAIN,
        slide_mode: 'force',
        on_arrive(me, level, other) {
            level.set_actor_direction(other, 'north');
        },
    },
    force_floor_e: {
        draw_layer: LAYER_TERRAIN,
        slide_mode: 'force',
        on_arrive(me, level, other) {
            level.set_actor_direction(other, 'east');
        },
    },
    force_floor_s: {
        draw_layer: LAYER_TERRAIN,
        slide_mode: 'force',
        on_arrive(me, level, other) {
            level.set_actor_direction(other, 'south');
        },
    },
    force_floor_w: {
        draw_layer: LAYER_TERRAIN,
        slide_mode: 'force',
        on_arrive(me, level, other) {
            level.set_actor_direction(other, 'west');
        },
    },
    force_floor_all: {
        draw_layer: LAYER_TERRAIN,
        slide_mode: 'force',
        // TODO ms: this is random, and an acting wall to monsters (!)
        // TODO lynx/cc2 check this at decision time, which may affect ordering
        on_arrive(me, level, other) {
            level.set_actor_direction(other, level.get_force_floor_direction());
        },
    },
    slime: {
        draw_layer: LAYER_TERRAIN,
        // FIXME kills everything except ghosts, blobs, blocks
        // FIXME blobs spread slime onto floor tiles, even destroying wiring
        on_arrive(me, level, other) {
            if (other.type.name === 'dirt_block' || other.type.name === 'ice_block') {
                level.transmute_tile(me, 'floor');
            }
        },
    },
    bomb: {
        draw_layer: LAYER_ITEM,
        on_arrive(me, level, other) {
            level.remove_tile(me);
            if (other.type.is_player) {
                level.fail('exploded');
            }
            else {
                level.sfx.play_once('bomb', me.cell);
                level.transmute_tile(other, 'explosion');
            }
        },
    },
    thief_tools: {
        draw_layer: LAYER_TERRAIN,
        blocks_monsters: true,
        blocks_blocks: true,
        on_arrive(me, level, other) {
            level.sfx.play_once('thief', me.cell);
            level.take_all_tools_from_actor(other);
            if (other.type.is_player) {
                level.adjust_bonus(0, 0.5);
            }
        },
    },
    thief_keys: {
        draw_layer: LAYER_TERRAIN,
        blocks_monsters: true,
        blocks_blocks: true,
        on_arrive(me, level, other) {
            level.sfx.play_once('thief', me.cell);
            level.take_all_keys_from_actor(other);
            if (other.type.is_player) {
                level.adjust_bonus(0, 0.5);
            }
        },
    },
    no_sign: {
        draw_layer: LAYER_NO_SIGN,
        disables_pickup: true,
        blocks(me, level, other) {
            let item;
            for (let tile of me.cell) {
                if (tile.type.is_item) {
                    item = tile.type.name;
                    break;
                }
            }
            return item && other.has_item(item);
        },
    },

    // Mechanisms
    dirt_block: {
        draw_layer: LAYER_ACTOR,
        blocks_all: true,
        is_actor: true,
        is_block: true,
        ignores: new Set(['fire']),
        movement_speed: 4,
    },
    ice_block: {
        draw_layer: LAYER_ACTOR,
        blocks_all: true,
        is_actor: true,
        is_block: true,
        can_reveal_walls: true,
        movement_speed: 4,
        pushes: {
            ice_block: true,
            directional_block: true,
        },
    },
    directional_block: {
        // TODO directional, obviously
        // TODO floor in water
        // TODO destroyed in fire, flame jet, slime
        // TODO rotate on train tracks
        draw_layer: LAYER_ACTOR,
        blocks_all: true,
        is_actor: true,
        is_block: true,
        can_reveal_walls: true,
        ignores: new Set(['fire']),
        movement_speed: 4,
        pushes: {
            dirt_block: true,
            ice_block: true,
            directional_block: true,
        },
    },
    green_floor: {
        draw_layer: LAYER_TERRAIN,
        on_gray_button(me, level) {
            level.transmute_tile(me, 'green_wall');
        },
    },
    green_wall: {
        draw_layer: LAYER_TERRAIN,
        blocks_all: true,
        on_gray_button(me, level) {
            level.transmute_tile(me, 'green_floor');
        },
    },
    green_chip: {
        draw_layer: LAYER_ITEM,
        is_chip: true,
        is_required_chip: true,
        blocks_monsters: true,
        blocks_blocks: true,
        on_arrive(me, level, other) {
            if (other.type.is_player) {
                level.collect_chip();
                level.remove_tile(me);
            }
        },
        // Not affected by gray buttons
    },
    green_bomb: {
        draw_layer: LAYER_ITEM,
        is_required_chip: true,
        on_arrive(me, level, other) {
            level.remove_tile(me);
            if (other.type.is_player) {
                level.fail('exploded');
            }
            else {
                level.sfx.play_once('bomb', me.cell);
                level.transmute_tile(other, 'explosion');
            }
        },
        // Not affected by gray buttons
    },
    purple_floor: {
        draw_layer: LAYER_TERRAIN,
        on_gray_button(me, level) {
            level.transmute_tile(me, 'purple_wall');
        },
        on_power(me, level) {
            me.type.on_gray_button(me, level);
        },
        on_depower(me, level) {
            me.type.on_gray_button(me, level);
        },
    },
    purple_wall: {
        draw_layer: LAYER_TERRAIN,
        blocks_all: true,
        on_gray_button(me, level) {
            level.transmute_tile(me, 'purple_floor');
        },
        on_power(me, level) {
            me.type.on_gray_button(me, level);
        },
        on_depower(me, level) {
            me.type.on_gray_button(me, level);
        },
    },
    cloner: {
        draw_layer: LAYER_TERRAIN,
        // TODO not the case for an empty one in cc2, apparently
        blocks_all: true,
        activate(me, level) {
            let cell = me.cell;
            // Copy, so we don't end up repeatedly cloning the same object
            for (let tile of Array.from(cell)) {
                if (tile !== me && tile.type.is_actor) {
                    // Copy this stuff in case the movement changes it
                    let type = tile.type;
                    let direction = tile.direction;

                    // Unstick and try to move the actor; if it's blocked,
                    // abort the clone
                    level.set_actor_stuck(tile, false);
                    if (level.attempt_step(tile, direction)) {
                        level.add_actor(tile);
                        // FIXME add this underneath, just above the cloner
                        let new_tile = new tile.constructor(type, direction);
                        level.add_tile(new_tile, cell);
                        level.set_actor_stuck(new_tile, true);
                    }
                    else {
                        level.set_actor_stuck(tile, true);
                    }
                }
            }
        },
        // Also clones on rising pulse or gray button
        on_power(me, level) {
            me.type.activate(me, level);
        },
        on_gray_button(me, level) {
            me.type.activate(me, level);
        },
    },
    trap: {
        draw_layer: LAYER_TERRAIN,
        on_ready(me, level) {
            // Trap any actor standing on us, unless we already know we're pressed
            if (me.presses)
                return;

            for (let tile of me.cell) {
                if (tile.type.is_actor) {
                    tile.stuck = true;
                }
            }
        },
        add_press_ready(me, level, other) {
            // Same as below, but without using the undo stack or ejection
            me.presses = (me.presses ?? 0) + 1;
            if (me.presses === 1) {
                for (let tile of me.cell) {
                    if (tile.type.is_actor) {
                        tile.stuck = false;
                    }
                }
            }
        },
        on_arrive(me, level, other) {
            if (me.presses) {
                // Lynx: Traps immediately eject their contents, if possible
                // TODO compat this, cc2 doens't do it!
                //level.attempt_step(other, other.direction);
            }
            else {
                level.set_actor_stuck(other, true);
            }
        },
        add_press(me, level) {
            level._set_prop(me, 'presses', (me.presses ?? 0) + 1);
            if (me.presses === 1) {
                // Free everything on us, if we went from 0 to 1 presses (i.e. closed to open)
                for (let tile of Array.from(me.cell)) {
                    if (tile.type.is_actor) {
                        level.set_actor_stuck(tile, false);
                        // Forcibly move anything released from a trap, to keep it in sync with
                        // whatever pushed the button
                        level.attempt_step(tile, tile.direction);
                    }
                }
            }
        },
        remove_press(me, level) {
            level._set_prop(me, 'presses', me.presses - 1);
            if (me.presses === 0) {
                // Trap everything on us, if we went from 1 to 0 presses (i.e. open to closed)
                for (let tile of me.cell) {
                    if (tile.type.is_actor) {
                        level.set_actor_stuck(tile, true);
                    }
                }
            }
        },
        on_power(me, level) {
            // Treat being powered or not as an extra kind of brown button press
            me.type.add_press(me, level);
            console.log("powering UP", me.presses);
        },
        on_depower(me, level) {
            me.type.remove_press(me, level);
            console.log("powering down...", me.presses);
        },
        visual_state(me) {
            if (me && me.presses) {
                return 'open';
            }
            else {
                return 'closed';
            }
        },
    },
    transmogrifier: {
        draw_layer: LAYER_TERRAIN,
        _mogrifications: {
            player: 'player2',
            player2: 'player',
            // TODO mirror players too

            dirt_block: 'ice_block',
            ice_block: 'dirt_block',

            ball: 'walker',
            walker: 'ball',

            fireball: 'bug',
            bug: 'glider',
            glider: 'paramecium',
            paramecium: 'fireball',

            tank_blue: 'tank_yellow',
            tank_yellow: 'tank_blue',

            // TODO teeth, timid teeth
        },
        _blob_mogrifications: ['ball', 'walker', 'fireball', 'glider', 'paramecium', 'bug', 'tank_blue', 'teeth', /* TODO 'timid_teeth' */ ],
        // TODO can be wired, in which case only works when powered; other minor concerns, see wiki
        on_arrive(me, level, other) {
            let name = other.type.name;
            if (me.type._mogrifications[name]) {
                level.transmute_tile(other, me.type._mogrifications[name]);
            }
            else if (name === 'blob') {
                // TODO how is this randomness determined?  important for replays!
                let options = me.type._blob_mogrifications;
                level.transmute_tile(other, options[Math.floor(Math.random() * options.length)]);
            }
        },
    },
    teleport_blue: {
        draw_layer: LAYER_TERRAIN,
        teleport_dest_order(me, level) {
            return level.iter_tiles_in_reading_order(me.cell, 'teleport_blue', true);
        },
    },
    teleport_red: {
        draw_layer: LAYER_TERRAIN,
        teleport_dest_order(me, level) {
            // FIXME you can control your exit direction from red teleporters
            return level.iter_tiles_in_reading_order(me.cell, 'teleport_red');
        },
    },
    teleport_green: {
        draw_layer: LAYER_TERRAIN,
        teleport_dest_order(me, level) {
            // FIXME exit direction is random; unclear if it's any direction or only unblocked ones
            let all = Array.from(level.iter_tiles_in_reading_order(me.cell, 'teleport_green'));
            // FIXME this should use the lynxish rng
            return [random_choice(all), me];
        },
    },
    teleport_yellow: {
        draw_layer: LAYER_TERRAIN,
        teleport_dest_order(me, level) {
            // FIXME special pickup behavior; NOT an item though, does not combine with no sign
            return level.iter_tiles_in_reading_order(me.cell, 'teleport_yellow', true);
        },
    },
    flame_jet_off: {
        draw_layer: LAYER_TERRAIN,
        activate(me, level) {
            level.transmute_tile(me, 'flame_jet_on');
        },
        on_gray_button(me, level) {
            me.type.activate(me, level);
        },
        on_power(me, level) {
            me.type.activate(me, level);
        },
    },
    flame_jet_on: {
        draw_layer: LAYER_TERRAIN,
        // FIXME every tic, kills every actor in the cell
        activate(me, level) {
            level.transmute_tile(me, 'flame_jet_off');
        },
        on_gray_button(me, level) {
            me.type.activate(me, level);
        },
        on_power(me, level) {
            me.type.activate(me, level);
        },
    },
    // Buttons
    button_blue: {
        draw_layer: LAYER_TERRAIN,
        on_arrive(me, level, other) {
            level.sfx.play_once('button-press', me.cell);

            // Flip direction of all blue tanks
            for (let actor of level.actors) {
                // TODO generify somehow??
                if (actor.type.name === 'tank_blue') {
                    level._set_prop(actor, 'pending_reverse', ! actor.pending_reverse);
                }
            }
        },
        on_depart(me, level, other) {
            level.sfx.play_once('button-release', me.cell);
        },
    },
    button_yellow: {
        draw_layer: LAYER_TERRAIN,
        on_arrive(me, level, other) {
            level.sfx.play_once('button-press', me.cell);

            // Move all yellow tanks one tile in the direction of the pressing actor
            for (let i = level.actors.length - 1; i >= 0; i--) {
                let actor = level.actors[i];
                // TODO generify somehow??
                if (actor.type.name === 'tank_yellow') {
                    level.attempt_step(actor, other.direction);
                }
            }
        },
        on_depart(me, level, other) {
            level.sfx.play_once('button-release', me.cell);
        },
    },
    button_green: {
        draw_layer: LAYER_TERRAIN,
        on_arrive(me, level, other) {
            level.sfx.play_once('button-press', me.cell);

            // Swap green floors and walls
            // TODO could probably make this more compact for undo purposes
            for (let row of level.cells) {
                for (let cell of row) {
                    for (let tile of cell) {
                        if (tile.type.name === 'green_floor') {
                            level.transmute_tile(tile, 'green_wall');
                        }
                        else if (tile.type.name === 'green_wall') {
                            level.transmute_tile(tile, 'green_floor');
                        }
                        else if (tile.type.name === 'green_chip') {
                            level.transmute_tile(tile, 'green_bomb');
                        }
                        else if (tile.type.name === 'green_bomb') {
                            level.transmute_tile(tile, 'green_chip');
                        }
                    }
                }
            }
        },
        on_depart(me, level, other) {
            level.sfx.play_once('button-release', me.cell);
        },
    },
    button_brown: {
        draw_layer: LAYER_TERRAIN,
        connects_to: 'trap',
        connect_order: 'forward',
        on_ready(me, level) {
            // Inform the trap of any actors that start out holding us down
            let trap = me.connection;
            if (! (trap && trap.cell))
                return;

            for (let tile of me.cell) {
                if (tile.type.is_actor) {
                    trap.type.add_press_ready(trap, level);
                }
            }
        },
        on_arrive(me, level, other) {
            level.sfx.play_once('button-press', me.cell);

            let trap = me.connection;
            if (trap && trap.cell) {
                trap.type.add_press(trap, level);
            }
        },
        on_depart(me, level, other) {
            level.sfx.play_once('button-release', me.cell);

            let trap = me.connection;
            if (trap && trap.cell) {
                trap.type.remove_press(trap, level);
            }
        },
    },
    button_red: {
        draw_layer: LAYER_TERRAIN,
        connects_to: 'cloner',
        connect_order: 'forward',
        on_arrive(me, level, other) {
            level.sfx.play_once('button-press', me.cell);

            let cloner = me.connection;
            if (cloner && cloner.cell) {
                cloner.type.activate(cloner, level);
            }
        },
        on_depart(me, level, other) {
            level.sfx.play_once('button-release', me.cell);
        },
    },
    button_orange: {
        draw_layer: LAYER_TERRAIN,
        // FIXME toggles flame jets, connected somehow, ???
    },
    button_pink: {
        draw_layer: LAYER_TERRAIN,
        is_emitting(me, level) {
            // We emit current as long as there's an actor on us
            return me.cell.some(tile => tile.type.is_actor);
        },
        on_arrive(me, level, other) {
            level.sfx.play_once('button-press', me.cell);
        },
        on_depart(me, level, other) {
            level.sfx.play_once('button-release', me.cell);
        },
    },
    button_black: {
        // TODO not implemented
        draw_layer: LAYER_TERRAIN,
    },
    button_gray: {
        // TODO only partially implemented
        draw_layer: LAYER_TERRAIN,
        on_arrive(me, level, other) {
            level.sfx.play_once('button-press', me.cell);

            for (let x = Math.max(0, me.cell.x - 2); x <= Math.min(level.width - 1, me.cell.x + 2); x++) {
                for (let y = Math.max(0, me.cell.y - 2); y <= Math.min(level.height - 1, me.cell.y + 2); y++) {
                    let cell = level.cells[y][x];
                    // TODO wait is this right
                    if (cell === me.cell)
                        continue;

                    for (let tile of cell) {
                        if (tile.type.on_gray_button) {
                            tile.type.on_gray_button(tile, level);
                        }
                    }
                }
            }
        },
        on_depart(me, level, other) {
            level.sfx.play_once('button-release', me.cell);
        },
    },

    // Time alteration
    stopwatch_bonus: {
        draw_layer: LAYER_ITEM,
        blocks_monsters: true,
        blocks_blocks: true,
        on_arrive(me, level, other) {
            if (other.type.is_player) {
                level.remove_tile(me);
                level.adjust_timer(+10);
            }
        },
    },
    stopwatch_penalty: {
        draw_layer: LAYER_ITEM,
        blocks_monsters: true,
        blocks_blocks: true,
        on_arrive(me, level, other) {
            if (other.type.is_player) {
                level.remove_tile(me);
                level.adjust_timer(-10);
            }
        },
    },
    stopwatch_toggle: {
        draw_layer: LAYER_ITEM,
        blocks_monsters: true,
        blocks_blocks: true,
        on_arrive(me, level, other) {
            if (other.type.is_player) {
                level.pause_timer();
            }
        },
    },

    // Critters
    bug: {
        draw_layer: LAYER_ACTOR,
        is_actor: true,
        is_monster: true,
        blocks_monsters: true,
        blocks_blocks: true,
        movement_mode: 'follow-left',
        movement_speed: 4,
    },
    paramecium: {
        draw_layer: LAYER_ACTOR,
        is_actor: true,
        is_monster: true,
        blocks_monsters: true,
        blocks_blocks: true,
        movement_mode: 'follow-right',
        movement_speed: 4,
    },
    ball: {
        draw_layer: LAYER_ACTOR,
        is_actor: true,
        is_monster: true,
        blocks_monsters: true,
        blocks_blocks: true,
        movement_mode: 'bounce',
        movement_speed: 4,
    },
    walker: {
        draw_layer: LAYER_ACTOR,
        is_actor: true,
        is_monster: true,
        blocks_monsters: true,
        blocks_blocks: true,
        movement_mode: 'bounce-random',
        movement_speed: 4,
    },
    tank_blue: {
        draw_layer: LAYER_ACTOR,
        is_actor: true,
        is_monster: true,
        blocks_monsters: true,
        blocks_blocks: true,
        movement_mode: 'forward',
        movement_speed: 4,
    },
    tank_yellow: {
        draw_layer: LAYER_ACTOR,
        is_actor: true,
        is_monster: true,
        blocks_monsters: true,
        blocks_blocks: true,
        pushes: {
            dirt_block: true,
            ice_block: true,
            directional_block: true,
        },
        movement_speed: 4,
    },
    blob: {
        draw_layer: LAYER_ACTOR,
        is_actor: true,
        is_monster: true,
        blocks_monsters: true,
        blocks_blocks: true,
        movement_mode: 'random',
        movement_speed: 8,
    },
    teeth: {
        draw_layer: LAYER_ACTOR,
        is_actor: true,
        is_monster: true,
        blocks_monsters: true,
        blocks_blocks: true,
        movement_mode: 'pursue',
        movement_speed: 4,
        uses_teeth_hesitation: true,
    },
    fireball: {
        draw_layer: LAYER_ACTOR,
        is_actor: true,
        is_monster: true,
        blocks_monsters: true,
        blocks_blocks: true,
        movement_mode: 'turn-right',
        movement_speed: 4,
        ignores: new Set(['fire']),
    },
    glider: {
        draw_layer: LAYER_ACTOR,
        is_actor: true,
        is_monster: true,
        blocks_monsters: true,
        blocks_blocks: true,
        movement_mode: 'turn-left',
        movement_speed: 4,
        ignores: new Set(['water']),
    },
    ghost: {
        draw_layer: LAYER_ACTOR,
        is_actor: true,
        is_monster: true,
        blocks_monsters: true,
        blocks_blocks: true,
        movement_mode: 'turn-right',
        movement_speed: 4,
        // TODO ignores /most/ walls.  collision is basically completely different.  has a regular inventory, except red key.  good grief
    },
    floor_mimic: {
        draw_layer: LAYER_ACTOR,
        is_actor: true,
        is_monster: true,
        blocks_monsters: true,
        blocks_blocks: true,
        // TODO not like teeth; always pursues
        // TODO takes 3 turns off!
        movement_mode: 'pursue',
        movement_speed: 4,
    },
    rover: {
        // TODO this guy is a nightmare
        // TODO pushes blocks apparently??
        draw_layer: LAYER_ACTOR,
        is_actor: true,
        is_monster: true,
        blocks_monsters: true,
        blocks_blocks: true,
        can_reveal_walls: true,
        movement_mode: 'random',
        movement_speed: 4,
    },

    // Keys, whose behavior varies
    key_red: {
        // TODO Red key can ONLY be picked up by players (and doppelgangers), no other actor that
        // has an inventory
        draw_layer: LAYER_ITEM,
        is_item: true,
        is_key: true,
    },
    key_blue: {
        // Blue key is picked up by dirt blocks and all monsters, including those that don't have an
        // inventory normally
        draw_layer: LAYER_ITEM,
        is_item: true,
        is_key: true,
        on_arrive(me, level, other) {
            // Call it...  everything except ice and directional blocks?  These rules are weird.
            // Note that the game itself normally handles picking items up, so we only get here for
            // actors who aren't supposed to have an inventory
            // TODO make this a...  flag?  i don't know?
            // TODO major difference from lynx...
            if (other.type.name !== 'ice_block' && other.type.name !== 'directional_block') {
                level.attempt_take(other, me);
            }
        },
    },
    key_yellow: {
        draw_layer: LAYER_ITEM,
        is_item: true,
        is_key: true,
        blocks_monsters: true,
        blocks_blocks: true,
    },
    key_green: {
        draw_layer: LAYER_ITEM,
        is_item: true,
        is_key: true,
        blocks_monsters: true,
        blocks_blocks: true,
    },
    // Boots
    // TODO note: ms allows blocks to pass over tools
    cleats: {
        draw_layer: LAYER_ITEM,
        is_item: true,
        is_tool: true,
        blocks_monsters: true,
        blocks_blocks: true,
        item_ignores: new Set(['ice', 'ice_nw', 'ice_ne', 'ice_sw', 'ice_se']),
    },
    suction_boots: {
        draw_layer: LAYER_ITEM,
        is_item: true,
        is_tool: true,
        blocks_monsters: true,
        blocks_blocks: true,
        item_ignores: new Set([
            'force_floor_n',
            'force_floor_s',
            'force_floor_e',
            'force_floor_w',
            'force_floor_all',
        ]),
    },
    fire_boots: {
        draw_layer: LAYER_ITEM,
        is_item: true,
        is_tool: true,
        blocks_monsters: true,
        blocks_blocks: true,
        item_ignores: new Set(['fire']),
    },
    flippers: {
        draw_layer: LAYER_ITEM,
        is_item: true,
        is_tool: true,
        blocks_monsters: true,
        blocks_blocks: true,
        item_ignores: new Set(['water']),
    },
    hiking_boots: {
        draw_layer: LAYER_ITEM,
        is_item: true,
        is_tool: true,
        blocks_monsters: true,
        blocks_blocks: true,
        // FIXME uhh these "ignore" that dirt and gravel block us, but they don't ignore the on_arrive, so, uhhhh
    },
    // Other tools
    dynamite: {
        draw_layer: LAYER_ITEM,
        is_item: true,
        is_tool: true,
        blocks_monsters: true,
        blocks_blocks: true,
        // FIXME does a thing when dropped, but that isn't implemented at all yet
    },
    bowling_ball: {
        // TODO not implemented, rolls when dropped, has an inventory, yadda yadda
        draw_layer: LAYER_ITEM,
        is_item: true,
        is_tool: true,
        blocks_monsters: true,
        blocks_blocks: true,
    },
    xray_eye: {
        // TODO not implemented
        draw_layer: LAYER_ITEM,
        is_item: true,
        is_tool: true,
        blocks_monsters: true,
        blocks_blocks: true,
    },
    helmet: {
        // TODO not implemented
        draw_layer: LAYER_ITEM,
        is_item: true,
        is_tool: true,
        blocks_monsters: true,
        blocks_blocks: true,
    },
    railroad_sign: {
        draw_layer: LAYER_ITEM,
        is_item: true,
        is_tool: true,
        blocks_monsters: true,
        blocks_blocks: true,
        // FIXME this doesn't work any more, need to put it in railroad blocks impl
        item_ignores: new Set(['railroad']),
    },
    foil: {
        // TODO not implemented
        draw_layer: LAYER_ITEM,
        is_item: true,
        is_tool: true,
        blocks_monsters: true,
        blocks_blocks: true,
    },

    // Progression
    player: {
        draw_layer: LAYER_ACTOR,
        is_actor: true,
        is_player: true,
        has_inventory: true,
        can_reveal_walls: true,
        movement_speed: 4,
        pushes: {
            dirt_block: true,
            ice_block: true,
            directional_block: true,
        },
        infinite_items: {
            key_green: true,
        },
        visual_state: player_visual_state,
    },
    player2: {
        draw_layer: LAYER_ACTOR,
        is_actor: true,
        is_player: true,
        has_inventory: true,
        can_reveal_walls: true,
        movement_speed: 4,
        ignores: new Set(['ice', 'ice_nw', 'ice_ne', 'ice_sw', 'ice_se']),
        pushes: {
            dirt_block: true,
            ice_block: true,
            directional_block: true,
        },
        infinite_items: {
            key_yellow: true,
        },
        visual_state: player_visual_state,
    },
    chip: {
        draw_layer: LAYER_ITEM,
        is_chip: true,
        is_required_chip: true,
        blocks_monsters: true,
        blocks_blocks: true,
        on_arrive(me, level, other) {
            if (other.type.is_player) {
                level.collect_chip();
                level.remove_tile(me);
            }
        },
    },
    chip_extra: {
        draw_layer: LAYER_ITEM,
        is_chip: true,
        blocks_monsters: true,
        blocks_blocks: true,
        on_arrive(me, level, other) {
            if (other.type.is_player) {
                level.collect_chip();
                level.remove_tile(me);
            }
        },
    },
    score_10: {
        draw_layer: LAYER_ITEM,
        blocks_monsters: true,
        blocks_blocks: true,
        on_arrive(me, level, other) {
            if (other.type.is_player) {
                level.adjust_bonus(10);
            }
            level.remove_tile(me);
        },
    },
    score_100: {
        draw_layer: LAYER_ITEM,
        blocks_monsters: true,
        blocks_blocks: true,
        on_arrive(me, level, other) {
            if (other.type.is_player) {
                level.adjust_bonus(100);
            }
            level.remove_tile(me);
        },
    },
    score_1000: {
        draw_layer: LAYER_ITEM,
        blocks_monsters: true,
        blocks_blocks: true,
        on_arrive(me, level, other) {
            if (other.type.is_player) {
                level.adjust_bonus(1000);
            }
            level.remove_tile(me);
        },
    },
    score_2x: {
        draw_layer: LAYER_ITEM,
        blocks_monsters: true,
        blocks_blocks: true,
        on_arrive(me, level, other) {
            if (other.type.is_player) {
                level.adjust_bonus(0, 2);
            }
            level.remove_tile(me);
        },
    },

    hint: {
        draw_layer: LAYER_TERRAIN,
        is_hint: true,
        blocks_monsters: true,
        blocks_blocks: true,
    },
    socket: {
        draw_layer: LAYER_TERRAIN,
        blocks_monsters: true,
        blocks_blocks: true,
        blocks(me, level, other) {
            return (level.chips_remaining > 0);
        },
        on_arrive(me, level, other) {
            if (other.type.is_player && level.chips_remaining === 0) {
                level.sfx.play_once('socket');
                level.transmute_tile(me, 'floor');
            }
        },
    },
    exit: {
        draw_layer: LAYER_TERRAIN,
        blocks_monsters: true,
        blocks_blocks: true,
        on_arrive(me, level, other) {
            if (other.type.is_player) {
                level.win();
            }
        },
    },

    // VFX
    splash: {
        draw_layer: LAYER_OVERLAY,
        is_actor: true,
        blocks_players: true,
        ttl: 6,
    },
    explosion: {
        draw_layer: LAYER_OVERLAY,
        is_actor: true,
        blocks_players: true,
        ttl: 6,
    },

    // Invalid tiles that appear in some CCL levels because community level
    // designers love to make nonsense
    bogus_player_win: {
        draw_layer: LAYER_TERRAIN,
        blocks_all: true,
    },
    bogus_player_swimming: {
        draw_layer: LAYER_TERRAIN,
        blocks_all: true,
    },
    bogus_player_drowned: {
        draw_layer: LAYER_TERRAIN,
        blocks_all: true,
    },
    bogus_player_burned_fire: {
        draw_layer: LAYER_TERRAIN,
        blocks_all: true,
    },
    bogus_player_burned: {
        draw_layer: LAYER_TERRAIN,
        blocks_all: true,
    },
};

// Tell them all their own names
for (let [name, type] of Object.entries(TILE_TYPES)) {
    type.name = name;

    if (type.draw_layer === undefined ||
        type.draw_layer !== Math.floor(type.draw_layer) ||
        type.draw_layer >= 4)
    {
        console.error(`Tile type ${name} has a bad draw layer`);
    }
}

export default TILE_TYPES;
