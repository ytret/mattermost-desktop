// Copyright (c) 2016-present Mattermost, Inc. All Rights Reserved.
// See LICENSE.txt for license information.

import {nativeTheme} from 'electron';

import {SERVER_LOGGED_IN_CHANGED, SERVER_REMOVED, SERVER_URL_CHANGED} from 'common/communication';
import Config from 'common/config';
import {Logger} from 'common/log';
import ServerManager from 'common/servers/serverManager';
import LinuxSystemTheme from 'main/linuxSystemTheme';
import {preferenceURL, PreferenceRequestError, requestPreferences, saveThemePreferences} from 'main/server/themePreferences';
import type {ThemePreference} from 'main/server/themePreferences';
import {themePresets} from 'main/server/themePresets';
import ThemeManager from 'main/themeManager';

import type {AppearanceMode} from 'types/config';

const log = new Logger('AppearanceController');
const retryDelays = [5000, 30000, 120000];
type Work = {generation: number; running: boolean; attempt: number; timer?: NodeJS.Timeout};

export class AppearanceController {
    private mode?: AppearanceMode;
    private dark?: boolean;
    private work = new Map<string, Work>();

    private initialized?: Promise<void>;
    private ready = false;
    private updating = false;
    private lifecycle = 0;

    get effectiveDark() {
        if (process.platform === 'linux') {
            const mode = Config.appearanceMode;
            if (mode === 'light' || mode === 'dark') {
                return mode === 'dark';
            }
            if (mode === 'system' && LinuxSystemTheme.preference) {
                return LinuxSystemTheme.preference === 'dark';
            }
        }
        return nativeTheme.shouldUseDarkColors;
    }

    init = (): Promise<void> => {
        if (process.platform !== 'linux') {
            return Promise.resolve();
        }
        if (this.initialized) {
            return this.initialized;
        }
        const lifecycle = ++this.lifecycle;
        Config.on('update', this.update);
        nativeTheme.on('updated', this.update);
        LinuxSystemTheme.on('changed', this.update);
        ServerManager.on(SERVER_LOGGED_IN_CHANGED, this.loginChanged);
        ServerManager.on(SERVER_REMOVED, this.cancel);
        ServerManager.on(SERVER_URL_CHANGED, this.urlChanged);
        this.initialized = LinuxSystemTheme.init().then(() => {
            if (lifecycle === this.lifecycle) {
                this.ready = true;
                this.update();
            }
        });
        return this.initialized;
    };

    dispose = () => {
        this.lifecycle++;
        this.ready = false;
        Config.removeListener('update', this.update);
        nativeTheme.removeListener('updated', this.update);
        LinuxSystemTheme.removeListener('changed', this.update);
        ServerManager.removeListener(SERVER_LOGGED_IN_CHANGED, this.loginChanged);
        ServerManager.removeListener(SERVER_REMOVED, this.cancel);
        ServerManager.removeListener(SERVER_URL_CHANGED, this.urlChanged);
        this.work.forEach((_, id) => this.cancel(id));
        LinuxSystemTheme.dispose();
        this.initialized = undefined;
        this.mode = undefined;
        this.dark = undefined;
    };

    private urlChanged = (id: string) => {
        this.cancel(id);
        this.trigger(id);
    };

    update = () => {
        if (!this.ready || this.updating) {
            return;
        }
        this.updating = true;
        try {
            const mode = Config.appearanceMode;
            const previousMode = this.mode;
            this.mode = mode;
            if (mode === 'workspace') {
                this.work.forEach((_, id) => this.cancel(id));
                if (previousMode && previousMode !== 'workspace') {
                    // Release our override before the workspace reapplies its theme.
                    nativeTheme.themeSource = 'system';
                    ThemeManager.restoreWorkspaceTheme();
                }
            } else {
                const source = mode === 'system' ? LinuxSystemTheme.preference || 'system' : mode;
                if (nativeTheme.themeSource !== source) {
                    nativeTheme.themeSource = source;
                }
            }

            // Read Electron only after restoring its system source on fallback.
            const dark = this.effectiveDark;
            const changed = dark !== this.dark;
            this.dark = dark;
            if (Config.darkMode !== dark) {
                Config.set('darkMode', dark);
            }
            if (mode !== 'workspace' && (changed || previousMode === 'workspace' || !previousMode)) {
                ServerManager.getAllServers().forEach((server) => this.trigger(server.id));
            }
        } finally {
            this.updating = false;
        }
    };

    private loginChanged = (id: string, loggedIn: boolean) => {
        if (loggedIn) {
            this.trigger(id);
        } else {
            this.cancel(id);
        }
    };

    // Keep running jobs in the map so logout/login cannot start overlapping writes.
    private cancel = (id: string) => {
        const job = this.work.get(id);
        if (job) {
            clearTimeout(job.timer);
            job.timer = undefined;
            job.generation++;
            job.attempt = 0;
        }
    };

    trigger = (id: string) => {
        if (!this.ready || this.mode === 'workspace' || !this.mode || !ServerManager.getServer(id)?.isLoggedIn) {
            return;
        }
        const job = this.work.get(id) || {generation: 0, running: false, attempt: 0};
        clearTimeout(job.timer);
        job.timer = undefined;
        job.generation++;
        job.attempt = 0;
        this.work.set(id, job);
        this.run(id, job);
    };

    private active = (id: string) => this.ready && this.mode !== 'workspace' && ServerManager.getServer(id)?.isLoggedIn;

    private run = async (id: string, job: Work) => {
        if (job.running || !this.active(id)) {
            return;
        }
        job.running = true;
        const generation = job.generation;
        const current = () => generation === job.generation && this.active(id);
        try {
            const server = ServerManager.getServer(id)!;
            const preset = this.dark ? themePresets.onyx : themePresets.quartz;
            const user = await requestPreferences<{id: string}>(preferenceURL(server.url, 'users/me'));
            if (!current()) {
                return;
            }
            const url = preferenceURL(server.url, `users/${encodeURIComponent(user.id)}/preferences`);
            const preferences = await requestPreferences<ThemePreference[]>(url);
            if (!current()) {
                return;
            }
            const themes = preferences.filter((pref) => pref.category === 'theme');
            if (!themes.some((pref) => pref.name === '')) {
                themes.push({user_id: user.id, category: 'theme', name: '', value: ''});
            }
            const updates = themes.filter((pref) => {
                try {
                    const saved = JSON.parse(pref.value);
                    return Object.keys(saved).length !== Object.keys(preset).length || Object.entries(preset).some(([key, value]) => saved[key] !== value);
                } catch {
                    return true;
                }
            }).map((pref) => ({...pref, value: JSON.stringify(preset)}));
            for (let offset = 0; offset < updates.length && current(); offset += 100) {
                // Each batch must finish before a newer generation or another batch writes.
                // eslint-disable-next-line no-await-in-loop
                await saveThemePreferences(url, updates.slice(offset, offset + 100));
            }
        } catch (error) {
            if (current()) {
                const retryable = !(error instanceof PreferenceRequestError) || error.retryable;

                // Never log response bodies, cookies, URLs or raw network errors.
                log.warn('Theme synchronization failed', {serverId: id, status: error instanceof PreferenceRequestError ? error.status : undefined});
                if (retryable && job.attempt < retryDelays.length) {
                    job.timer = setTimeout(() => {
                        job.timer = undefined;
                        this.run(id, job);
                    }, retryDelays[job.attempt++]);
                }
            }
        } finally {
            job.running = false;
            if (generation !== job.generation && this.active(id)) {
                this.run(id, job);
            }
        }
    };
}

const appearanceController = new AppearanceController();
export default appearanceController;
