import Adw from 'gi://Adw';
import Gio from 'gi://Gio';
import Gtk from 'gi://Gtk';
import Gdk from 'gi://Gdk';

import {ExtensionPreferences} from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';

export default class TodoistPanelPreferences extends ExtensionPreferences {
    fillPreferencesWindow(window) {
        const settings = this.getSettings();

        const page = new Adw.PreferencesPage();

        const accountGroup = new Adw.PreferencesGroup({
            title: 'Todoist',
            description: 'Connect to your Todoist account',
        });
        page.add(accountGroup);

        // --- API token field ---
        const tokenRow = new Adw.PasswordEntryRow({
            title: 'API Token',
            text: settings.get_string('api-token'),
        });
        settings.bind('api-token', tokenRow, 'text', Gio.SettingsBindFlags.DEFAULT);
        accountGroup.add(tokenRow);

        // --- Todoist application: pick a .desktop file rather than a raw
        // binary path, so this works the same for native packages, Flatpak
        // and Snap.
        const currentDesktopFile = settings.get_string('app-desktop-file');
        const pathRow = new Adw.ActionRow({
            title: 'Todoist Application',
            subtitle: currentDesktopFile
                ? this._describeDesktopFile(currentDesktopFile)
                : 'Not selected',
        });

        const chooseButton = new Gtk.Button({
            label: 'Choose...',
            valign: Gtk.Align.CENTER,
        });
        chooseButton.connect('clicked', () => {
            const dialog = new Gtk.FileChooserNative({
                title: 'Select the Todoist application .desktop file',
                transient_for: window,
                modal: true,
                action: Gtk.FileChooserAction.OPEN,
                accept_label: 'Select',
                cancel_label: 'Cancel',
            });

            const filter = new Gtk.FileFilter();
            filter.set_name('Desktop files (*.desktop)');
            filter.add_pattern('*.desktop');
            dialog.add_filter(filter);

            // Flatpak .desktop files live in a separate location from system
            // ones — start in the most likely folder, the user can still
            // navigate elsewhere (e.g. ~/.local/share/flatpak/exports/share/applications)
            // via Ctrl+L.
            const startDir = Gio.File.new_for_path('/var/lib/flatpak/exports/share/applications');
            if (startDir.query_exists(null))
                dialog.set_current_folder(startDir);
            else
                dialog.set_current_folder(Gio.File.new_for_path('/usr/share/applications'));

            dialog.connect('response', (dlg, response) => {
                if (response === Gtk.ResponseType.ACCEPT) {
                    const path = dlg.get_file().get_path();
                    settings.set_string('app-desktop-file', path);
                    pathRow.subtitle = this._describeDesktopFile(path);
                }
                dlg.destroy();
            });

            dialog.show();
        });

        pathRow.add_suffix(chooseButton);
        pathRow.activatable_widget = chooseButton;
        accountGroup.add(pathRow);

        // --- Shortcuts group ---
        const shortcutsGroup = new Adw.PreferencesGroup({
            title: 'Shortcuts',
            description: 'Global keyboard shortcuts',
        });
        page.add(shortcutsGroup);

        const shortcutRow = new Adw.ActionRow({
            title: 'Add Task',
            subtitle: 'Opens a small popup to quickly add a task, from anywhere',
        });

        const currentAccel = settings.get_strv('add-task-shortcut')[0] ?? '';
        const shortcutLabel = new Gtk.ShortcutLabel({
            accelerator: currentAccel,
            valign: Gtk.Align.CENTER,
            disabled_text: 'Not set',
        });

        const changeButton = new Gtk.Button({
            label: 'Change...',
            valign: Gtk.Align.CENTER,
        });
        changeButton.connect('clicked', () => this._captureShortcut(window, settings, shortcutLabel));

        const clearButton = new Gtk.Button({
            icon_name: 'edit-clear-symbolic',
            valign: Gtk.Align.CENTER,
            tooltip_text: 'Remove shortcut',
        });
        clearButton.connect('clicked', () => {
            settings.set_strv('add-task-shortcut', []);
            shortcutLabel.accelerator = '';
        });

        shortcutRow.add_suffix(shortcutLabel);
        shortcutRow.add_suffix(changeButton);
        shortcutRow.add_suffix(clearButton);
        shortcutsGroup.add(shortcutRow);

        window.add(page);
    }

    // Show the app's display name from the .desktop file itself instead of
    // the raw path, so it's clearer what's selected.
    _describeDesktopFile(path) {
        try {
            const appInfo = Gio.DesktopAppInfo.new_from_filename(path);
            return appInfo ? `${appInfo.get_display_name()} (${path})` : path;
        } catch (e) {
            return path;
        }
    }

    // Opens a tiny modal window that captures the next key combination the
    // user presses and stores it as the "add-task-shortcut" accelerator.
    _captureShortcut(parentWindow, settings, shortcutLabel) {
        const captureWindow = new Adw.Window({
            transient_for: parentWindow,
            modal: true,
            default_width: 340,
            default_height: 120,
            title: 'Set Shortcut',
            resizable: false,
        });

        const box = new Gtk.Box({
            orientation: Gtk.Orientation.VERTICAL,
            spacing: 8,
            margin_top: 28,
            margin_bottom: 28,
            margin_start: 24,
            margin_end: 24,
            valign: Gtk.Align.CENTER,
        });
        box.append(new Gtk.Label({
            label: 'Press the new shortcut...',
            css_classes: ['title-4'],
        }));
        box.append(new Gtk.Label({
            label: 'Esc to cancel',
            css_classes: ['dim-label'],
        }));
        captureWindow.set_content(box);

        const controller = new Gtk.EventControllerKey();
        controller.connect('key-pressed', (ctrl, keyval, keycode, state) => {
            if (keyval === Gdk.KEY_Escape) {
                captureWindow.close();
                return true;
            }

            // Ignore bare modifier presses (Ctrl, Shift, Super on their own)
            // — wait for an actual key combination.
            const isModifierOnly = [
                Gdk.KEY_Control_L, Gdk.KEY_Control_R,
                Gdk.KEY_Shift_L, Gdk.KEY_Shift_R,
                Gdk.KEY_Alt_L, Gdk.KEY_Alt_R,
                Gdk.KEY_Super_L, Gdk.KEY_Super_R,
                Gdk.KEY_Meta_L, Gdk.KEY_Meta_R,
            ].includes(keyval);
            if (isModifierOnly)
                return true;

            const mask = state & Gtk.accelerator_get_default_mod_mask();
            if (!Gtk.accelerator_valid(keyval, mask))
                return true;

            const accel = Gtk.accelerator_name(keyval, mask);
            settings.set_strv('add-task-shortcut', [accel]);
            shortcutLabel.accelerator = accel;
            captureWindow.close();
            return true;
        });
        captureWindow.add_controller(controller);

        captureWindow.present();
    }
}
