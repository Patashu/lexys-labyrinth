// TODO bugs and quirks i'm aware of:
// - steam: if a player character starts on a force floor they won't be able to make any voluntary movements until they are no longer on a force floor
import { DIRECTIONS, TICS_PER_SECOND } from './defs.js';
import * as c2m from './format-c2m.js';
import * as dat from './format-dat.js';
import * as format_util from './format-util.js';
import { Level } from './game.js';
import CanvasRenderer from './renderer-canvas.js';
import SOUNDTRACK from './soundtrack.js';
import { Tileset, CC2_TILESET_LAYOUT, LL_TILESET_LAYOUT, TILE_WORLD_TILESET_LAYOUT } from './tileset.js';
import TILE_TYPES from './tiletypes.js';
import { random_choice, mk, mk_svg, promise_event, fetch, walk_grid } from './util.js';

const PAGE_TITLE = "Lexy's Labyrinth";
// Stackable modal overlay of some kind, usually a dialog
class Overlay {
    constructor(conductor, root) {
        this.conductor = conductor;
        this.root = root;

        // Don't propagate clicks on the root element, so they won't trigger a
        // parent overlay's automatic dismissal
        this.root.addEventListener('click', ev => {
            ev.stopPropagation();
        });
    }

    open() {
        // FIXME ah, but keystrokes can still go to the game, including
        // spacebar to begin it if it was waiting.  how do i completely disable
        // an entire chunk of the page?
        if (this.conductor.player.state === 'playing') {
            this.conductor.player.set_state('paused');
        }

        let overlay = mk('div.overlay', this.root);
        document.body.append(overlay);

        // Remove the overlay when clicking outside the element
        overlay.addEventListener('click', ev => {
            this.close();
        });
    }

    close() {
        this.root.closest('.overlay').remove();
    }
}

// Overlay styled like a dialog box
class DialogOverlay extends Overlay {
    constructor(conductor) {
        super(conductor, mk('div.dialog'));

        this.root.append(
            this.header = mk('header'),
            this.main = mk('section'),
            this.footer = mk('footer'),
        );
    }

    set_title(title) {
        this.header.textContent = '';
        this.header.append(mk('h1', {}, title));
    }

    add_button(label, onclick) {
        let button = mk('button', {type: 'button'}, label);
        button.addEventListener('click', onclick);
        this.footer.append(button);
    }
}

// Yes/no popup dialog
class ConfirmOverlay extends DialogOverlay {
    constructor(conductor, message, what) {
        super(conductor);
        this.set_title("just checking");
        this.main.append(mk('p', {}, message));
        let yes = mk('button', {type: 'button'}, "yep");
        let no = mk('button', {type: 'button'}, "nope");
        yes.addEventListener('click', ev => {
            this.close();
            what();
        });
        no.addEventListener('click', ev => {
            this.close();
        });
        this.footer.append(yes, no);
    }
}


// -------------------------------------------------------------------------------------------------
// Main display...  modes

class PrimaryView {
    constructor(conductor, root) {
        this.conductor = conductor;
        this.root = root;
        this.active = false;
        this._done_setup = false;
    }

    setup() {}

    activate() {
        this.root.removeAttribute('hidden');
        this.active = true;
        if (! this._done_setup) {
            this.setup();
            this._done_setup = true;
        }
    }

    deactivate() {
        this.root.setAttribute('hidden', '');
        this.active = false;
    }
}


// TODO:
// - level password, if any
const ACTION_LABELS = {
    up: '⬆️\ufe0f',
    down: '⬇️\ufe0f',
    left: '⬅️\ufe0f',
    right: '➡️\ufe0f',
    drop: '🚮',
    cycle: '🔄',
    swap: '👫',
};
const ACTION_DIRECTIONS = {
    up: 'north',
    down: 'south',
    left: 'west',
    right: 'east',
};
const OBITUARIES = {
    drowned: [
        "you tried out water cooling",
        "you fell into the c",
    ],
    burned: [
        "your core temp got too high",
        "your plans went up in smoke",
    ],
    exploded: [
        "watch where you step",
        "looks like you're having a blast",
        "you tripped over something of mine",
        "you were blown to bits",
    ],
    squished: [
        "that block of ram was too much for you",
        "you became two-dimensional",
    ],
    time: [
        "you tried to overclock",
        "your time ran out",
        "your speedrun went badly",
    ],
    generic: [
        "you had a bad time",
    ],

    // Specific creatures
    ball: [
        "you're having a ball",
        "you'll bounce back from this",
    ],
    walker: [
        "you let it walk all over you",
        "step into, step over, step out",
    ],
    fireball: [
        "you had a meltdown",
        "you haven't been flamed like that since usenet",
    ],
    glider: [
        "your ship came in",
        "don't worry, everything's fin now",
    ],
    tank_blue: [
        "you didn't watch where they tread",
        "please and tank blue",
    ],
    tank_yellow: [
        "you let things get out of control",
        "you need more direction in your life",
        "your chances of surviving that were remote",
    ],
    bug: [
        "you got ants in your pants",
        "there's a bug in your code",
        "time for some debugging",
    ],
    paramecium: [
        "you got the creepy crawlies",
        "you couldn't wriggle out of that one",
    ],
    teeth: [
        "you got a mega bite",
        "you got a little nybble",
        "you're quite a mouthful",
        "if it helps, apparently you're delicious",
    ],
    blob: [
        "gooed job there",
        "blame the rng for that one",
        "goo another way next time",
    ],
};
// Helper class used to let the game play sounds without knowing too much about the Player
class SFXPlayer {
    constructor() {
        this.ctx = new window.AudioContext;
        this.player_x = null;
        this.player_y = null;
        this.sounds = {};
        this.sound_sources = {
            // handcrafted
            blocked: 'sfx/mmf.ogg',
            // https://jummbus.bitbucket.io/#j2N04bombn110s0k0l00e00t3Mm4a3g00j07i0r1O_U00o30T0v0pL0OD0Ou00q1d1f8y0z2C0w2c0h2T2v0kL0OD0Ou02q1d1f6y1z2C1w1b4gp1b0aCTFucgds0
            bomb: 'sfx/bomb.ogg',
            // https://jummbus.bitbucket.io/#j2N0cbutton-pressn100s0k0l00e00t3Mm1a3g00j07i0r1O_U0o3T0v0pL0OD0Ou00q1d1f3y1z1C2w0c0h0b4p1bJdn51eMUsS0
            'button-press': 'sfx/button-press.ogg',
            // https://jummbus.bitbucket.io/#j2N0ebutton-releasen100s0k0l00e00t3Mm1a3g00j07i0r1O_U0o3T0v0pL0OD0Ou00q1d1f3y1z1C2w0c0h0b4p1aArdkga4sG0
            'button-release': 'sfx/button-release.ogg',
            // https://jummbus.bitbucket.io/#j2N04doorn110s0k0l00e00t3Mmfa3g00j07i0r1O_U00o30T0v0zL0OD0Ou00q0d1f8y0z2C0w2c0h0T2v0pL0OD0Ou02q0d1f8y3ziC0w1b4gp1f0aqEQ0lCNzrYUY0
            door: 'sfx/door.ogg',
            // https://jummbus.bitbucket.io/#j2N08get-chipn100s0k0l00e00t3Mmca3g00j07i0r1O_U0o4T0v0zL0OD0Ou00q1d1f6y1z2C0wac0h0b4p1dFyW7czgUK7aw0
            'get-chip': 'sfx/get-chip.ogg',
            // https://jummbus.bitbucket.io/#j2N07get-keyn100s0k0l00e00t3Mmfa3g00j07i0r1O_U0o5T0v0pL0OD0Ou00q1d5f8y0z2C0w1c0h0b4p1dFyW85CbwwzBg0
            'get-key': 'sfx/get-key.ogg',
            // https://jummbus.bitbucket.io/#j2N08get-tooln100s0k0l00e00t3Mm6a3g00j07i0r1O_U0o2T0v0pL0OD0Ou00q1d1f4y2z9C0w2c0h0b4p1bGqKNW4isVk0
            'get-tool': 'sfx/get-tool.ogg',
            // https://jummbus.bitbucket.io/#j2N06socketn110s0k0l00e00t3Mm4a3g00j07i0r1O_U00o30T5v0pL0OD0Ou05q1d1f8y1z7C1c0h0HU7000U0006000ET2v0pL0OD0Ou02q1d6f5y3z2C0w0b4gp1xGoKHGhFBcn2FyPkxk0rE2AGcNCQyHwUY0
            socket: 'sfx/socket.ogg',
            // https://jummbus.bitbucket.io/#j2N06splashn110s0k0l00e00t3Mm5a3g00j07i0r1O_U00o20T0v0pL0OD0Ou00q0d0fay0z0C0w9c0h8T2v05L0OD0Ou02q2d6fay0z1C0w0b4gp1lGqKQy02gUY1qh7D1wb2Y0
            // https://jummbus.bitbucket.io/#j2N06splashn110s0k0l00e00t3Mm5a3g00j07i0r1O_U00o20T0v0pL0OD0Ou00q0d0fay0z0C0w9c0h8T2v05L0OD0Ou02q2d6fay0z1C0w0b4gp1lGqKQxw_zzM5F4us60IbM0
            splash: 'sfx/splash.ogg',
            // https://jummbus.bitbucket.io/#j2N0astep-floorn100s0k0l00e00t3Mm6a3g00j07i0r1O_U0o1T0v05L0OD0Ou00q0d2f1y1zjC2w0c0h0b4p1aGaKaxqer00
            'step-floor': 'sfx/step-floor.ogg',
            // https://jummbus.bitbucket.io/#j2N08teleportn110s1k0l00e00t3Mm7a3g00j07i0r1O_U00o50T0v0pL0OD0Ou00q1d1f8y4z6C2w5c4h0T2v0kL0OD0Ou02q1d7f8y4z3C1w4b4gp1wF2Uzh5wdC18yHH4hhBhHwaATXu0Asds0
            teleport: 'sfx/teleport.ogg',
            // https://jummbus.bitbucket.io/#j2N05thiefn100s1k0l00e00t3Mm3a3g00j07i0r1O_U0o1T0v0pL0OD0Ou00q1d1f5y1z8C2w2c0h0b4p1fFyUBBr9mGkKKds0
            thief: 'sfx/thief.ogg',

            // handcrafted
            lose: 'sfx/bummer.ogg',
            // https://jummbus.bitbucket.io/#j2N04tickn100s0k0l00e00t3Mmca3g00j07i0r1O_U0o2T0v0pL0OD0Ou00q1d1f7y1ziC0w4c0h4b4p1bKqE6Rtxex00
            tick: 'sfx/tick.ogg',
            // https://jummbus.bitbucket.io/#j2N06timeupn100s0k0l00e00t3Mm4a3g00j07i0r1O_U0o3T1v0pL0OD0Ou01q1d5f4y1z8C1c0A0F0B0V1Q38e0Pa610E0861b4p1dIyfgKPcLucqU0
            timeup: 'sfx/timeup.ogg',
            // https://jummbus.bitbucket.io/#j2N03winn200s0k0l00e00t2wm9a3g00j07i0r1O_U00o32T0v0EL0OD0Ou00q1d1f5y1z1C2w1c2h0T0v0pL0OD0Ou00q0d1f2y1z2C0w2c3h0b4gp1xFyW4xo31pe0MaCHCbwLbM5cFDgapBOyY0
            win: 'sfx/win.ogg',
        };

        for (let [name, path] of Object.entries(this.sound_sources)) {
            this.init_sound(name, path);
        }

        this.mmf_cooldown = 0;
    }

    async init_sound(name, path) {
        let buf = await fetch(path);
        let audiobuf = await this.ctx.decodeAudioData(buf);
        this.sounds[name] = {
            buf: buf,
            audiobuf: audiobuf,
        };
    }

    set_player_position(cell) {
        this.player_x = cell.x;
        this.player_y = cell.y;
    }

    play_once(name, cell = null) {
        let data = this.sounds[name];
        if (! data) {
            // Hasn't loaded yet, not much we can do
            if (! this.sound_sources[name]) {
                console.warn("Tried to play non-existent sound", name);
            }
            return;
        }

        // "Mmf" can technically play every tic since bumping into something doesn't give a movement
        // cooldown, so give it our own sound cooldown
        if (name === 'blocked' && this.player_x !== null) {
            if (this.mmf_cooldown > 0) {
                return;
            }
            else {
                this.mmf_cooldown = 4;
            }
        }

        let node = this.ctx.createBufferSource();
        node.buffer = data.audiobuf;

        if (cell && this.player_x !== null) {
            // Reduce the volume for further-away sounds
            let dx = cell.x - this.player_x;
            let dy = cell.y - this.player_y;
            let dist = Math.sqrt(dx*dx + dy*dy);
            let gain = this.ctx.createGain();
            // x/(x + a) is a common and delightful way to get an easy asymptote and output between
            // 0 and 1.  Here, the result is above 80% for almost everything on screen; drops down
            // to 50% for things 20 tiles away (which is, roughly, the periphery when standing in
            // the center of a CC1 map), and bottoms out at 12.5% for standing in one corner of a
            // CC2 map of max size and hearing something on the far opposite corner.
            gain.gain.value = 1 - dist / (dist + 20);
            node.connect(gain);
            gain.connect(this.ctx.destination);
        }
        else {
            // Play at full volume
            node.connect(this.ctx.destination);
        }
        node.start(this.ctx.currentTime);
    }

    // Reduce cooldowns
    advance_tic() {
        if (this.mmf_cooldown > 0) {
            this.mmf_cooldown -= 1;
        }
    }
}
class Player extends PrimaryView {
    constructor(conductor) {
        super(conductor, document.body.querySelector('main#player'));

        this.key_mapping = {
            ArrowLeft: 'left',
            ArrowRight: 'right',
            ArrowUp: 'up',
            ArrowDown: 'down',
            Spacebar: 'wait',
            " ": 'wait',
            w: 'up',
            a: 'left',
            s: 'down',
            d: 'right',
            q: 'drop',
            e: 'cycle',
            c: 'swap',
        };

        this.scale = 1;

        this.compat = {
            tiles_react_instantly: false,
        };

        this.root.style.setProperty('--tile-width', `${this.conductor.tileset.size_x}px`);
        this.root.style.setProperty('--tile-height', `${this.conductor.tileset.size_y}px`);
        this.level_el = this.root.querySelector('.level');
        this.overlay_message_el = this.root.querySelector('.overlay-message');
        this.message_el = this.root.querySelector('.message');
        this.chips_el = this.root.querySelector('.chips output');
        this.time_el = this.root.querySelector('.time output');
        this.bonus_el = this.root.querySelector('.bonus output');
        this.inventory_el = this.root.querySelector('.inventory');
        this.input_el = this.root.querySelector('.input');
        this.demo_el = this.root.querySelector('.demo');

        this.music_el = this.root.querySelector('#player-music');
        this.music_audio_el = this.music_el.querySelector('audio');
        this.music_index = null;
        let volume_el = this.music_el.querySelector('#player-music-volume');
        this.music_audio_el.volume = this.conductor.options.music_volume ?? 1.0;
        volume_el.value = this.music_audio_el.volume;
        volume_el.addEventListener('input', ev => {
            let volume = ev.target.value;
            this.conductor.options.music_volume = volume;
            this.conductor.save_stash();

            this.music_audio_el.volume = ev.target.value;
        });
        let enabled_el = this.music_el.querySelector('#player-music-unmute');
        this.music_enabled = this.conductor.options.music_enabled ?? true;
        enabled_el.checked = this.music_enabled;
        enabled_el.addEventListener('change', ev => {
            this.music_enabled = ev.target.checked;
            this.conductor.options.music_enabled = this.music_enabled;
            this.conductor.save_stash();

            // TODO also hide most of the music stuff
            if (this.music_enabled) {
                this.update_music_playback_state();
            }
            else {
                this.music_audio_el.pause();
            }
        });
        
        this.turn_based = false;
        this.turn_based_checkbox = this.root.querySelector('.controls .turn-based');
        this.turn_based_checkbox.addEventListener('change', ev => {
            this.turn_based = !this.turn_based;
            this.level.turn_based = this.turn_based;
        });

        // Bind buttons
        this.pause_button = this.root.querySelector('.controls .control-pause');
        this.pause_button.addEventListener('click', ev => {
            this.toggle_pause();
            ev.target.blur();
        });
        this.restart_button = this.root.querySelector('.controls .control-restart');
        this.restart_button.addEventListener('click', ev => {
            new ConfirmOverlay(this.conductor, "Abandon this attempt and try again?", () => {
                this.restart_level();
            }).open();
            ev.target.blur();
        });
        this.undo_button = this.root.querySelector('.controls .control-undo');
        this.undo_button.addEventListener('click', ev => {
            let player_cell = this.level.player.cell;
            // Keep undoing until (a) we're on another cell and (b) we're not
            // sliding, i.e. we're about to make a conscious move
            let moved = false;
            while (this.level.undo_stack.length > 0 &&
                ! (moved && this.level.player.slide_mode === null))
            {
                this.level.undo();
                if (player_cell !== this.level.player.cell) {
                    moved = true;
                }
            }
            // TODO set back to waiting if we hit the start of the level?  but
            // the stack trims itself so how do we know that
            if (this.state === 'stopped') {
                // Be sure to undo any success or failure
                this.set_state('playing');
            }
            this.update_ui();
            this._redraw();
            ev.target.blur();
        });
        this.rewind_button = this.root.querySelector('.controls .control-rewind');
        this.rewind_button.addEventListener('click', ev => {
            if (this.level.undo_stack.length > 0) {
                this.state = 'rewinding';
            }
        });
        // Demo playback
        this.root.querySelector('.demo-controls .demo-play').addEventListener('click', ev => {
            if (this.state === 'playing' || this.state === 'paused' || this.state === 'rewinding') {
                new ConfirmOverlay(this.conductor, "Abandon your progress and watch the replay?", () => {
                    this.play_demo();
                });
            }
            else {
                this.play_demo();
            }
        });
        this.root.querySelector('.demo-controls .demo-step-1').addEventListener('click', ev => {
            this.advance_by(1);
            this._redraw();
        });
        this.root.querySelector('.demo-controls .demo-step-4').addEventListener('click', ev => {
            this.advance_by(4);
            this._redraw();
        });

        this.renderer = new CanvasRenderer(this.conductor.tileset);
        this.level_el.append(this.renderer.canvas);
        this.renderer.canvas.addEventListener('auxclick', ev => {
            if (ev.button !== 1)
                return;
            // TODO make a real debug flag?  allow enabling this but consider it aid level 3?
            if (! location.host.match(/localhost/))
                return;

            let [x, y] = this.renderer.cell_coords_from_event(ev);
            this.level.move_to(this.level.player, this.level.cells[y][x], 1);
        });

        // Populate inventory
        this._inventory_tiles = {};
        let floor_tile = this.render_inventory_tile('floor');
        this.inventory_el.style.backgroundImage = `url(${floor_tile})`;
        this.inventory_key_nodes = {};
        this.inventory_tool_nodes = [];
        for (let key of ['key_red', 'key_blue', 'key_yellow', 'key_green']) {
            let img = mk('img', {src: this.render_inventory_tile(key)});
            let count = mk('span.-count');
            let root = mk('span', img, count);
            this.inventory_key_nodes[key] = {root, img, count};
            this.inventory_el.append(root);
        }
        for (let i = 0; i < 4; i++) {
            let img = mk('img');
            this.inventory_tool_nodes.push(img);
            this.inventory_el.append(img);
        }

        let last_key;
        this.pending_player_move = null;
        this.next_player_move = null;
        this.player_used_move = false;
        let key_target = document.body;
        this.previous_input = new Set;  // actions that were held last tic
        this.previous_action = null;  // last direction we were moving, if any
        this.current_keys = new Set;  // keys that are currently held
        // TODO this could all probably be more rigorous but it's fine for now
        key_target.addEventListener('keydown', ev => {
            if (ev.key === 'p' || ev.key === 'Pause') {
                this.toggle_pause();
                return;
            }

            if (ev.key === ' ') {
                if (this.state === 'waiting') {
                    // Start without moving
                    this.set_state('playing');
                }
                else if (this.state === 'stopped') {
                    if (this.level.state === 'success') {
                        // Advance to the next level
                        // TODO game ending?
                        this.conductor.change_level(this.conductor.level_index + 1);
                    }
                    else {
                        // Restart
                        if (!this.current_keys.has(ev.key)) {
                            this.restart_level();
                        }
                    }
                    return;
                }
                // Don't scroll pls
                ev.preventDefault();
            }

            if (ev.key === 'z') {
                if (this.level.undo_stack.length > 0 &&
                    (this.state === 'stopped' || this.state === 'playing' || this.state === 'paused'))
                {
                    this.set_state('rewinding');
                }
            }

            if (this.key_mapping[ev.key]) {
                this.current_keys.add(ev.key);
                ev.stopPropagation();
                ev.preventDefault();

                if (this.state === 'waiting') {
                    this.set_state('playing');
                }
            }
        });
        key_target.addEventListener('keyup', ev => {
            if (ev.key === 'z') {
                if (this.state === 'rewinding') {
                    this.set_state('playing');
                }
            }

            if (this.key_mapping[ev.key]) {
                this.current_keys.delete(ev.key);
                ev.stopPropagation();
                ev.preventDefault();
            }
        });

        // When we lose focus, act as though every key was released, and pause the game
        window.addEventListener('blur', ev => {
            this.current_keys.clear();

            if (this.state === 'playing' || this.state === 'rewinding') {
                this.set_state('paused');
            }
        });

        // Populate input debugger
        this.input_el = this.root.querySelector('.input');
        this.input_action_elements = {};
        for (let [action, label] of Object.entries(ACTION_LABELS)) {
            let el = mk('span.input-action', {'data-action': action}, label);
            this.input_el.append(el);
            this.input_action_elements[action] = el;
        }

        this._advance_bound = this.advance.bind(this);
        this._redraw_bound = this.redraw.bind(this);
        // Used to determine where within a tic we are, for animation purposes
        this.tic_offset = 0;
        this.last_advance = 0;  // performance.now timestamp

        // Auto-size the level canvas on resize
        window.addEventListener('resize', ev => {
            this.adjust_scale();
        });

        // TODO yet another thing that should be in setup, but can't be because load_level is called
        // first
        this.sfx_player = new SFXPlayer;
    }

    setup() {
    }

    activate() {
        // We can't resize when we're not visible, so do it now
        super.activate();
        this.adjust_scale();
    }

    deactivate() {
        // End the level when going away; the easiest way is by restarting it
        // TODO could throw the level away entirely and create a new one on activate?
        super.deactivate();
        if (this.state !== 'waiting') {
            this.restart_level();
        }
    }

    load_game(stored_game) {
    }

    load_level(stored_level) {
        // Do this here because we care about the latest level played, not the latest level opened
        // in the editor or whatever
        let savefile = this.conductor.current_pack_savefile;
        savefile.current_level = stored_level.number;
        if (savefile.highest_level < stored_level.number) {
            savefile.highest_level = stored_level.number;
        }
        this.conductor.save_savefile();

        this.level = new Level(stored_level, this.compat);
        this.level.sfx = this.sfx_player;
        this.renderer.set_level(this.level);
        this.root.classList.toggle('--has-demo', !!this.level.stored_level.demo);
        // TODO base this on a hash of the UA + some identifier for the pack + the level index.  StoredLevel doesn't know its own index atm...
        this.change_music(this.conductor.level_index % SOUNDTRACK.length);
        this._clear_state();
    }

    restart_level() {
        this.level.restart(this.compat);
        this._clear_state();
    }

    // Call after loading or restarting a level
    _clear_state() {
        this.set_state('waiting');

        this.tic_offset = 0;
        this.last_advance = 0;
        this.demo_faucet = null;
        this.current_keyring = {};
        this.current_toolbelt = [];

        this.chips_el.classList.remove('--done');
        this.time_el.classList.remove('--frozen');
        this.time_el.classList.remove('--danger');
        this.time_el.classList.remove('--warning');
        this.root.classList.remove('--bonus-visible');

        this.update_ui();
        // Force a redraw, which won't happen on its own since the game isn't running
        this._redraw();
    }

    play_demo() {
        this.restart_level();
        this.demo_faucet = this.level.stored_level.demo[Symbol.iterator]();
        this.level.force_floor_direction = this.level.stored_level.demo.initial_force_floor_direction;
        // FIXME should probably start playback on first real input
        this.set_state('playing');
    }

    get_input() {
        if (this.demo_faucet) {
            let step = this.demo_faucet.next();
            if (step.done) {
                return new Set;
            }
            else {
                return step.value;
            }
        }
        else {
            // Convert input keys to actions.  This is only done now
            // because there might be multiple keys bound to one
            // action, and it still counts as pressed as long as at
            // least one key is held
            let input = new Set;
            for (let key of this.current_keys) {
                input.add(this.key_mapping[key]);
            }
            return input;
        }
    }

    advance_by(tics) {
        for (let i = 0; i < tics; i++) {
            let input = this.get_input();

            // Replica of CC2 input handling, based on experimentation
            // FIXME unclear how this should interact with undo when playing normally, and
            // definitely wrong when playing a replay; should this be in Level??
            if ((input.has('up') && input.has('down')) || (input.has('left') && input.has('right'))) {
                // If opposing keys are ever held, stop moving and forget our state
                this.primary_action = null;
                this.secondary_action = null;
            }
            else if (this.primary_action && input.has(this.primary_action)) {
                // Our primary action is locked in as long as it's held down, but check for a
                // newly pressed secondary action; remember, there can't be two opposing keys held,
                // because we already checked for that above, so this is only necessary if there's
                // not already a secondary action
                if (! this.secondary_action) {
                    for (let action of ['down', 'left', 'right', 'up']) {
                        if (action !== this.primary_action &&
                            input.has(action) && ! this.previous_input.has(action))
                        {
                            this.secondary_action = action;
                            break;
                        }
                    }
                }
            }
            else {
                // Either we weren't holding any keys, or we let go of our primary action; either
                // way, act like we're starting from scratch and check keys in priority order
                // TODO actually i'm not sure these are necessary if we check the player's facing
                // first?
                this.primary_action = null;
                this.secondary_action = null;

                // As a tiebreaker, first check if we're holding the key corresponding to the
                // player's facing direction
                let player_facing_action = DIRECTIONS[this.level.player.direction].action;
                if (input.has(player_facing_action)) {
                    this.primary_action = player_facing_action;
                }

                for (let action of ['down', 'left', 'right', 'up']) {
                    if (! input.has(action))
                        continue;

                    if (! this.primary_action) {
                        this.primary_action = action;
                    }
                    else if (action !== this.primary_action) {
                        // Note that because of the opposing keys check, there can never be more
                        // than two keys held down here
                        this.secondary_action = action;
                        break;
                    }
                }
            }

            this.previous_input = input;

            this.sfx_player.advance_tic();
            this.level.advance_tic(
                this.primary_action ? ACTION_DIRECTIONS[this.primary_action] : null,
                this.secondary_action ? ACTION_DIRECTIONS[this.secondary_action] : null,
                input.has('wait')
            );

            if (this.level.state !== 'playing') {
                // We either won or lost!
                this.set_state('stopped');
                break;
            }
        }
        this.update_ui();
    }

    // Main driver of the level; advances by one tic, then schedules itself to
    // be called again next tic
    advance() {
        if (this.state !== 'playing' && this.state !== 'rewinding') {
            this._advance_handle = null;
            return;
        }
        
        this.last_advance = performance.now();
        
        if (this.state === 'playing') {
            this.advance_by(1);
        }
        else if (this.state === 'rewinding') {
            if (this.level.undo_stack.length === 0) {
                // TODO detect if we hit the start of the level (rather than just running the undo
                // buffer dry) and change to 'waiting' instead
                // TODO pausing seems rude actually, it should just hover in-place?
                this._advance_handle = null;
                this.set_state('paused');
            }
            else {
                // Rewind by undoing one tic every tic
                this.level.undo();
                this.update_ui();
            }
        }
        
        if (this.level.waiting_for_input)
        {
			//freeze tic_offset in time so we don't try to interpolate to the next frame too soon
            this.tic_offset = 0;
        }
        
        let dt = 1000 / TICS_PER_SECOND;
        if (this.state === 'rewinding') {
            // Rewind faster than normal time
            dt *= 0.5;
        }
        this._advance_handle = window.setTimeout(this._advance_bound, dt);
    }

    // Redraws every frame, unless the game isn't running
    redraw() {
        // Calculate this here, not in _redraw, because that's called at weird
        // times when the game might not have actually advanced at all yet
        // TODO this is not gonna be right while pausing lol
        // TODO i'm not sure it'll be right when rewinding either
        // TODO or if the game's speed changes.  wow!
        if (this.level.waiting_for_input) {
            //freeze tic_offset in time
        }
        else
        {
            this.tic_offset = Math.min(0.9999, (performance.now() - this.last_advance) / 1000 / (1 / TICS_PER_SECOND));
            if (this.state === 'rewinding') {
                this.tic_offset = 1 - this.tic_offset;
            }
        }

        this._redraw();

        // Check for a stopped game *after* drawing, so that if the game ends, we still draw its
        // final result before stopping the draw loop
        // TODO for bonus points, also finish the player animation (but don't advance the game any further)
        if (this.state === 'playing' || this.state === 'rewinding') {
            this._redraw_handle = requestAnimationFrame(this._redraw_bound);
        }
        else {
            this._redraw_handle = null;
        }
    }

    // Actually redraw.  Used to force drawing outside of normal play
    _redraw() {
        this.renderer.draw(this.tic_offset);
    }

    render_inventory_tile(name) {
        if (! this._inventory_tiles[name]) {
            // TODO reuse the canvas for data urls
            let canvas = this.renderer.create_tile_type_canvas(name);
            this._inventory_tiles[name] = canvas.toDataURL();
        }
        return this._inventory_tiles[name];
    }

    update_ui() {
        this.pause_button.disabled = !(this.state === 'playing' || this.state === 'paused');
        this.restart_button.disabled = (this.state === 'waiting');

        // TODO can we do this only if they actually changed?
        this.chips_el.textContent = this.level.chips_remaining;
        if (this.level.chips_remaining === 0) {
            this.chips_el.classList.add('--done');
        }

        this.time_el.classList.toggle('--frozen', this.level.time_remaining === null || this.level.timer_paused);
        if (this.level.time_remaining === null) {
            this.time_el.textContent = '---';
        }
        else {
            this.time_el.textContent = Math.ceil(this.level.time_remaining / 20);
            this.time_el.classList.toggle('--warning', this.level.time_remaining < 30 * 20);
            this.time_el.classList.toggle('--danger', this.level.time_remaining < 10 * 20);
        }

        this.bonus_el.textContent = this.level.bonus_points;
        if (this.level.bonus_points > 0) {
            this.root.classList.add('--bonus-visible');
        }
        this.message_el.textContent = this.level.hint_shown ?? "";

        // Keys appear in a consistent order
        for (let [key, nodes] of Object.entries(this.inventory_key_nodes)) {
            let count = this.level.player.keyring[key] ?? 0;
            if (this.current_keyring[key] === count)
                continue;

            nodes.root.classList.toggle('--hidden', count <= 0);
            nodes.count.classList.toggle('--hidden', count <= 1);
            nodes.count.textContent = count;

            this.current_keyring[key] = count;
        }
        // Tools are whatever order we picked them up
        for (let [i, node] of this.inventory_tool_nodes.entries()) {
            let tool = this.level.player.toolbelt[i] ?? null;
            if (this.current_toolbelt[i] === tool)
                continue;

            node.classList.toggle('--hidden', tool === null);
            if (tool) {
                node.src = this.render_inventory_tile(tool);
            }

            this.current_toolbelt[i] = tool;
        }

        for (let action of Object.keys(ACTION_LABELS)) {
            this.input_action_elements[action].classList.toggle('--pressed', this.previous_input.has(action));
        }
    }

    toggle_pause() {
        if (this.state === 'paused') {
            this.set_state('playing');
        }
        else if (this.state === 'playing' || this.state === 'rewinding') {
            this.set_state('paused');
        }
    }

    // waiting: haven't yet pressed a key so the timer isn't going
    // playing: playing normally
    // paused: um, paused
    // rewinding: playing backwards
    // stopped: level has ended one way or another
    set_state(new_state) {
        if (new_state === this.state)
            return;

        this.state = new_state;

        // Populate the overlay
        let overlay_reason = '';
        let overlay_top = '';
        let overlay_middle = null;
        let overlay_bottom = '';
        let overlay_keyhint = '';
        if (this.state === 'waiting') {
            overlay_reason = 'waiting';
            overlay_middle = "Ready!";
        }
        else if (this.state === 'paused') {
            overlay_reason = 'paused';
            overlay_bottom = "/// paused ///";
            overlay_keyhint = "press P to resume";
        }
        else if (this.state === 'stopped') {
            if (this.level.state === 'failure') {
                overlay_reason = 'failure';
                overlay_top = "whoops";
                let obits = OBITUARIES[this.level.fail_reason] ?? OBITUARIES['generic'];
                overlay_bottom = random_choice(obits);
                overlay_keyhint = "press space to try again, or Z to rewind";
            }
            else {
                // We just beat the level!  Hey, that's cool.
                // Let's save the score while we're here.
                let level_number = this.level.stored_level.number;
                let level_index = level_number - 1;
                let scorecard = this.level.get_scorecard();
                let savefile = this.conductor.current_pack_savefile;
                let old_scorecard;
                if (! savefile.scorecards[level_index] ||
                    savefile.scorecards[level_index].score < scorecard.score)
                {
                    old_scorecard = savefile.scorecards[level_index];

                    // Adjust the total score
                    savefile.total_score = savefile.total_score ?? 0;
                    if (old_scorecard) {
                        savefile.total_score -= old_scorecard.score;
                    }
                    savefile.total_score += scorecard.score;

                    savefile.scorecards[level_index] = scorecard;
                    this.conductor.save_savefile();
                }

                overlay_reason = 'success';
                let base = level_number * 500;
                let time = scorecard.time * 10;
                // Pick a success message
                // TODO done on first try; took many tries
                let time_left_fraction = null;
                if (this.level.time_remaining !== null && this.level.stored_level.time_limit !== null) {
                    time_left_fraction = this.level.time_remaining / 20 / this.level.stored_level.time_limit;
                }

                if (this.level.chips_remaining > 0) {
                    overlay_top = random_choice([
                        "socket to em!", "go bug blaster!",
                    ]);
                }
                else if (this.level.time_remaining && this.level.time_remaining < 200) {
                    overlay_top = random_choice([
                        "in the nick of time!", "cutting it close!",
                    ]);
                }
                else if (time_left_fraction !== null && time_left_fraction > 1) {
                    overlay_top = random_choice([
                        "faster than light!", "impossible speed!", "pipelined!",
                    ]);
                }
                else if (time_left_fraction !== null && time_left_fraction > 0.75) {
                    overlay_top = random_choice([
                        "lightning quick!", "nice speedrun!", "eagerly evaluated!",
                    ]);
                }
                else {
                    overlay_top = random_choice([
                        "you did it!", "nice going!", "great job!", "good work!",
                        "onwards!", "tubular!", "yeehaw!", "hot damn!",
                        "alphanumeric!", "nice dynamic typing!", 
                    ]);
                }
                overlay_keyhint = "press space to move on";

                overlay_middle = mk('dl.score-chart',
                    mk('dt', "base score"),
                    mk('dd', base),
                    mk('dt', "time bonus"),
                    mk('dd', `+ ${time}`),
                );
                // It should be impossible to ever have a bonus and then drop back to 0 with CC2
                // rules; thieves can halve it, but the amount taken is rounded down.
                // That is to say, I don't need to track whether we ever got a score bonus
                if (this.level.bonus_points) {
                    overlay_middle.append(
                        mk('dt', "score bonus"),
                        mk('dd', `+ ${this.level.bonus_points}`),
                    );
                }
                else {
                    overlay_middle.append(mk('dt', ""), mk('dd', ""));
                }

                // TODO show your time, bold time...?
                overlay_middle.append(
                    mk('dt.-sum', "level score"),
                    mk('dd.-sum', `${scorecard.score} ${scorecard.aid === 0 ? '★' : ''}`),
                );

                if (old_scorecard) {
                    overlay_middle.append(
                        mk('dt', "improvement"),
                        mk('dd', `+ ${scorecard.score - old_scorecard.score}`),
                    );
                }
                else {
                    overlay_middle.append(mk('dt', ""), mk('dd', ""));
                }

                overlay_middle.append(
                    mk('dt', "total score"),
                    mk('dd', savefile.total_score),
                );
            }
        }
        this.overlay_message_el.setAttribute('data-reason', overlay_reason);
        this.overlay_message_el.querySelector('.-top').textContent = overlay_top;
        this.overlay_message_el.querySelector('.-bottom').textContent = overlay_bottom;
        this.overlay_message_el.querySelector('.-keyhint').textContent = overlay_keyhint;
        let middle = this.overlay_message_el.querySelector('.-middle');
        middle.textContent = '';
        if (overlay_middle) {
            middle.append(overlay_middle);
        }

        // Ask the renderer to apply a rewind effect only when rewinding, or when paused from
        // rewinding
        if (this.state === 'rewinding') {
            this.renderer.use_rewind_effect = true;
        }
        else if (this.state !== 'paused') {
            this.renderer.use_rewind_effect = false;
        }

        this.update_music_playback_state();

        // The advance and redraw methods run in a loop, but they cancel
        // themselves if the game isn't running, so restart them here
        if (this.state === 'playing' || this.state === 'rewinding') {
            if (! this._advance_handle) {
                this.advance();
            }
            if (! this._redraw_handle) {
                this.redraw();
            }
        }
    }

    // Music stuff

    change_music(index) {
        if (index === this.music_index)
            return;
        this.music_index = index;

        let track = SOUNDTRACK[index];
        this.music_audio_el.src = track.path;

        let title_el = this.music_el.querySelector('#player-music-title');
        title_el.textContent = track.title;
        if (track.beepbox) {
            title_el.setAttribute('href', track.beepbox);
        }
        else {
            title_el.removeAttribute('href');
        }

        let author_el = this.music_el.querySelector('#player-music-author');
        author_el.textContent = track.author;
        if (track.url) {
            author_el.setAttribute('href', track.url);
        }
        else if (track.twitter) {
            author_el.setAttribute('href', 'https://twitter.com/' + track.twitter);
        }
        else {
            author_el.removeAttribute('href');
        }
    }

    update_music_playback_state() {
        if (! this.music_enabled)
            return;

        // Audio tends to match the game state
        // TODO rewind audio when rewinding the game?  would need to use the audio api, so high effort low reward
        if (this.state === 'waiting') {
            this.music_audio_el.pause();
            this.music_audio_el.currentTime = 0;
        }
        if (this.state === 'playing' || this.state === 'rewinding') {
            this.music_audio_el.play();
        }
        else if (this.state === 'paused') {
            this.music_audio_el.pause();
        }
        else if (this.state === 'stopped') {
            this.music_audio_el.pause();
        }
    }

    // Auto-size the game canvas to fit the screen, if possible
    adjust_scale() {
        // TODO make this optional
        // The base size is the size of the canvas, i.e. the viewport size times the tile size --
        // but note that horizontally we have 4 extra tiles for the inventory
        // TODO if there's ever a portrait view for phones, this will need adjusting
        let base_x = this.conductor.tileset.size_x * (this.renderer.viewport_size_x + 4);
        let base_y = this.conductor.tileset.size_y * this.renderer.viewport_size_y;
        // The main UI is centered in a flex item with auto margins, so the
        // extra space available is the size of those margins
        let style = window.getComputedStyle(this.root);
        if (style['display'] === 'none') {
            // the computed margins can be 'auto' in this case
            return;
        }
        let extra_x = parseFloat(style['margin-left']) + parseFloat(style['margin-right']);
        let extra_y = parseFloat(style['margin-top']) + parseFloat(style['margin-bottom']);
        // The total available space, then, is the current size of the canvas (and inventory, when
        // appropriate) plus the size of the margins
        let total_x = extra_x + this.renderer.canvas.offsetWidth + this.inventory_el.offsetWidth;
        let total_y = extra_y + this.renderer.canvas.offsetHeight;
        let dpr = window.devicePixelRatio || 1.0;
        // Divide to find the biggest scale that still fits.  But don't
        // exceed 90% of the available space, or it'll feel cramped.
        let scale = Math.floor(0.9 * dpr * Math.min(total_x / base_x, total_y / base_y));
        if (scale <= 1) {
            scale = 1;
        }
        // High DPI support: scale the canvas down by the inverse of the device
        // pixel ratio, thus matching the canvas's resolution to the screen
        // resolution and giving us nice, clean pixels.
        scale /= dpr;

        this.scale = scale;
        this.root.style.setProperty('--scale', scale);
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
            navigator.clipboard.writeText(url);
            // TODO feedback?
        });
        this.main.append(copy_button);

        let ok = mk('button', {type: 'button'}, "neato");
        ok.addEventListener('click', ev => {
            this.close();
        });
        this.footer.append(ok);
    }
}

const EDITOR_TOOLS = [{
    mode: 'pencil',
    icon: 'icons/tool-pencil.png',
    name: "Pencil",
    desc: "Draw individual tiles",
/* TODO not implemented
}, {
    mode: 'line',
    icon: 'icons/tool-line.png',
    name: "Line",
    desc: "Draw straight lines",
}, {
    mode: 'box',
    icon: 'icons/tool-box.png',
    name: "Box",
    desc: "Fill a rectangular area with tiles",
}, {
    mode: 'fill',
    icon: 'icons/tool-fill.png',
    name: "Fill",
    desc: "Flood-fill an area with tiles",
*/
}, {
    mode: 'force-floors',
    icon: 'icons/tool-force-floors.png',
    name: "Force floors",
    desc: "Draw force floors in the direction you draw",
}, {
    mode: 'adjust',
    icon: 'icons/tool-adjust.png',
    name: "Adjust",
    desc: "Toggle blocks and rotate actors",
/* TODO not implemented
}, {
    mode: 'connect',
    icon: 'icons/tool-connect.png',
    name: "Connect",
    desc: "Set up CC1 clone and trap connections",
}, {
    mode: 'wire',
    icon: 'icons/tool-wire.png',
    name: "Wire",
    desc: "Draw CC2 wiring",
    // TODO text tool; thin walls tool; ice tool; map generator?; subtools for select tool (copy, paste, crop)
    // TODO interesting option: rotate an actor as you draw it by dragging?  or hold a key like in
    // slade when you have some selected?
    // TODO ah, railroads...
*/
}];
// Tiles the "adjust" tool will turn into each other
const EDITOR_ADJUST_TOGGLES = {
    floor_custom_green: 'wall_custom_green',
    floor_custom_pink: 'wall_custom_pink',
    floor_custom_yellow: 'wall_custom_yellow',
    floor_custom_blue: 'wall_custom_blue',
    wall_custom_green: 'floor_custom_green',
    wall_custom_pink: 'floor_custom_pink',
    wall_custom_yellow: 'floor_custom_yellow',
    wall_custom_blue: 'floor_custom_blue',
    fake_floor: 'fake_wall',
    fake_wall: 'fake_floor',
    wall_invisible: 'wall_appearing',
    wall_appearing: 'wall_invisible',
    green_floor: 'green_wall',
    green_wall: 'green_floor',
    green_bomb: 'green_chip',
    green_chip: 'green_bomb',
    purple_floor: 'purple_wall',
    purple_wall: 'purple_floor',
    thief_keys: 'thief_tools',
    thief_tools: 'thief_keys',
};
// TODO this MUST use a cc2 tileset!
const EDITOR_PALETTE = [{
    title: "Basics",
    tiles: [
        'player',
        'chip', 'chip_extra',
        'floor', 'wall', 'hint', 'socket', 'exit',
    ],
}, {
    title: "Terrain",
    tiles: [
        'popwall',
        'fake_floor', 'fake_wall',
        'wall_invisible', 'wall_appearing',
        'gravel',
        'dirt',
        'door_blue', 'door_red', 'door_yellow', 'door_green',
        'water', 'turtle', 'fire',
        'ice', 'ice_nw', 'ice_ne', 'ice_sw', 'ice_se',
        'force_floor_n', 'force_floor_s', 'force_floor_w', 'force_floor_e', 'force_floor_all',
    ],
}, {
    title: "Items",
    tiles: [
        'key_blue', 'key_red', 'key_yellow', 'key_green',
        'flippers', 'fire_boots', 'cleats', 'suction_boots',
    ],
}, {
    title: "Creatures",
    tiles: [
        'tank_blue',
        'ball',
        'fireball',
        'glider',
        'bug',
        'paramecium',
        'walker',
        'teeth',
        'blob',
    ],
}, {
    title: "Mechanisms",
    tiles: [
        'bomb',
        'dirt_block',
        'ice_block',
        'button_blue',
        'button_red', 'cloner',
        'button_brown', 'trap',
        'teleport_blue',
        'teleport_red',
        'teleport_green',
        'teleport_yellow',
    ],
}];
class Editor extends PrimaryView {
    constructor(conductor) {
        super(conductor, document.body.querySelector('main#editor'));

        // FIXME don't hardcode size here, convey this to renderer some other way
        this.renderer = new CanvasRenderer(this.conductor.tileset, 32);

        // FIXME need this in load_level which is called even if we haven't been setup yet
        this.connections_g = mk_svg('g');
    }

    setup() {
        // Level canvas and mouse handling
        // This SVG draws vectors on top of the editor, like monster paths and button connections
        // FIXME change viewBox in load_level, can't right now because order of ops
        this.svg_overlay = mk_svg('svg.level-editor-overlay', {viewBox: '0 0 32 32'}, this.connections_g);
        this.root.querySelector('.level').append(
            this.renderer.canvas,
            this.svg_overlay);
        this.mouse_mode = null;
        this.mouse_button = null;
        this.mouse_cell = null;
        this.renderer.canvas.addEventListener('mousedown', ev => {
            if (ev.button === 0) {
                // Left button: draw
                this.mouse_mode = 'draw';
                this.mouse_button_mask = 1;
                this.mouse_coords = [ev.clientX, ev.clientY];

                let [x, y] = this.renderer.cell_coords_from_event(ev);
                this.mouse_cell = [x, y];

                if (this.current_tool === 'pencil') {
                    this.place_in_cell(x, y, this.palette_selection);
                }
                else if (this.current_tool === 'force-floors') {
                    // Begin by placing an all-way force floor under the mouse
                    this.place_in_cell(x, y, 'force_floor_all');
                }
                else if (this.current_tool === 'adjust') {
                    let cell = this.stored_level.cells[y][x];
                    for (let tile of cell) {
                        // Toggle tiles that go in obvious pairs
                        let other = EDITOR_ADJUST_TOGGLES[tile.type.name];
                        if (other) {
                            tile.type = TILE_TYPES[other];
                        }

                        // Rotate actors
                        if (TILE_TYPES[tile.type.name].is_actor) {
                            tile.direction = DIRECTIONS[tile.direction ?? 'south'].right;
                        }
                    }
                }
                this.renderer.draw();
            }
            else if (ev.button === 1) {
                // Middle button: pan
                this.mouse_mode = 'pan';
                this.mouse_button_mask = 4;
                this.mouse_coords = [ev.clientX, ev.clientY];
                ev.preventDefault();
            }
        });
        this.renderer.canvas.addEventListener('mousemove', ev => {
            if (this.mouse_mode === null)
                return;
            // TODO check for the specific button we're holding
            if ((ev.buttons & this.mouse_button_mask) === 0) {
                this.mouse_mode = null;
                return;
            }

            if (this.mouse_mode === 'draw') {
                // FIXME also fill in a trail between previous cell and here, mousemove is not fired continuously
                let [x, y] = this.renderer.cell_coords_from_event(ev);
                if (x === this.mouse_cell[0] && y === this.mouse_cell[1])
                    return;

                // TODO do a pixel-perfect draw too
                if (this.current_tool === 'pencil') {
                    for (let [cx, cy] of walk_grid(this.mouse_cell[0], this.mouse_cell[1], x, y)) {
                        this.place_in_cell(cx, cy, this.palette_selection);
                    }
                }
                else if (this.current_tool === 'force-floors') {
                    // Walk the mouse movement and change each we touch to match the direction we
                    // crossed the border
                    // FIXME occasionally i draw a tetris S kinda shape and both middle parts point
                    // the same direction, but shouldn't
                    let i = 0;
                    let prevx, prevy;
                    for (let [cx, cy] of walk_grid(this.mouse_cell[0], this.mouse_cell[1], x, y)) {
                        i++;
                        // The very first cell is the one the mouse was already in, and we don't
                        // have a movement direction yet, so leave that alone
                        if (i === 1) {
                            prevx = cx;
                            prevy = cy;
                            continue;
                        }
                        let name;
                        if (cx === prevx) {
                            if (cy > prevy) {
                                name = 'force_floor_s';
                            }
                            else {
                                name = 'force_floor_n';
                            }
                        }
                        else {
                            if (cx > prevx) {
                                name = 'force_floor_e';
                            }
                            else {
                                name = 'force_floor_w';
                            }
                        }

                        // The second cell tells us the direction to use for the first, assuming it
                        // had some kind of force floor
                        if (i === 2) {
                            let prevcell = this.stored_level.cells[prevy][prevx];
                            if (prevcell[0].type.name.startsWith('force_floor_')) {
                                prevcell[0].type = TILE_TYPES[name];
                            }
                        }

                        // Drawing a loop with force floors creates ice (but not in the previous
                        // cell, obviously)
                        let cell = this.stored_level.cells[cy][cx];
                        if (cell[0].type.name.startsWith('force_floor_') &&
                            cell[0].type.name !== name)
                        {
                            name = 'ice';
                        }
                        this.place_in_cell(cx, cy, name);

                        prevx = cx;
                        prevy = cy;
                    }
                }
                else if (this.current_tool === 'adjust') {
                    // Adjust tool doesn't support dragging
                    // TODO should it
                }
                this.renderer.draw();

                this.mouse_cell = [x, y];
            }
            else if (this.mouse_mode === 'pan') {
                let dx = ev.clientX - this.mouse_coords[0];
                let dy = ev.clientY - this.mouse_coords[1];
                this.renderer.canvas.parentNode.scrollLeft -= dx;
                this.renderer.canvas.parentNode.scrollTop -= dy;
                this.mouse_coords = [ev.clientX, ev.clientY];
            }
        });
        this.renderer.canvas.addEventListener('mouseup', ev => {
            this.mouse_mode = null;
        });
        window.addEventListener('blur', ev => {
            // Unbind the mouse if the page loses focus
            this.mouse_mode = null;
        });

        // Toolbar buttons
        this.root.querySelector('#editor-share-url').addEventListener('click', ev => {
            let buf = c2m.synthesize_level(this.stored_level);
            // FIXME Not ideal, but btoa() wants a string rather than any of the myriad binary types
            let stringy_buf = Array.from(new Uint8Array(buf)).map(n => String.fromCharCode(n)).join('');
            // Make URL-safe and strip trailing padding
            let data = btoa(stringy_buf).replace(/[+]/g, '-').replace(/[/]/g, '_').replace(/=+$/, '');
            let url = new URL(location);
            url.searchParams.delete('level');
            url.searchParams.delete('setpath');
            url.searchParams.append('level', data);
            new EditorShareOverlay(this.conductor, url.toString()).open();
        });

        // Toolbox
        let toolbox = mk('div.icon-button-set')
        this.root.querySelector('.controls').append(toolbox);
        this.tool_button_els = {};
        for (let tooldef of EDITOR_TOOLS) {
            let button = mk(
                'button', {
                    type: 'button',
                    'data-tool': tooldef.mode,
                },
                mk('img', {
                    src: tooldef.icon,
                    alt: tooldef.name,
                    title: `${tooldef.name}: ${tooldef.desc}`,
                }),
            );
            this.tool_button_els[tooldef.mode] = button;
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

        // Tile palette
        let palette_el = this.root.querySelector('.palette');
        this.palette = {};  // name => element
        for (let sectiondef of EDITOR_PALETTE) {
            let section_el = mk('section');
            palette_el.append(mk('h2', sectiondef.title), section_el);
            for (let name of sectiondef.tiles) {
                let entry = this.renderer.create_tile_type_canvas(name);
                entry.setAttribute('data-tile-name', name);
                entry.classList = 'palette-entry';
                this.palette[name] = entry;
                section_el.append(entry);
            }
        }
        palette_el.addEventListener('click', ev => {
            let entry = ev.target.closest('canvas.palette-entry');
            if (! entry)
                return;

            this.select_palette(entry.getAttribute('data-tile-name'));
        });
        this.palette_selection = null;
        this.select_palette('floor');
    }

    activate() {
        super.activate();
        this.renderer.draw();
    }

    load_game(stored_game) {
    }

    load_level(stored_level) {
        // TODO support a game too i guess
        this.stored_level = stored_level;

        // XXX need this for renderer compat.  but i guess it's nice in general idk
        this.stored_level.cells = [];
        let row;
        for (let [i, cell] of this.stored_level.linear_cells.entries()) {
            if (i % this.stored_level.size_x === 0) {
                row = [];
                this.stored_level.cells.push(row);
            }
            row.push(cell);
        }

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

        this.renderer.set_level(stored_level);
        if (this.active) {
            this.renderer.draw();
        }
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

    select_palette(name) {
        if (name === this.palette_selection)
            return;

        if (this.palette_selection) {
            this.palette[this.palette_selection].classList.remove('--selected');
        }
        this.palette_selection = name;
        if (this.palette_selection) {
            this.palette[this.palette_selection].classList.add('--selected');
        }

        // Some tools obviously don't work with a palette selection, in which case changing tiles
        // should default you back to the pencil
        if (this.current_tool === 'adjust') {
            this.select_tool('pencil');
        }
    }

    place_in_cell(x, y, name) {
        // TODO weird api?
        if (! name)
            return;

        let type = TILE_TYPES[name];
        let cell = this.stored_level.cells[y][x];
        // For terrain tiles, erase the whole cell.  For other tiles, only
        // replace whatever's on the same layer
        // TODO probably not the best heuristic yet, since i imagine you can
        // combine e.g. the tent with thin walls
        if (type.draw_layer === 0) {
            cell.length = 0;
            cell.push({type});
        }
        else {
            for (let i = cell.length - 1; i >= 0; i--) {
                if (cell[i].type.draw_layer === type.draw_layer) {
                    cell.splice(i, 1);
                }
            }
            cell.push({type});
            cell.sort((a, b) => a.type.draw_layer - b.type.draw_layer);
        }
    }
}


const BUILTIN_LEVEL_PACKS = [{
    path: 'levels/CCLP1.ccl',
    ident: 'cclp1',
    title: "Chip's Challenge Level Pack 1",
    desc: "Designed and recommended for new players, starting with gentle introductory levels.  A prequel to the other packs.",
}, {
    path: 'levels/CCLP4.ccl',
    ident: 'cclp4',
    title: "Chip's Challenge Level Pack 4",
    desc: "Moderately difficult, but not unfair.",
}, {
    path: 'levels/CCLXP2.ccl',
    ident: 'cclxp2',
    title: "Chip's Challenge Level Pack 2-X",
    desc: "The first community pack released, tricky and rough around the edges.",
}, {
    path: 'levels/CCLP3.ccl',
    ident: 'cclp3',
    title: "Chip's Challenge Level Pack 3",
    desc: "A tough challenge, by and for veteran players.",
}];

class Splash extends PrimaryView {
    constructor(conductor) {
        super(conductor, document.body.querySelector('main#splash'));

        // Populate the list of available level packs
        let pack_list = document.querySelector('#splash-stock-levels');
        for (let packdef of BUILTIN_LEVEL_PACKS) {
            let score;
            let packinfo = conductor.stash.packs[packdef.ident];
            if (packinfo && packinfo.total_score !== undefined) {
                // TODO tack on a star if the game is "beaten"?  what's that mean?  every level
                // beaten i guess?
                score = packinfo.total_score.toLocaleString();
            }
            else {
                score = "unplayed";
            }

            let button = mk('button.button-big.level-pack-button',
                mk('h3', packdef.title),
                mk('p', packdef.desc),
                mk('span.-score', score),
            );
            button.addEventListener('click', ev => {
                this.fetch_pack(packdef.path, packdef.title);
            });
            pack_list.append(button);
        }

        // Bind to file upload control
        let upload_el = this.root.querySelector('#splash-upload');
        // Clear it out in case of refresh
        upload_el.value = '';
        this.root.querySelector('#splash-upload-button').addEventListener('click', ev => {
            upload_el.click();
        });
        upload_el.addEventListener('change', async ev => {
            let file = ev.target.files[0];
            let buf = await file.arrayBuffer();
            this.load_file(buf, this.extract_identifier_from_path(file.name));
            // TODO get title out of C2G when it's supported
            this.conductor.level_pack_name_el.textContent = file.name;
        });

        // Bind to "create level" button
        this.root.querySelector('#splash-create-level').addEventListener('click', ev => {
            let stored_level = new format_util.StoredLevel;
            stored_level.size_x = 32;
            stored_level.size_y = 32;
            for (let i = 0; i < 1024; i++) {
                let cell = new format_util.StoredCell;
                cell.push({type: TILE_TYPES['floor']});
                stored_level.linear_cells.push(cell);
            }
            stored_level.linear_cells[0].push({type: TILE_TYPES['player']});

            // FIXME definitely gonna need a name here chief
            let stored_game = new format_util.StoredGame(null);
            stored_game.levels.push(stored_level);
            this.conductor.load_game(stored_game);

            this.conductor.switch_to_editor();
        });
    }

    extract_identifier_from_path(path) {
        let ident = path.match(/^(?:.*\/)?[.]*([^.]+)(?:[.]|$)/)[1];
        if (ident) {
            return ident.toLowerCase();
        }
        else {
            return null;
        }
    }

    // TODO wait why aren't these just on conductor
    async fetch_pack(path, title) {
        // TODO indicate we're downloading something
        // TODO handle errors
        // TODO cancel a download if we start another one?
        let buf = await fetch(path);
        this.load_file(buf, this.extract_identifier_from_path(path));
        // TODO get title out of C2G when it's supported
        this.conductor.level_pack_name_el.textContent = title || path;
    }

    load_file(buf, identifier = null) {
        // TODO also support tile world's DAC when reading from local??
        // TODO ah, there's more metadata in CCX, crapola
        let magic = String.fromCharCode.apply(null, new Uint8Array(buf.slice(0, 4)));
        let stored_game;
        if (magic === 'CC2M' || magic === 'CCS ') {
            stored_game = new format_util.StoredGame;
            stored_game.levels.push(c2m.parse_level(buf));
            // Don't make a savefile for individual levels
            identifier = null;
        }
        else if (magic === '\xac\xaa\x02\x00' || magic == '\xac\xaa\x02\x01') {
            stored_game = dat.parse_game(buf);
        }
        else {
            throw new Error("Unrecognized file format");
        }
        this.conductor.load_game(stored_game, identifier);
        this.conductor.switch_to_player();
    }
}


// -------------------------------------------------------------------------------------------------
// Central controller, thingy

// About dialog
const ABOUT_HTML = `
<p>Welcome to Lexy's Labyrinth, an exciting old-school tile-based puzzle adventure that is compatible with — but legally distinct from! — <a href="https://store.steampowered.com/app/346850/Chips_Challenge_1/">Chip's Challenge</a> and its long-awaited sequel <a href="https://store.steampowered.com/app/348300/Chips_Challenge_2/">Chip's Challenge 2</a>.</p>
<p>This is a reimplementation from scratch of the game and uses none of its original code or assets.  It aims to match the behavior of the Steam releases (sans obvious bugs), since those are now the canonical versions of the game, but compatibility settings aren't off the table.</p>
<p>The default level pack is the community-made <a href="https://wiki.bitbusters.club/Chip%27s_Challenge_Level_Pack_1">Chip's Challenge Level Pack 1</a>, which I had no hand in whatsoever; please follow the link for full attribution.</p>
<p>Source code is on <a href="https://github.com/eevee/lexys-labyrinth">GitHub</a>.</p>
<p>Special thanks to:</p>
<ul class="normal-list">
    <li>The lovingly maintained <a href="https://bitbusters.club/">Bit Busters Club</a>, its incredibly detailed <a href="https://wiki.bitbusters.club/Main_Page">wiki</a>, and its <a href="https://discord.gg/Xd4dUY9">Discord</a> full of welcoming and patient folks who've been more than happy to playtest this thing and answer all kinds of arcane questions about Chip's Challenge mechanics.</li>
    <li><a href="https://tw2.bitbusters.club/">Tile World</a>, the original Chip's Challenge 1 emulator whose source code was indispensable.</li>
    <li>Everyone who contributed to the soundtrack, without whom there would still only be one song.</li>
    <li>Chuck Somerville, for creating the original game!</li>
</ul>
<p>Not affiliated with, endorsed by, aided by, or done with the permission of Chuck Somerville, Niffler Inc., or Alpha Omega Productions.</p>
`;
class AboutOverlay extends DialogOverlay {
    constructor(conductor) {
        super(conductor);
        this.set_title("about");
        this.main.innerHTML = ABOUT_HTML;
        this.add_button("cool", ev => {
            this.close();
        });
    }
}

// Options dialog
// functionality?:
// - store local levels and tilesets in localstorage?  (will duplicate space but i'll be able to remember them)
// aesthetics:
// - tileset
// - animations on or off
// compat:
// - flicking
// - that cc2 hook wrapping thing
// - that cc2 thing where a brown button sends a 1-frame pulse to a wired trap
// - cc2 something about blue teleporters at 0, 0 forgetting they're looking for unwired only
// - monsters go in fire
// - rff blocks monsters
// - rff truly random
// - all manner of fucking bugs
// TODO distinguish between deliberately gameplay changes and bugs, though that's kind of an arbitrary line
const AESTHETIC_OPTIONS = [{
    key: 'anim_half_speed',
    label: "Animate at half speed",
    default: true,
    note: "CC2 plays animations at utterly ludicrous speeds and it looks very bad.  This option plays them at half speed (except for explosions and splashes, which have a fixed duration), which is objectively better in every way.",
}, {
    key: 'offset_actors',
    label: "Offset some actors",
    default: true,
    note: "Chip's Challenge typically draws everything in a grid, which looks a bit funny for tall skinny objects like...  the player.  And teeth.  This option draws both of them raised up slightly, so they'll break the grid and add a slight 3D effect.  May not work for all tilesets.",
}];
const COMPAT_OPTIONS = [{
    key: 'tiles_react_instantly',
    label: "Tiles react instantly",
    impls: ['lynx', 'ms'],
    note: "In classic CC, actors moved instantly from one tile to another, so tiles would react (e.g., buttons would become pressed) instantly as well.  CC2 made actors slide smoothly between tiles, and it made more sense visually for the reactions to only happen once the sliding animation had finished.  That's technically a gameplay change, since it delays a lot of tile behavior for 4 tics (the time it takes most actors to move), so here's a compat option.  Works best in conjunction with disabling smooth scrolling; otherwise you'll see strange behavior like completing a level before actually stepping onto the exit.",
}];
const COMPAT_IMPLS = {
    lynx: "Lynx, the original version",
    ms: "Microsoft's Windows port",
    cc2bug: "Bug present in CC2",
};
const OPTIONS_TABS = [{
    name: 'aesthetic',
    label: "Aesthetics",
}, {
    name: 'compat',
    label: "Compatibility",
}];
class OptionsOverlay extends DialogOverlay {
    constructor(conductor) {
        super(conductor);
        this.root.classList.add('dialog-options');
        this.set_title("options");
        this.add_button("well alright then", ev => {
            this.close();
        });

        this.main.append(mk('p', "Sorry!  This stuff doesn't actually work yet."));

        let tab_strip = mk('nav.tabstrip');
        this.main.append(tab_strip);
        this.tab_links = {};
        this.tab_blocks = {};
        this.current_tab = 'aesthetic';
        for (let tabdef of OPTIONS_TABS) {
            let link = mk('a', {href: 'javascript:', 'data-tab': tabdef.name}, tabdef.label);
            link.addEventListener('click', ev => {
                ev.preventDefault();
                this.switch_tab(ev.target.getAttribute('data-tab'));
            });
            tab_strip.append(link);
            this.tab_links[tabdef.name] = link;
            let block = mk('section.tabblock');
            this.main.append(block);
            this.tab_blocks[tabdef.name] = block;

            if (tabdef.name === this.current_tab) {
                link.classList.add('--selected');
                block.classList.add('--selected');
            }
        }

        // Aesthetic tab
        this._add_options(this.tab_blocks['aesthetic'], AESTHETIC_OPTIONS);

        // Compat tab
        this.tab_blocks['compat'].append(
            mk('p', "If you don't know what any of these are for, you can pretty safely ignore them."),
            mk('p', "Changes won't take effect until you restart the level."),
        );
        this._add_options(this.tab_blocks['compat'], COMPAT_OPTIONS);
    }

    _add_options(root, options) {
        let ul = mk('ul');
        root.append(ul);
        for (let optdef of options) {
            let li = mk('li');
            let label = mk('label.option');
            label.append(mk('input', {type: 'checkbox', name: optdef.key}));
            if (optdef.impls) {
                for (let impl of optdef.impls) {
                    label.append(mk('img.compat-icon', {src: `icons/compat-${impl}.png`}));
                }
            }
            label.append(mk('span.option-label', optdef.label));
            let help_icon = mk('img.-help', {src: 'icons/help.png'});
            label.append(help_icon);
            let help_text = mk('p.option-help', optdef.note);
            li.append(label);
            li.append(help_text);
            ul.append(li);
            help_icon.addEventListener('click', ev => {
                help_text.classList.toggle('--visible');
            });
        }
    }

    switch_tab(tab) {
        if (this.current_tab === tab)
            return;

        this.tab_links[this.current_tab].classList.remove('--selected');
        this.tab_blocks[this.current_tab].classList.remove('--selected');
        this.current_tab = tab;
        this.tab_links[this.current_tab].classList.add('--selected');
        this.tab_blocks[this.current_tab].classList.add('--selected');
    }
}

// List of levels
class LevelBrowserOverlay extends DialogOverlay {
    constructor(conductor) {
        super(conductor);
        this.set_title("choose a level");
        let thead = mk('thead', mk('tr',
            mk('th', ""),
            mk('th', "Level"),
            mk('th', "Your time"),
            mk('th', mk('abbr', {
                title: "Actual time it took you to play the level, even on untimed levels, and ignoring any CC2 clock altering effects",
            }, "Real time")),
            mk('th', "Your score"),
        ));
        let tbody = mk('tbody');
        let table = mk('table.level-browser', thead, tbody);
        this.main.append(table);
        let savefile = conductor.current_pack_savefile;
        // TODO if i stop eagerloading everything in a .DAT then this will not make sense any more
        for (let [i, stored_level] of conductor.stored_game.levels.entries()) {
            let scorecard = savefile.scorecards[i];
            let score = "—", time = "—", abstime = "—";
            if (scorecard) {
                score = scorecard.score.toLocaleString();
                if (scorecard.aid === 0) {
                    score += '★';
                }

                if (scorecard.time === 0) {
                    // This level is untimed
                    time = "n/a";
                }
                else {
                    time = String(scorecard.time);
                }

                // Express absolute time as mm:ss, with two decimals on the seconds (which should be
                // able to exactly count a number of tics)
                abstime = `${Math.floor(scorecard.abstime / 20 / 60)}:${(scorecard.abstime / 20 % 60).toFixed(2)}`;
            }

            tbody.append(mk(i >= savefile.highest_level ? 'tr.--unvisited' : 'tr',
                {'data-index': i},
                mk('td.-number', i + 1),
                mk('td.-title', stored_level.title),
                mk('td.-time', time),
                mk('td.-time', abstime),
                mk('td.-score', score),
                // TODO show your time?  include 999 times for untimed levels (which i don't know at
                // this point whoops but i guess if the time is zero then that answers that)?  show
                // your wallclock time also?
                // TODO other stats??  num chips, time limit?  don't know that without loading all
                // the levels upfront though, which i currently do but want to stop doing
            ));
        }

        tbody.addEventListener('click', ev => {
            let tr = ev.target.closest('table.level-browser tr');
            if (! tr)
                return;

            let index = parseInt(tr.getAttribute('data-index'), 10);
            this.conductor.change_level(index);
            this.close();
        });

        this.add_button("nevermind", ev => {
            this.close();
        });
    }
}

// Central dispatcher of what we're doing and what we've got loaded
const STORAGE_KEY = "Lexy's Labyrinth";
const STORAGE_PACK_PREFIX = "Lexy's Labyrinth: ";
class Conductor {
    constructor(tileset) {
        this.stored_game = null;
        this.tileset = tileset;

        this.stash = JSON.parse(window.localStorage.getItem(STORAGE_KEY));
        // TODO more robust way to ensure this is shaped how i expect?
        if (! this.stash) {
            this.stash = {};
        }
        if (! this.stash.options) {
            this.stash.options = {};
        }
        if (! this.stash.packs) {
            this.stash.packs = {};
        }
        // Handy aliases
        this.options = this.stash.options;

        this.splash = new Splash(this);
        this.editor = new Editor(this);
        this.player = new Player(this);

        // Bind the header buttons
        document.querySelector('#main-about').addEventListener('click', ev => {
            new AboutOverlay(this).open();
        });
        document.querySelector('#main-options').addEventListener('click', ev => {
            new OptionsOverlay(this).open();
        });

        // Bind to the navigation headers, which list the current level pack
        // and level
        this.level_pack_name_el = document.querySelector('#level-pack-name');
        this.level_name_el = document.querySelector('#level-name');
        this.nav_prev_button = document.querySelector('#main-prev-level');
        this.nav_next_button = document.querySelector('#main-next-level');
        this.nav_choose_level_button = document.querySelector('#main-choose-level');
        this.nav_prev_button.addEventListener('click', ev => {
            // TODO confirm
            if (this.stored_game && this.level_index > 0) {
                this.change_level(this.level_index - 1);
            }
            ev.target.blur();
        });
        this.nav_next_button.addEventListener('click', ev => {
            // TODO confirm
            if (this.stored_game && this.level_index < this.stored_game.levels.length - 1) {
                this.change_level(this.level_index + 1);
            }
            ev.target.blur();
        });
        this.nav_choose_level_button.addEventListener('click', ev => {
            if (this.stored_game) {
                new LevelBrowserOverlay(this).open();
            }
            ev.target.blur();
        });
        document.querySelector('#main-change-pack').addEventListener('click', ev => {
            // TODO confirm
            this.switch_to_splash();
        });
        document.querySelector('#player-edit').addEventListener('click', ev => {
            // TODO should be able to jump to editor if we started in the
            // player too!  but should disable score tracking, have a revert
            // button, not be able to save over it, have a warning about
            // cheating...
            this.switch_to_editor();
        });
        document.querySelector('#editor-play').addEventListener('click', ev => {
            // Restart the level to ensure it takes edits into account
            // TODO need to finish thinking out the exact flow between editor/player and what happens when...
            this.player.restart_level();
            this.switch_to_player();
        });

        this.update_nav_buttons();
        this.switch_to_splash();
    }

    switch_to_splash() {
        if (this.current) {
            this.current.deactivate();
        }
        this.splash.activate();
        this.current = this.splash;
        document.body.setAttribute('data-mode', 'splash');
    }

    switch_to_editor() {
        if (this.current) {
            this.current.deactivate();
        }
        this.editor.activate();
        this.current = this.editor;
        document.body.setAttribute('data-mode', 'editor');
    }

    switch_to_player() {
        if (this.current) {
            this.current.deactivate();
        }
        this.player.activate();
        this.current = this.player;
        document.body.setAttribute('data-mode', 'player');
    }

    load_game(stored_game, identifier = null) {
        this.stored_game = stored_game;

        this._pack_identifier = identifier;
        this.current_pack_savefile = null;
        if (identifier !== null) {
            // TODO again, enforce something about the shape here
            this.current_pack_savefile = JSON.parse(window.localStorage.getItem(STORAGE_PACK_PREFIX + identifier));
        }
        if (! this.current_pack_savefile) {
            this.current_pack_savefile = {
                total_score: 0,
                current_level: 1,
                highest_level: 1,
                // level scorecard: { time, abstime, bonus, score, aid } or null
                scorecards: [],
            };
        }

        this.player.load_game(stored_game);
        this.editor.load_game(stored_game);

        this.change_level(0);
    }

    change_level(level_index) {
        this.level_index = level_index;
        this.stored_level = this.stored_game.levels[level_index];

        // FIXME do better
        this.level_name_el.textContent = `Level ${level_index + 1} — ${this.stored_level.title}`;

        document.title = `${PAGE_TITLE} - ${this.stored_level.title}`;
        this.update_nav_buttons();

        this.player.load_level(this.stored_level);
        this.editor.load_level(this.stored_level);
    }

    update_nav_buttons() {
        this.nav_choose_level_button.disabled = !this.stored_game;
        this.nav_prev_button.disabled = !this.stored_game || this.level_index <= 0;
        this.nav_next_button.disabled = !this.stored_game || this.level_index >= this.stored_game.levels.length;
    }

    save_stash() {
        window.localStorage.setItem(STORAGE_KEY, JSON.stringify(this.stash));
    }

    save_savefile() {
        if (! this._pack_identifier)
            return;

        window.localStorage.setItem(STORAGE_PACK_PREFIX + this._pack_identifier, JSON.stringify(this.current_pack_savefile));

        // Also remember the total score in the stash, if it changed, so we can read it without
        // having to parse every single one of these things
        let packinfo = this.stash.packs[this._pack_identifier];
        if (! packinfo || packinfo.total_score !== this.current_pack_savefile.total_score) {
            if (! packinfo) {
                packinfo = {};
                this.stash.packs[this._pack_identifier] = packinfo;
            }
            packinfo.total_score = this.current_pack_savefile.total_score;
            this.save_stash();
        }
    }
}


async function main() {
    let local = !! location.host.match(/localhost/);
    let query = new URLSearchParams(location.search);

    // Pick a tileset
    // These alternative ones only work locally for me for testing purposes, since they're part of
    // the commercial games!
    let tilesheet = new Image();
    let tilesize;
    let tilelayout;
    if (local && query.get('tileset') === 'ms') {
        tilesheet.src = 'tileset-ms.png';
        tilesize = 32;
        tilelayout = CC2_TILESET_LAYOUT;
    }
    else if (local && query.get('tileset') === 'steam') {
        tilesheet.src = 'tileset-steam.png';
        tilesize = 32;
        tilelayout = CC2_TILESET_LAYOUT;
    }
    else if (query.get('tileset') === 'tworld') {
        tilesheet.src = 'tileset-tworld.png';
        tilesize = 48;
        tilelayout = TILE_WORLD_TILESET_LAYOUT;
    }
    else {
        // Default to Lexy's Labyrinth tileset
        tilesheet.src = 'tileset-lexy.png';
        tilesize = 32;
        tilelayout = LL_TILESET_LAYOUT;
    }
    // TODO would be fabulous to not wait on this before creating conductor
    await tilesheet.decode();
    let tileset = new Tileset(tilesheet, tilelayout, tilesize, tilesize);

    let conductor = new Conductor(tileset);
    window._conductor = conductor;

    // Pick a level (set)
    // TODO error handling  :(
    let path = query.get('setpath');
    let b64level = query.get('level');
    if (path && path.match(/^levels[/]/)) {
        conductor.splash.fetch_pack(path);
    }
    else if (b64level) {
        // TODO all the more important to show errors!!
        // FIXME Not ideal, but atob() returns a string rather than any of the myriad binary types
        let stringy_buf = atob(b64level.replace(/-/g, '+').replace(/_/g, '/'));
        let buf = Uint8Array.from(stringy_buf, c => c.charCodeAt(0)).buffer;
        conductor.splash.load_file(buf);
    }
}

main();
