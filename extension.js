import GObject from 'gi://GObject';
import St from 'gi://St';
import Soup from 'gi://Soup';
import GLib from 'gi://GLib';
import Gio from 'gi://Gio';
import Pango from 'gi://Pango';
import Clutter from 'gi://Clutter';
import Meta from 'gi://Meta';
import Shell from 'gi://Shell';

import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';
import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as ModalDialog from 'resource:///org/gnome/shell/ui/modalDialog.js';

const API_URL = 'https://api.todoist.com/api/v1/tasks';

// Web fallback used to open a specific task (works even when the desktop
// app has no todoist:// URI handler registered). The task's numeric/string
// id alone is enough — Todoist's web app only reads the last path segment,
// the human-readable slug before it is optional and purely cosmetic.
const TODOIST_WEB_TASK_URL = id => `https://app.todoist.com/app/task/${id}`;

// The menu is noticeably wider than the default so it looks nicer and the
// text has to be truncated less often. The title wraps up to TITLE_MAX_LINES
// lines, and if that's still not enough, we truncate and add "…" at the end.
const TITLE_WRAP_WIDTH = 240;
const TITLE_MAX_LINES = 3;

// Timings for the "task completed" animation: a short green flash on the
// button, then the row slides away to the left and fades out, then the
// now-empty space collapses. The "task added" animation (see
// _animateTaskAdded) plays the slide/fade/collapse steps in reverse.
const COMPLETE_FLASH_MS = 180;
const COMPLETE_SLIDE_MS = 220;
const COMPLETE_COLLAPSE_MS = 160;
const COMPLETE_SLIDE_DISTANCE = 48;

// Muted opacity (0-255, Clutter scale) for the task metadata line (date,
// deadline), kept visibly dimmer than the task title.
const META_OPACITY = 150;

const pad2 = n => String(n).padStart(2, '0');

// Parses inline task metadata the same way it's typed in Todoist's own
// quick-add bar:
//   - "!!1".."!!4" sets the priority, using Todoist's own UI numbering
//     (1 = most urgent/red, 4 = default/no priority).
//   - "mm.dd.yyyy" sets the due date.
//   - "hh:mm" (24h) sets the due time; combined with a date if one is also
//     present, otherwise assumed to be today.
// Matched tokens are stripped out of the returned content.
function parseTaskInput(rawText) {
    let text = ` ${rawText.trim()} `;

    let priority = null;
    text = text.replace(/(\s)!!([1-4])(?=\s)/, (m, pre, uiLevel) => {
        priority = 5 - Number(uiLevel); // "!!1" (most urgent) -> API priority 4
        return pre;
    });

    let year = null, month = null, day = null;
    text = text.replace(/(\s)(\d{1,2})\.(\d{1,2})\.(\d{4})(?=\s)/, (m, pre, mm, dd, yyyy) => {
        const mi = Number(mm), di = Number(dd);
        if (mi >= 1 && mi <= 12 && di >= 1 && di <= 31) {
            month = mi;
            day = di;
            year = Number(yyyy);
            return pre;
        }
        return m; // doesn't look like a real date - leave it in the text
    });

    let hour = null, minute = null;
    text = text.replace(/(\s)([01]?\d|2[0-3]):([0-5]\d)(?=\s)/, (m, pre, hh, mi) => {
        hour = Number(hh);
        minute = Number(mi);
        return pre;
    });

    let dueDate = null;
    let dueDatetime = null;

    if (year !== null) {
        dueDate = `${year}-${pad2(month)}-${pad2(day)}`;
        if (hour !== null)
            dueDatetime = `${dueDate}T${pad2(hour)}:${pad2(minute)}:00`;
    } else if (hour !== null) {
        const today = new Date();
        dueDate = `${today.getFullYear()}-${pad2(today.getMonth() + 1)}-${pad2(today.getDate())}`;
        dueDatetime = `${dueDate}T${pad2(hour)}:${pad2(minute)}:00`;
    }

    return {
        content: text.trim().replace(/\s+/g, ' '),
        priority,
        dueDate: dueDatetime ? null : dueDate,
        dueDatetime,
    };
}

const isSameDay = (a, b) =>
    a && b &&
    a.getFullYear() === b.getFullYear() &&
    a.getMonth() === b.getMonth() &&
    a.getDate() === b.getDate();

// Text shown on the "Date" pill once a date is picked: "Today" / "Tomorrow"
// for those two, otherwise a short locale-aware date (year only if it's not
// the current one).
function formatPickedDate(date) {
    const today = new Date();
    if (isSameDay(date, today))
        return 'Today';
    const tomorrow = new Date(today.getFullYear(), today.getMonth(), today.getDate() + 1);
    if (isSameDay(date, tomorrow))
        return 'Tomorrow';
    const opts = {day: 'numeric', month: 'short'};
    if (date.getFullYear() !== today.getFullYear())
        opts.year = 'numeric';
    return new Intl.DateTimeFormat(undefined, opts).format(date);
}

// Small month-grid calendar shown as a popup right under the "Date" pill
// (a regular Shell PopupMenu, so it floats above the dialog, closes on
// outside click / Escape, and is positioned by the Shell itself).
//
// `onPick(date | null)` is called when a day is clicked, or "Clear" is
// pressed (null). The popup closes itself after a pick.
class DatePickerPopup {
    constructor(sourceButton, onPick) {
        this._onPick = onPick;
        this._signalConnections = [];
        this._gridConnections = [];
        this._selected = null;

        const now = new Date();
        this._viewYear = now.getFullYear();
        this._viewMonth = now.getMonth();

        this.menu = new PopupMenu.PopupMenu(sourceButton, 0.5, St.Side.TOP);
        this.menu.actor.add_style_class_name('todoist-calendar-menu');
        Main.uiGroup.add_child(this.menu.actor);
        this.menu.actor.hide();

        // The manager takes care of the modal grab (click outside / Esc
        // closes the popup) while the dialog itself stays open.
        this._manager = new PopupMenu.PopupMenuManager(sourceButton);
        this._manager.addMenu(this.menu);

        this._connect(this.menu, 'open-state-changed', (_menu, open) => {
            if (!open)
                return;
            // Always open on the month of the picked date (or today's).
            const base = this._selected ?? new Date();
            this._viewYear = base.getFullYear();
            this._viewMonth = base.getMonth();
            this._rebuildGrid();
        });

        const root = new St.BoxLayout({vertical: true, style_class: 'todoist-calendar'});

        // --- Month navigation ---
        const nav = new St.BoxLayout({style_class: 'todoist-calendar-nav'});
        nav.add_child(this._makeNavButton('go-previous-symbolic', () => this._shiftMonth(-1)));
        this._monthLabel = new St.Label({
            style_class: 'todoist-calendar-month',
            x_expand: true,
            x_align: Clutter.ActorAlign.CENTER,
            y_align: Clutter.ActorAlign.CENTER,
        });
        nav.add_child(this._monthLabel);
        nav.add_child(this._makeNavButton('go-next-symbolic', () => this._shiftMonth(1)));
        root.add_child(nav);

        // --- Weekday header + day grid (Monday first) ---
        this._layout = new Clutter.GridLayout({
            column_homogeneous: true,
            row_homogeneous: true,
        });
        this._grid = new St.Widget({
            style_class: 'todoist-calendar-grid',
            layout_manager: this._layout,
            x_expand: true,
        });
        root.add_child(this._grid);

        // --- Footer: Clear / Today ---
        const footer = new St.BoxLayout({style_class: 'todoist-calendar-footer'});
        const clearButton = new St.Button({
            label: 'Clear',
            style_class: 'todoist-calendar-footer-button',
            can_focus: true,
            track_hover: true,
        });
        this._connect(clearButton, 'clicked', () => this._pick(null));
        footer.add_child(clearButton);
        footer.add_child(new St.Widget({x_expand: true}));
        const todayButton = new St.Button({
            label: 'Today',
            style_class: 'todoist-calendar-footer-button',
            can_focus: true,
            track_hover: true,
        });
        this._connect(todayButton, 'clicked', () => this._pick(new Date()));
        footer.add_child(todayButton);
        root.add_child(footer);

        this.menu.box.add_child(root);
        this._rebuildGrid();
    }

    _makeNavButton(iconName, callback) {
        const button = new St.Button({
            style_class: 'todoist-calendar-nav-button',
            can_focus: true,
            track_hover: true,
            child: new St.Icon({icon_name: iconName, icon_size: 16}),
        });
        this._connect(button, 'clicked', callback);
        return button;
    }

    _connect(object, signal, callback) {
        const id = object.connect(signal, callback);
        this._signalConnections.push([object, id]);
        return id;
    }

    _connectGrid(object, signal, callback) {
        const id = object.connect(signal, callback);
        this._gridConnections.push([object, id]);
        return id;
    }

    _shiftMonth(delta) {
        const d = new Date(this._viewYear, this._viewMonth + delta, 1);
        this._viewYear = d.getFullYear();
        this._viewMonth = d.getMonth();
        this._rebuildGrid();
    }

    _rebuildGrid() {
        for (const [object, id] of this._gridConnections)
            object.disconnect(id);
        this._gridConnections = [];
        this._grid.destroy_all_children();

        this._monthLabel.text = new Intl.DateTimeFormat(undefined, {
            month: 'long',
            year: 'numeric',
        }).format(new Date(this._viewYear, this._viewMonth, 1));

        // Weekday names, Monday first (2024-01-01 was a Monday).
        const weekdayFormat = new Intl.DateTimeFormat(undefined, {weekday: 'short'});
        for (let i = 0; i < 7; i++) {
            this._layout.attach(new St.Label({
                text: weekdayFormat.format(new Date(2024, 0, 1 + i)),
                style_class: 'todoist-calendar-weekday',
                x_align: Clutter.ActorAlign.CENTER,
            }), i, 0, 1, 1);
        }

        // 6 weeks always, so the popup doesn't change height between months.
        const first = new Date(this._viewYear, this._viewMonth, 1);
        const offset = (first.getDay() + 6) % 7;
        const today = new Date();

        for (let i = 0; i < 42; i++) {
            const date = new Date(this._viewYear, this._viewMonth, 1 - offset + i);

            const classes = ['todoist-calendar-day'];
            if (date.getMonth() !== this._viewMonth)
                classes.push('todoist-calendar-day-other');
            if (isSameDay(date, today))
                classes.push('todoist-calendar-day-today');
            if (isSameDay(date, this._selected))
                classes.push('todoist-calendar-day-selected');

            const button = new St.Button({
                label: String(date.getDate()),
                style_class: classes.join(' '),
                can_focus: true,
                track_hover: true,
                x_expand: true,
                x_align: Clutter.ActorAlign.CENTER,
            });
            this._connectGrid(button, 'clicked', () => this._pick(date));
            this._layout.attach(button, i % 7, 1 + Math.floor(i / 7), 1, 1);
        }
    }

    _pick(date) {
        this._selected = date;
        this.menu.close(true);
        this._onPick(date);
    }

    setSelected(date) {
        this._selected = date;
    }

    toggle() {
        this.menu.toggle();
    }

    destroy() {
        for (const [object, id] of this._gridConnections)
            object.disconnect(id);
        this._gridConnections = [];
        for (const [object, id] of this._signalConnections)
            object.disconnect(id);
        this._signalConnections = [];
        this.menu.close(false);
        this._manager.removeMenu(this.menu);
        this.menu.destroy();
        this._manager = null;
        this.menu = null;
        this._onPick = null;
        this._grid = null;
        this._layout = null;
        this._monthLabel = null;
    }
}

// Small "Add task" popup, opened via the global keyboard shortcut. It's a
// lightweight modal dialog drawn by the Shell itself (like the built-in
// "Log Out" confirmation), not a separate OS window.
//
// `onSubmit(content, explicit, done)` is called on submit, where `explicit`
// carries whatever priority/date/time was picked with the pill buttons
// below the entry (each field is null if not picked - in that case
// whatever's typed inline in the content, e.g. "!!2", still applies).
const AddTaskDialog = GObject.registerClass(
class AddTaskDialog extends ModalDialog.ModalDialog {
    _init(onSubmit, extensionPath) {
        super._init({styleClass: 'todoist-add-task-dialog', destroyOnClose: true});
        this._signalConnections = [];

        // Keep the Shell's normal modal fade, while giving the dialog itself
        // a subtle spring-like settle as it appears.
        this.dialogLayout.set_pivot_point(0.5, 0.5);
        this.dialogLayout.translation_y = -130;
        this._connectOwned(this, 'button-press-event', (_actor, event) => {
            if (event.get_button() !== 1)
                return Clutter.EVENT_PROPAGATE;

            const [x, y] = event.get_coords();
            const [dialogX, dialogY] = this.dialogLayout.get_transformed_position();
            const [dialogWidth, dialogHeight] = this.dialogLayout.get_transformed_size();
            if (x < dialogX || x > dialogX + dialogWidth ||
                y < dialogY || y > dialogY + dialogHeight) {
                this.close();
                return Clutter.EVENT_STOP;
            }
            return Clutter.EVENT_PROPAGATE;
        });

        this._onSubmit = onSubmit;
        this._priorityLevel = 0; // 0 = none, 1..4 = P1..P4
        this._selectedDate = null; // null = none, else the Date picked in the calendar popup
        this._attachment = null;

        const content = new St.BoxLayout({vertical: true, style_class: 'todoist-add-task-content'});

        const brandRow = new St.BoxLayout({
            vertical: false,
            style_class: 'todoist-add-task-brand-row',
            x_expand: true,
        });
        brandRow.add_child(new St.Widget({x_expand: true}));
        brandRow.add_child(new St.Icon({
            gicon: Gio.icon_new_for_string(
                GLib.build_filenamev([extensionPath, 'images', 'logo.svg'])),
            icon_size: 18,
            style_class: 'todoist-add-task-brand-logo',
        }));
        content.add_child(brandRow);

        // --- Task entry ---
        this._entry = new St.Entry({
            style_class: 'todoist-add-task-entry',
            hint_text: 'Task name',
            can_focus: true,
        });
        this._entry.clutter_text.set_single_line_mode(false);
        this._entry.clutter_text.set_line_wrap(true);
        this._entry.clutter_text.set_line_wrap_mode(Pango.WrapMode.WORD_CHAR);
        // Note: with single-line-mode off (needed for wrapping), ClutterText
        // no longer fires 'activate' on Enter - it would just insert a
        // newline instead. So Enter/Escape are both handled here directly.
        this._connectOwned(this._entry.clutter_text, 'key-press-event', (actor, event) => {
            const symbol = event.get_key_symbol();
            if (symbol === Clutter.KEY_Return || symbol === Clutter.KEY_KP_Enter) {
                this._submit();
                return Clutter.EVENT_STOP;
            }
            if (symbol === Clutter.KEY_Escape) {
                this.close();
                return Clutter.EVENT_STOP;
            }
            return Clutter.EVENT_PROPAGATE;
        });

        this._connectOwned(this._entry, 'button-press-event', () => {
            this._entry.grab_key_focus();
            return Clutter.EVENT_PROPAGATE;
        });

        // No scrolling: the entry just wraps as it grows, and the dialog
        // (a plain vertical layout) grows taller right along with it.
        content.add_child(this._entry);

        // --- Options row: priority / date / time pickers, plus the submit
        // button on the right. ---
        const optionsRow = new St.BoxLayout({
            vertical: false,
            style_class: 'todoist-add-task-options-row',
            x_expand: true,
        });

        this._attachmentButton = this._makeOptionButton('mail-attachment-symbolic', 'Attach');
        this._attachmentButton.add_style_class_name('todoist-add-task-attachment-button');
        this._connectOwned(this._attachmentButton, 'clicked', () => this._chooseAttachment());
        optionsRow.add_child(this._attachmentButton);

        this._priorityButton = this._makeOptionButton('starred-symbolic', 'Priority');
        this._connectOwned(this._priorityButton, 'clicked', () => this._cyclePriority());
        optionsRow.add_child(this._priorityButton);

        this._dateButton = this._makeOptionButton('x-office-calendar-symbolic', 'Date');
        this._datePicker = new DatePickerPopup(this._dateButton, date => this._setDate(date));
        this._connectOwned(this._dateButton, 'clicked', () => this._datePicker.toggle());
        optionsRow.add_child(this._dateButton);

        this._timeEntry = new St.Entry({
            style_class: 'todoist-add-task-time-entry',
            hint_text: 'hh:mm',
            can_focus: true,
        });
        this._timeEntry.clutter_text.set_max_length(5);
        this._connectOwned(this._timeEntry, 'button-press-event', () => {
            this._timeEntry.grab_key_focus();
            return Clutter.EVENT_PROPAGATE;
        });
        const timeControl = new St.BoxLayout({
            vertical: false,
            style_class: 'todoist-add-task-time-control',
            y_align: Clutter.ActorAlign.CENTER,
        });
        timeControl.add_child(new St.Icon({
            icon_name: 'preferences-system-time-symbolic',
            icon_size: 14,
            style_class: 'todoist-add-task-option-icon',
        }));
        timeControl.add_child(this._timeEntry);
        optionsRow.add_child(timeControl);

        optionsRow.add_child(new St.Widget({x_expand: true}));

        this._addButton = new St.Button({
            style_class: 'todoist-add-task-submit',
            can_focus: true,
            track_hover: true,
            y_align: Clutter.ActorAlign.CENTER,
        });
        this._addButton.child = new St.Icon({icon_name: 'go-up-symbolic', icon_size: 16});
        this._connectOwned(this._addButton, 'clicked', () => this._submit());
        optionsRow.add_child(this._addButton);

        content.add_child(optionsRow);
        this.contentLayout.add_child(content);

        this.setInitialKeyFocus(this._entry);
    }

    _connectOwned(object, signal, callback) {
        const id = object.connect(signal, callback);
        this._signalConnections.push([object, id]);
        return id;
    }

    destroy() {
        for (const [object, id] of this._signalConnections)
            object.disconnect(id);
        this._signalConnections = [];
        this._datePicker?.destroy();
        this._datePicker = null;
        for (const name of ['_entry', '_timeEntry', '_addButton', '_attachmentButton',
            '_priorityButton', '_dateButton']) {
            this[name]?.destroy();
            this[name] = null;
        }
        this._attachment = null;
        this._onSubmit = null;
        super.destroy();
    }

    _makeOptionButton(iconName, defaultLabel) {
        const button = new St.Button({
            style_class: 'todoist-add-task-option-button',
            can_focus: true,
            track_hover: true,
        });
        const box = new St.BoxLayout({
            vertical: false,
            style_class: 'todoist-add-task-option-button-content',
        });
        box.add_child(new St.Icon({
            icon_name: iconName,
            icon_size: 14,
            style_class: 'todoist-add-task-option-icon',
        }));
        const label = new St.Label({
            text: defaultLabel,
            y_align: Clutter.ActorAlign.CENTER,
        });
        box.add_child(label);
        button.child = box;
        button._label = label;
        button._defaultLabel = defaultLabel;
        return button;
    }

    _chooseAttachment() {
        // The Shell's modal grab keeps this dialog above the portal window.
        // Temporarily release the grab and hide the dialog so the system
        // file chooser can receive focus, then restore both on response.
        this.popModal();
        this.hide();

        const token = `todoist_${GLib.uuid_string_random().replaceAll('-', '')}`;
        let requestPath = null;
        let earlyResponse = null;
        const subscription = Gio.DBus.session.signal_subscribe(
            'org.freedesktop.portal.Desktop',
            'org.freedesktop.portal.Request',
            'Response',
            null,
            null,
            Gio.DBusSignalFlags.NONE,
            (_connection, _sender, objectPath, _interface, _signal, parameters) => {
                if (objectPath !== requestPath) {
                    earlyResponse = {objectPath, parameters};
                    return;
                }
                this._finishAttachmentChooser(parameters);
                Gio.DBus.session.signal_unsubscribe(subscription);
            }
        );

        Gio.DBus.session.call(
            'org.freedesktop.portal.Desktop',
            '/org/freedesktop/portal/desktop',
            'org.freedesktop.portal.FileChooser',
            'OpenFile',
            new GLib.Variant('(ssa{sv})', [
                '',
                'Attach a document',
                {
                    handle_token: new GLib.Variant('s', token),
                    modal: new GLib.Variant('b', true),
                },
            ]),
            new GLib.VariantType('(o)'),
            Gio.DBusCallFlags.NONE,
            -1,
            null,
            (connection, result) => {
                try {
                    [requestPath] = connection.call_finish(result).deep_unpack();
                    if (earlyResponse?.objectPath === requestPath) {
                        this._finishAttachmentChooser(earlyResponse.parameters);
                        Gio.DBus.session.signal_unsubscribe(subscription);
                    }
                } catch (e) {
                    Gio.DBus.session.signal_unsubscribe(subscription);
                    this._restoreAfterAttachmentChooser();
                    Main.notify('Todoist for GNOME', `Could not open the file picker: ${e.message}`);
                }
            }
        );
    }

    _finishAttachmentChooser(parameters) {
        this._handleAttachmentChooserResponse(parameters);
        this._restoreAfterAttachmentChooser();
    }

    _restoreAfterAttachmentChooser() {
        this.show();
        this.pushModal();
    }

    _handleAttachmentChooserResponse(parameters) {
        const [response, results] = parameters.deep_unpack();
        if (response !== 0)
            return;

        const uris = results.uris?.deep_unpack?.() ?? results.uris;
        const uri = uris?.[0];
        if (!uri)
            return;
        this._attachment = Gio.File.new_for_uri(uri);
        this._setOptionLabel(this._attachmentButton, this._attachment.get_basename());
    }

    _setOptionLabel(button, text) {
        button._label.text = text || button._defaultLabel;
    }

    _cyclePriority() {
        this._priorityLevel = (this._priorityLevel + 1) % 5;

        for (let i = 1; i <= 4; i++)
            this._priorityButton.remove_style_class_name(`todoist-priority-p${i}`);

        if (this._priorityLevel === 0) {
            this._setOptionLabel(this._priorityButton, null);
        } else {
            this._setOptionLabel(this._priorityButton, `P${this._priorityLevel}`);
            this._priorityButton.add_style_class_name(`todoist-priority-p${this._priorityLevel}`);
        }
    }

    _setDate(date) {
        this._selectedDate = date;
        this._datePicker.setSelected(date);

        if (!date) {
            this._setOptionLabel(this._dateButton, null);
            this._dateButton.remove_style_class_name('todoist-add-task-option-button-active');
            return;
        }

        this._setOptionLabel(this._dateButton, formatPickedDate(date));
        this._dateButton.add_style_class_name('todoist-add-task-option-button-active');
    }

    open() {
        if (this.state === ModalDialog.State.OPENED ||
            this.state === ModalDialog.State.OPENING)
            return super.open();

        this.dialogLayout.scale_x = 0.94;
        this.dialogLayout.scale_y = 0.94;
        const opened = super.open();
        if (opened) {
            this.dialogLayout.ease({
                scale_x: 1,
                scale_y: 1,
                duration: 260,
                mode: Clutter.AnimationMode.EASE_OUT_BACK,
            });
        }
        return opened;
    }

    _submit() {
        const text = this._entry.get_text().trim();
        if (!text)
            return;

        const timeText = this._timeEntry.get_text().trim();
        let time = null;
        if (timeText) {
            const match = timeText.match(/^([01]?\d|2[0-3]):([0-5]\d)$/);
            if (!match) {
                Main.notify('Todoist for GNOME', 'Time must be in hh:mm format.');
                this._timeEntry.grab_key_focus();
                return;
            }
            time = {hour: Number(match[1]), minute: Number(match[2])};
        }

        this._entry.reactive = false;
        this._addButton.reactive = false;

        const explicit = {
            priority: this._priorityLevel > 0 ? (5 - this._priorityLevel) : null,
            dueDate: null,
            dueDatetime: null,
        };

        if (this._selectedDate || time) {
            const date = this._selectedDate ?? new Date();
            const isoDate = `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}`;

            if (time)
                explicit.dueDatetime = `${isoDate}T${pad2(time.hour)}:${pad2(time.minute)}:00`;
            else
                explicit.dueDate = isoDate;
        }

        this._onSubmit(text, explicit, ok => {
            if (ok) {
                this.close();
            } else {
                this._entry.reactive = true;
                this._addButton.reactive = true;
                this._entry.grab_key_focus();
            }
        }, this._attachment);
    }
});

const TodoistIndicator = GObject.registerClass(
class TodoistIndicator extends PanelMenu.Button {
    _init(extension, settings) {
        super._init(0.0, 'Todoist Tasks', false);

        this._extension = extension;
        this._settings = settings;
        this._pendingSources = new Set();
        this._pendingHighlightId = null;
        this._signalConnections = [];

        const icon = new St.Icon({
            gicon: Gio.icon_new_for_string(
                GLib.build_filenamev([extension.path, 'images', 'logo.svg'])),
            icon_size: 16,
            style_class: 'system-status-icon',
        });
        this.add_child(icon);

        this._session = new Soup.Session();

        this.menu.box.add_style_class_name('todoist-menu-box');

        // Small header with the Todoist logo, top-left of the menu.
        this.menu.addMenuItem(this._buildHeader());

        this._taskSection = new PopupMenu.PopupMenuSection();
        this.menu.addMenuItem(this._taskSection);

        // Quick-add row: a text field plus a button, sitting right before
        // the "Open Todoist" / "Open Settings" items.
        this.menu.addMenuItem(this._buildQuickAddRow());

        this.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());

        this._openAppItem = new PopupMenu.PopupMenuItem('Open Todoist');
        this._connectOwned(this._openAppItem, 'activate', () => this._openApp());
        this.menu.addMenuItem(this._openAppItem);

        this._settingsItem = new PopupMenu.PopupMenuItem('Open Settings');
        this._connectOwned(this._settingsItem, 'activate', () => this._extension.openPreferences());
        this.menu.addMenuItem(this._settingsItem);

        // Tasks are fetched every time the menu is opened, not just once on
        // enable(). On close we clear the items right away so stale data
        // doesn't flash on the next open.
        this._connectOwned(this.menu, 'open-state-changed', (menu, isOpen) => {
            if (isOpen)
                this._loadTasks();
            else
                this._taskSection.removeAll();
        });

        this._addPlaceholder('Click to load tasks');
    }

    _connectOwned(object, signal, callback) {
        const id = object.connect(signal, callback);
        this._signalConnections.push([object, id]);
        return id;
    }

    _buildHeader() {
        const header = new PopupMenu.PopupBaseMenuItem({reactive: false, can_focus: false});
        header.add_style_class_name('todoist-header');

        const box = new St.BoxLayout({vertical: false});

        const logo = new St.Icon({
            gicon: Gio.icon_new_for_string(
                GLib.build_filenamev([this._extension.path, 'images', 'logo.svg'])),
            icon_size: 32,
            style_class: 'logo-icon',
        });
        box.add_child(logo);

        const label = new St.Label({
            text: 'Todoist for GNOME',
            style_class: 'todoist-header-label',
            y_align: Clutter.ActorAlign.CENTER,
        });
        box.add_child(label);

        header.add_child(box);
        return header;
    }

    _buildQuickAddRow() {
        const item = new PopupMenu.PopupBaseMenuItem({reactive: false, can_focus: false});
        item.add_style_class_name('todoist-quickadd-row');

        const box = new St.BoxLayout({vertical: false, x_expand: true});

        const entry = new St.Entry({
            style_class: 'todoist-quickadd-entry',
            hint_text: 'Add a task...',
            can_focus: true,
            x_expand: true,
        });
        entry.clutter_text.set_activatable(true);
        this._quickAddEntry = entry;
        this._connectOwned(entry.clutter_text, 'activate', () => this._quickAddTask(entry));
        box.add_child(entry);

        const addButton = new St.Button({
            style_class: 'todoist-quickadd-button',
            can_focus: true,
            track_hover: true,
            y_align: Clutter.ActorAlign.CENTER,
        });
        addButton.child = new St.Icon({icon_name: 'list-add-symbolic', icon_size: 14});
        this._quickAddButton = addButton;
        this._connectOwned(addButton, 'clicked', () => this._quickAddTask(entry));
        box.add_child(addButton);

        item.add_child(box);
        return item;
    }

    _quickAddTask(entry) {
        const content = entry.get_text().trim();
        if (!content)
            return;

        entry.reactive = false;
        this._createTask(content, ok => {
            entry.reactive = true;
            if (ok) {
                entry.set_text('');
                entry.grab_key_focus();
            }
        });
    }

    // Shared by both ways of adding a task (the in-menu quick-add row and
    // the global-shortcut dialog). `explicit` carries priority/date/time
    // picked via the dialog's pill buttons, if any - it wins over whatever
    // is typed inline in `content` (e.g. "!!2", "12.31.2026", "18:00").
    // `callback(ok)` is called once we know whether the task was created.
    _createTask(content, callback, explicit = {}, attachment = null) {
        if (!this._session) {
            Main.notify('Todoist for GNOME', 'The extension was reloaded. Reopen the dialog and try again.');
            callback?.(false);
            return;
        }

        const token = this._settings.get_string('api-token');
        if (!token) {
            Main.notify('Todoist for GNOME', 'No token set. Open the extension settings.');
            callback?.(false);
            return;
        }

        const parsed = parseTaskInput(content);
        if (!parsed.content) {
            callback?.(false);
            return;
        }

        const payload = {content: parsed.content};

        const priority = explicit.priority ?? parsed.priority;
        if (priority)
            payload.priority = priority;

        if (explicit.dueDatetime)
            payload.due_datetime = explicit.dueDatetime;
        else if (explicit.dueDate)
            payload.due_date = explicit.dueDate;
        else if (parsed.dueDatetime)
            payload.due_datetime = parsed.dueDatetime;
        else if (parsed.dueDate)
            payload.due_date = parsed.dueDate;

        const message = Soup.Message.new('POST', API_URL);
        message.request_headers.append('Authorization', `Bearer ${token}`);
        const body = new TextEncoder().encode(JSON.stringify(payload));
        message.set_request_body_from_bytes('application/json', new GLib.Bytes(body));

        this._session.send_and_read_async(
            message,
            GLib.PRIORITY_DEFAULT,
            null,
            (session, result) => {
                let bytes;
                try {
                    bytes = session.send_and_read_finish(result);
                } catch (e) {
                    Main.notify('Todoist for GNOME', `Failed to add the task: ${e.message}`);
                    callback?.(false);
                    return;
                }

                const status = message.get_status();
                if (status === Soup.Status.OK || status === Soup.Status.CREATED) {
                    let newTaskId = null;
                    try {
                        const text = new TextDecoder('utf-8').decode(bytes.get_data());
                        newTaskId = JSON.parse(text)?.id ?? null;
                    } catch (e) {
                        // Task was still created even if we couldn't parse
                        // the response - we just skip the "just added"
                        // animation below in that case.
                    }

                    if (this.menu.isOpen)
                        this._loadTasks(newTaskId);
                    if (attachment && newTaskId) {
                        // The task is already safely created. Close the modal
                        // now and upload the document in the background so a
                        // large or slow file cannot hold the UI hostage.
                        callback?.(true);
                        Main.notify('Todoist for GNOME', 'Task created. Uploading document…');
                        this._uploadTaskAttachment(attachment, newTaskId);
                    }
                    else {
                        if (attachment)
                            Main.notify('Todoist for GNOME', 'Task created, but its document could not be attached.');
                        callback?.(true);
                    }
                } else {
                    Main.notify('Todoist for GNOME', `Failed to add the task (HTTP ${status})`);
                    callback?.(false);
                }
            }
        );
    }

    _uploadTaskAttachment(file, taskId) {
        const token = this._settings.get_string('api-token');
        const fail = message => {
            Main.notify('Todoist for GNOME', `Task created, but the document could not be attached: ${message}`);
        };

        if (!this._session) {
            fail('The extension was reloaded before the upload started.');
            return;
        }

        file.load_contents_async(null, (source, result) => {
            let contents;
            try {
                const [loaded, data] = source.load_contents_finish(result);
                if (!loaded) {
                    fail('Could not read the selected document.');
                    return;
                }
                contents = data;
            } catch (e) {
                fail(e.message);
                return;
            }

            const filename = file.get_basename();
            const [contentType] = Gio.content_type_guess(filename, contents);
            const mimeType = Gio.content_type_get_mime_type(contentType) ?? 'application/octet-stream';
            const upload = Soup.Message.new('POST', 'https://api.todoist.com/api/v1/uploads');
            upload.request_headers.append('Authorization', `Bearer ${token}`);
            upload.request_headers.append('X-File-Name', filename.replace(/[\r\n]/g, ' '));
            upload.set_request_body_from_bytes(mimeType, new GLib.Bytes(contents));

            this._session.send_and_read_async(upload, GLib.PRIORITY_DEFAULT, null, (session, uploadResult) => {
                let uploadBytes;
                try {
                    uploadBytes = session.send_and_read_finish(uploadResult);
                } catch (e) {
                    fail(e.message);
                    return;
                }
                if (upload.get_status() < 200 || upload.get_status() >= 300) {
                    fail(`Todoist upload returned HTTP ${upload.get_status()}`);
                    return;
                }

                let attachment;
                try {
                    attachment = JSON.parse(new TextDecoder('utf-8').decode(uploadBytes.get_data()));
                } catch (e) {
                    fail('Todoist returned an unreadable upload response');
                    return;
                }

                if (!attachment.file_url) {
                    fail('Todoist did not return a URL for the uploaded file');
                    return;
                }

                const comment = Soup.Message.new('POST', 'https://api.todoist.com/api/v1/comments');
                comment.request_headers.append('Authorization', `Bearer ${token}`);
                const commentBody = {
                    task_id: taskId,
                    content: `📎 ${attachment.file_name ?? filename}`,
                    attachment: {
                        file_name: attachment.file_name ?? filename,
                        file_type: attachment.file_type ?? mimeType,
                        file_url: attachment.file_url,
                        resource_type: attachment.resource_type ?? 'file',
                    },
                };
                comment.set_request_body_from_bytes('application/json', new GLib.Bytes(
                    new TextEncoder().encode(JSON.stringify(commentBody))));
                this._session.send_and_read_async(comment, GLib.PRIORITY_DEFAULT, null, (commentSession, commentResult) => {
                    let commentBytes;
                    try {
                        commentBytes = commentSession.send_and_read_finish(commentResult);
                    } catch (e) {
                        fail(e.message);
                        return;
                    }
                    if (comment.get_status() < 200 || comment.get_status() >= 300) {
                        const responseText = new TextDecoder('utf-8').decode(commentBytes.get_data());
                        let detail = responseText;
                        try {
                            const error = JSON.parse(responseText);
                            detail = error.error ?? error.message ?? responseText;
                        } catch (e) {
                            // Keep Todoist's response text for actionable errors.
                        }
                        fail(`Todoist rejected the attachment (HTTP ${comment.get_status()}): ${detail.slice(0, 300)}`);
                        return;
                    }

                    let createdComment;
                    try {
                        createdComment = JSON.parse(new TextDecoder('utf-8').decode(commentBytes.get_data()));
                    } catch (e) {
                        fail('Todoist accepted the request but returned an unreadable comment response');
                        return;
                    }
                    if (!createdComment.file_attachment?.file_url) {
                        fail('Todoist created no file attachment on the task comment');
                        return;
                    }
                    Main.notify('Todoist for GNOME', `Attached ${createdComment.file_attachment.file_name ?? filename} to the task comment.`);
                });
            });
        });
    }

    showAddTaskDialog() {
        // Wrapped in try/catch so that if building the dialog ever throws,
        // the failure surfaces as a notification instead of just doing
        // nothing (that's how we caught the two St.ScrollView issues above).
        try {
            const dialog = new AddTaskDialog(
                (content, explicit, done, attachment) => this._createTask(content, done, explicit, attachment),
                this._extension.path);
            dialog.open();
        } catch (e) {
            console.error(`Todoist for GNOME: failed to open the Add Task dialog: ${e.message}`);
            Main.notify('Todoist for GNOME', `Failed to open the Add Task dialog: ${e.message}`);
        }
    }

    _openApp() {
        const desktopFile = this._settings.get_string('app-desktop-file');
        if (!desktopFile) {
            Main.notify('Todoist for GNOME', 'No application selected in the extension settings.');
            return;
        }

        try {
            const appInfo = Gio.DesktopAppInfo.new_from_filename(desktopFile);
            if (!appInfo)
                throw new Error('could not read the .desktop file');
            appInfo.launch([], null);
        } catch (e) {
            Main.notify('Todoist for GNOME', `Failed to launch the application: ${e.message}`);
        }
    }

    // Opens a given task directly, jumping straight into it rather than
    // just opening Todoist in general.
    //
    // We first try the "todoist://" deep link - if the desktop app is
    // installed and registered as its handler, this opens the task right
    // inside it. If nothing is registered for that scheme (common with some
    // Flatpak/Snap installs, or if only the web app is used), we fall back
    // to the task's regular web URL, which always works in the default
    // browser.
    _openTask(task) {
        const deepLink = `todoist://item?id=${task.id}`;
        const webUrl = TODOIST_WEB_TASK_URL(task.id);

        try {
            if (Gio.AppInfo.launch_default_for_uri(deepLink, null))
                return;
        } catch (e) {
            // No handler for todoist:// links - fall through to the web URL.
        }

        try {
            Gio.AppInfo.launch_default_for_uri(webUrl, null);
        } catch (e) {
            Main.notify('Todoist for GNOME', `Failed to open the task: ${e.message}`);
        }
    }

    _addPlaceholder(text) {
        this._taskSection.removeAll();
        this._taskSection.addMenuItem(new PopupMenu.PopupMenuItem(text, {reactive: false}));
    }

    // `highlightTaskId`, when set, plays the "just added" animation on that
    // task once the freshly-fetched list is rendered (see _renderTasks).
    _loadTasks(highlightTaskId = null) {
        const token = this._settings.get_string('api-token');
        if (!token) {
            this._showError('No token set. Open the extension settings.');
            return;
        }

        this._pendingHighlightId = highlightTaskId;
        this._addPlaceholder('Loading...');

        const message = Soup.Message.new('GET', API_URL);
        message.request_headers.append('Authorization', `Bearer ${token}`);

        this._session.send_and_read_async(
            message,
            GLib.PRIORITY_DEFAULT,
            null,
            (session, result) => {
                let bytes;
                try {
                    bytes = session.send_and_read_finish(result);
                } catch (e) {
                    this._showError(e.message);
                    return;
                }

                const status = message.get_status();
                if (status === Soup.Status.UNAUTHORIZED || status === Soup.Status.FORBIDDEN) {
                    this._showError('Invalid token. Check the extension settings.');
                    return;
                }
                if (status !== Soup.Status.OK) {
                    this._showError(`HTTP ${status}`);
                    return;
                }

                try {
                    const text = new TextDecoder('utf-8').decode(bytes.get_data());
                    const data = JSON.parse(text);
                    // API v1 returns {results: [...], next_cursor: ...}
                    this._renderTasks(data.results ?? data);
                } catch (e) {
                    this._showError(`Failed to parse response: ${e.message}`);
                }
            }
        );
    }

    _renderTasks(tasks) {
        this._taskSection.removeAll();

        const highlightId = this._pendingHighlightId;
        this._pendingHighlightId = null;

        if (!tasks || tasks.length === 0) {
            this._taskSection.addMenuItem(new PopupMenu.PopupMenuItem('No active tasks', {reactive: false}));
            return;
        }

        const sorted = [...tasks].sort(compareTasks);
        let highlightItem = null;

        for (const task of sorted.slice(0, 15)) {
            const item = this._buildTaskItem(task);
            this._taskSection.addMenuItem(item);
            if (highlightId && task.id === highlightId)
                highlightItem = item;
        }

        if (sorted.length > 15) {
            this._taskSection.addMenuItem(new PopupMenu.PopupMenuItem(
                `...and ${sorted.length - 15} more`, {reactive: false}));
        }

        if (highlightItem)
            this._animateTaskAdded(highlightItem);
    }

    _buildTaskItem(task) {
        // The row itself is reactive/clickable: clicking anywhere on it
        // (other than the complete button) opens the task in Todoist. The
        // "todoist-task-row" class gets a hover highlight (see stylesheet)
        // so it's clear the row can be clicked.
        const item = new PopupMenu.PopupBaseMenuItem({can_focus: true});
        item.add_style_class_name(priorityStyleClass(task.priority));
        item.add_style_class_name('todoist-task-row');
        item.connect('activate', () => this._openTask(task));

        const row = new St.BoxLayout({vertical: false, x_expand: true});

        const textBox = new St.BoxLayout({vertical: true, x_expand: true});

        const titleLabel = new St.Label({
            text: task.content,
            style_class: 'todoist-task-title',
        });
        titleLabel.clutter_text.set_line_wrap(true);
        titleLabel.clutter_text.set_line_wrap_mode(Pango.WrapMode.WORD_CHAR);
        titleLabel.set_width(TITLE_WRAP_WIDTH);
        clampToLines(titleLabel, TITLE_WRAP_WIDTH, TITLE_MAX_LINES);
        textBox.add_child(titleLabel);

        const metaParts = [];
        if (task.due) {
            const hasTime = typeof task.due.date === 'string' && task.due.date.includes('T');
            const recurring = task.due.is_recurring ? ' 🔁' : '';
            metaParts.push(`📅 ${formatDate(task.due.date, hasTime)}${recurring}`);
        }
        if (task.deadline)
            metaParts.push(`⏳ due ${formatDate(task.deadline.date, false)}`);

        if (metaParts.length > 0) {
            const metaLabel = new St.Label({
                text: metaParts.join('   '),
                style_class: 'todoist-task-meta',
            });
            // Set opacity directly on the actor (not just via CSS) so the
            // dimming reliably applies regardless of theme rules.
            metaLabel.opacity = META_OPACITY;
            textBox.add_child(metaLabel);
        }

        row.add_child(textBox);
        row.add_child(this._buildCompleteButton(task, item));

        item.add_child(row);
        return item;
    }

    // Small round button on the right of each task. Clicking it marks the
    // task done via the API; it consumes the click itself so it doesn't also
    // trigger the row's own "open task" activation.
    _buildCompleteButton(task, item) {
        const button = new St.Button({
            style_class: 'todoist-complete-button',
            reactive: true,
            can_focus: true,
            track_hover: true,
            y_align: Clutter.ActorAlign.CENTER,
            x_align: Clutter.ActorAlign.END,
        });
        button.connect('clicked', () => this._completeTask(task, item, button));
        return button;
    }

    _runAfter(ms, fn) {
        const id = GLib.timeout_add(GLib.PRIORITY_DEFAULT, ms, () => {
            this._pendingSources.delete(id);
            fn();
            return GLib.SOURCE_REMOVE;
        });
        this._pendingSources.add(id);
    }

    // Green flash on the button, then the row slides away to the left and
    // fades out ("slips away"), then the empty space it leaves behind
    // collapses.
    _animateTaskCompleted(item, button) {
        button.add_style_class_name('todoist-complete-button-done');

        this._runAfter(COMPLETE_FLASH_MS, () => {
            item.ease({
                translation_x: -COMPLETE_SLIDE_DISTANCE,
                opacity: 0,
                duration: COMPLETE_SLIDE_MS,
                mode: Clutter.AnimationMode.EASE_IN_QUAD,
                onComplete: () => {
                    const [, naturalHeight] = item.get_preferred_height(-1);
                    item.set_height(naturalHeight);
                    item.ease({
                        height: 0,
                        duration: COMPLETE_COLLAPSE_MS,
                        mode: Clutter.AnimationMode.EASE_OUT_QUAD,
                        onComplete: () => item.destroy(),
                    });
                },
            });
        });
    }

    // The reverse of _animateTaskCompleted: the row expands in from zero
    // height, then slides in from the left while fading in, with a brief
    // green tint (the "todoist-task-adding" class) marking it as new.
    _animateTaskAdded(item) {
        const [, naturalHeight] = item.get_preferred_height(-1);

        item.height = 0;
        item.opacity = 0;
        item.translation_x = -COMPLETE_SLIDE_DISTANCE;
        item.add_style_class_name('todoist-task-adding');

        item.ease({
            height: naturalHeight,
            duration: COMPLETE_COLLAPSE_MS,
            mode: Clutter.AnimationMode.EASE_OUT_QUAD,
            onComplete: () => {
                item.ease({
                    translation_x: 0,
                    opacity: 255,
                    duration: COMPLETE_SLIDE_MS,
                    mode: Clutter.AnimationMode.EASE_OUT_QUAD,
                    onComplete: () => item.remove_style_class_name('todoist-task-adding'),
                });
            },
        });
    }

    _completeTask(task, item, button) {
        const token = this._settings.get_string('api-token');
        if (!token) {
            Main.notify('Todoist for GNOME', 'No token set. Open the extension settings.');
            return;
        }

        button.reactive = false;
        item.add_style_class_name('todoist-task-completing');

        const message = Soup.Message.new('POST', `${API_URL}/${task.id}/close`);
        message.request_headers.append('Authorization', `Bearer ${token}`);

        this._session.send_and_read_async(
            message,
            GLib.PRIORITY_DEFAULT,
            null,
            (session, result) => {
                try {
                    session.send_and_read_finish(result);
                } catch (e) {
                    button.reactive = true;
                    item.remove_style_class_name('todoist-task-completing');
                    Main.notify('Todoist for GNOME', `Failed to complete the task: ${e.message}`);
                    return;
                }

                const status = message.get_status();
                // The close endpoint returns 204 No Content on success.
                if (status === Soup.Status.NO_CONTENT || status === Soup.Status.OK) {
                    this._animateTaskCompleted(item, button);
                } else {
                    button.reactive = true;
                    item.remove_style_class_name('todoist-task-completing');
                    Main.notify('Todoist for GNOME', `Failed to complete the task (HTTP ${status})`);
                }
            }
        );
    }

    _showError(msg) {
        this._taskSection.removeAll();
        this._taskSection.addMenuItem(new PopupMenu.PopupMenuItem(`Error: ${msg}`, {reactive: false}));
    }

    destroy() {
        for (const [object, id] of this._signalConnections)
            object.disconnect(id);
        this._signalConnections = [];
        this._session?.abort();
        this._session = null;

        for (const id of this._pendingSources)
            GLib.Source.remove(id);
        this._pendingSources.clear();

        this._quickAddEntry?.destroy();
        this._quickAddEntry = null;
        this._quickAddButton?.destroy();
        this._quickAddButton = null;
        this._openAppItem = null;
        this._settingsItem = null;
        this._taskSection = null;
        this._extension = null;
        this._settings = null;

        super.destroy();
    }
});

// Trims a label's text character-by-character (via binary search) until it
// fits within TITLE_MAX_LINES lines at TITLE_WRAP_WIDTH width. No recursion
// and no animation involved — just a single pass over the allocation, which
// keeps this reliable.
function clampToLines(label, maxWidth, maxLines) {
    const clutterText = label.clutter_text;
    const originalText = label.text;

    const [, singleLineHeight] = clutterText.get_preferred_height(-1);
    const maxHeight = singleLineHeight * maxLines;

    const [, fullHeight] = clutterText.get_preferred_height(maxWidth);
    if (fullHeight <= maxHeight)
        return; // already fits, nothing to trim

    let low = 1;
    let high = originalText.length;
    let best = `${originalText.slice(0, 1)}…`;

    while (low <= high) {
        const mid = Math.floor((low + high) / 2);
        const candidate = `${originalText.slice(0, mid).trimEnd()}…`;
        label.text = candidate;

        const [, height] = clutterText.get_preferred_height(maxWidth);
        if (height <= maxHeight) {
            best = candidate;
            low = mid + 1;
        } else {
            high = mid - 1;
        }
    }

    label.text = best;
}

// API priority scale: 4 = P1 (most urgent) ... 1 = P4 (default, no priority).
// Rendered as a style_class background rather than an emoji, applied to the
// whole menu item.
function priorityStyleClass(priority) {
    switch (priority) {
    case 4: return 'todoist-priority-p1';
    case 3: return 'todoist-priority-p2';
    case 2: return 'todoist-priority-p3';
    default: return 'todoist-priority-p4';
    }
}

function taskDueTimestamp(task) {
    if (!task.due || !task.due.date)
        return null;
    const date = new Date(task.due.date);
    return Number.isNaN(date.getTime()) ? null : date.getTime();
}

// Primary sort by due date (earlier first, no date goes last); ties are
// broken by priority (4 → 1, i.e. P1 above P4).
function compareTasks(a, b) {
    const aDue = taskDueTimestamp(a);
    const bDue = taskDueTimestamp(b);

    if (aDue === null && bDue !== null)
        return 1;
    if (aDue !== null && bDue === null)
        return -1;
    if (aDue !== null && bDue !== null && aDue !== bDue)
        return aDue - bDue;

    return b.priority - a.priority;
}

function formatDate(dateStr, withTime) {
    try {
        const date = new Date(dateStr);
        if (Number.isNaN(date.getTime()))
            return dateStr;

        const opts = withTime
            ? {day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit'}
            : {day: 'numeric', month: 'short'};
        // `undefined` locale means "use the system locale" instead of
        // hard-coding one.
        return new Intl.DateTimeFormat(undefined, opts).format(date);
    } catch (e) {
        return dateStr;
    }
}

export default class TodoistPanelExtension extends Extension {
    enable() {
        this._settings = this.getSettings();
        this._indicator = new TodoistIndicator(this, this._settings);
        Main.panel.addToStatusArea(this.uuid, this._indicator);

        Main.wm.addKeybinding(
            'add-task-shortcut',
            this._settings,
            Meta.KeyBindingFlags.NONE,
            Shell.ActionMode.NORMAL | Shell.ActionMode.OVERVIEW,
            () => this._indicator?.showAddTaskDialog()
        );
    }

    disable() {
        Main.wm.removeKeybinding('add-task-shortcut');

        this._indicator?.destroy();
        this._indicator = null;
        this._settings = null;
    }
}
