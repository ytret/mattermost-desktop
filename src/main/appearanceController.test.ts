// Copyright (c) 2016-present Mattermost, Inc. All Rights Reserved.
// See LICENSE.txt for license information.

import {nativeTheme} from 'electron';

import {SERVER_LOGGED_IN_CHANGED, SERVER_REMOVED} from 'common/communication';
import Config from 'common/config';
import ServerManager from 'common/servers/serverManager';
import {PreferenceRequestError, requestPreferences, saveThemePreferences} from 'main/server/themePreferences';
import {themePresets} from 'main/server/themePresets';

import {AppearanceController} from './appearanceController';

jest.mock('electron', () => {
    const {EventEmitter} = jest.requireActual('events');
    return {nativeTheme: Object.assign(new EventEmitter(), {themeSource: 'system', shouldUseDarkColors: false})};
});
jest.mock('common/config', () => {
    const {EventEmitter} = jest.requireActual('events');
    return {__esModule: true, default: Object.assign(new EventEmitter(), {set: jest.fn()})};
});
jest.mock('common/servers/serverManager', () => {
    const {EventEmitter} = jest.requireActual('events');
    return {__esModule: true, default: Object.assign(new EventEmitter(), {getAllServers: jest.fn(), getServer: jest.fn()})};
});
jest.mock('main/server/themePreferences', () => ({
    ...jest.requireActual('main/server/themePreferences'),
    requestPreferences: jest.fn(),
    saveThemePreferences: jest.fn(),
}));

const native = nativeTheme as unknown as {shouldUseDarkColors: boolean};
const advance = async (milliseconds: number) => {
    jest.advanceTimersByTime(milliseconds);
    await flush();
};
const config = Config as unknown as {appearanceMode: string; darkMode: boolean; set: jest.Mock; emit: (event: string) => void; removeAllListeners: () => void};
const servers = jest.mocked(ServerManager);
const request = jest.mocked(requestPreferences);
const save = jest.mocked(saveThemePreferences);
const flush = async () => {
    for (let i = 0; i < 20; i++) {
        // Drain chained requests and the latest generation without advancing retry timers.
        // eslint-disable-next-line no-await-in-loop
        await Promise.resolve();
    }
};

describe('Linux account appearance', () => {
    const platform = process.platform;
    beforeAll(() => Object.defineProperty(process, 'platform', {value: 'linux'}));
    afterAll(() => Object.defineProperty(process, 'platform', {value: platform}));
    let controller: AppearanceController;
    let server: {id: string; url: URL; isLoggedIn: boolean};
    beforeEach(() => {
        jest.useFakeTimers();
        jest.clearAllMocks();
        config.removeAllListeners();
        ServerManager.removeAllListeners();
        nativeTheme.removeAllListeners();
        config.appearanceMode = 'system';
        config.darkMode = false;
        native.shouldUseDarkColors = false;
        nativeTheme.themeSource = 'system';
        server = {id: 'server', url: new URL('https://example.com/mattermost/'), isLoggedIn: true};
        servers.getAllServers.mockReturnValue([server as never]);
        servers.getServer.mockImplementation((id) => (id === server.id ? server as never : undefined));
        request.mockImplementation(async (url) => (url.pathname.endsWith('/me') ? {id: 'user'} : []));
        save.mockResolvedValue({status: 'OK'});
        controller = new AppearanceController();
    });
    afterEach(() => jest.useRealTimers());

    it('keeps workspace mode passive by default', async () => {
        config.appearanceMode = 'workspace';
        controller.init();
        await flush();
        expect(save).not.toHaveBeenCalled();
    });

    it('follows startup and live light-dark-light changes, using the configured subpath', async () => {
        controller.init();
        await flush();
        expect(save.mock.calls[0][0].pathname).toBe('/mattermost/api/v4/users/user/preferences');
        expect(JSON.parse(save.mock.calls[0][1][0].value)).toEqual(themePresets.quartz);
        native.shouldUseDarkColors = true;
        nativeTheme.emit('updated');
        await flush();
        expect(JSON.parse(save.mock.calls[1][1][0].value)).toEqual(themePresets.onyx);
        native.shouldUseDarkColors = false;
        nativeTheme.emit('updated');
        await flush();
        expect(JSON.parse(save.mock.calls[2][1][0].value)).toEqual(themePresets.quartz);
        nativeTheme.emit('updated');
        await flush();
        expect(save).toHaveBeenCalledTimes(3);
    });

    it.each(['light', 'dark'])('sets the forced %s source and cancels automation without restoring preferences', async (mode) => {
        config.appearanceMode = mode;
        controller.init();
        await flush();
        expect(nativeTheme.themeSource).toBe(mode);
        config.appearanceMode = 'workspace';
        config.emit('update');
        nativeTheme.emit('updated');
        await flush();
        expect(save).toHaveBeenCalledTimes(1);
    });

    it('updates every team and the global entry in batches, leaving unrelated preferences untouched', async () => {
        const preferences = Array.from({length: 205}, (_, index) => ({user_id: 'user', category: 'theme', name: `team${index}`, value: '{}'}));
        const unrelated = {user_id: 'user', category: 'display_settings', name: 'name_format', value: 'username'};
        request.mockResolvedValueOnce({id: 'user'}).mockResolvedValueOnce([...preferences, unrelated]);
        controller.init();
        await flush();
        expect(save.mock.calls.map((call) => call[1].length)).toEqual([100, 100, 6]);
        expect(save.mock.calls.flatMap((call) => call[1]).every((pref) => pref.category === 'theme')).toBe(true);
        expect(unrelated.value).toBe('username');
    });

    it('skips matching themes regardless of JSON key order', async () => {
        request.mockResolvedValueOnce({id: 'user'}).mockResolvedValueOnce([{user_id: 'user', category: 'theme', name: '', value: JSON.stringify(Object.fromEntries(Object.entries(themePresets.quartz).reverse()))}]);
        controller.init();
        await flush();
        expect(save).not.toHaveBeenCalled();
    });

    it.each([401, 403, 400])('does not retry HTTP %s failures', async (status) => {
        request.mockRejectedValue(new PreferenceRequestError(status));
        controller.init();
        await flush();
        await advance(200000);
        expect(request).toHaveBeenCalledTimes(1);
    });

    it('retries transient failures after 5, 30, 120 seconds then waits for a trigger', async () => {
        request.mockRejectedValue(new PreferenceRequestError(503));
        controller.init();
        await flush();
        for (const delay of [5000, 30000, 120000]) {
            // eslint-disable-next-line no-await-in-loop
            await advance(delay);
        }
        expect(request).toHaveBeenCalledTimes(4);
        await advance(200000);
        expect(request).toHaveBeenCalledTimes(4);
        controller.trigger(server.id);
        await flush();
        expect(request).toHaveBeenCalledTimes(5);
    });

    it.each(['logout', 'remove', 'disable'])('cancels retries on %s', async (action) => {
        request.mockRejectedValue(new PreferenceRequestError());
        controller.init();
        await flush();
        if (action === 'disable') {
            config.appearanceMode = 'workspace';
            config.emit('update');
        } else {
            server.isLoggedIn = false;
            ServerManager.emit(action === 'logout' ? SERVER_LOGGED_IN_CHANGED : SERVER_REMOVED, server.id, false);
        }
        await advance(200000);
        expect(request).toHaveBeenCalledTimes(1);
    });

    it('serializes rapid changes and finishes with the latest requested theme', async () => {
        let finish: (value: unknown) => void = () => {};
        save.mockImplementationOnce(() => new Promise((resolve) => {
            finish = resolve;
        }));
        controller.init();
        await flush();
        native.shouldUseDarkColors = true;
        nativeTheme.emit('updated');
        await flush();
        expect(save).toHaveBeenCalledTimes(1);
        finish({status: 'OK'});
        await flush();
        expect(save).toHaveBeenCalledTimes(2);
        expect(JSON.parse(save.mock.calls[1][1][0].value)).toEqual(themePresets.onyx);
    });

    it('handles signed-in servers independently and triggers after login', async () => {
        const second = {...server, id: 'second', url: new URL('https://other.example/')};
        servers.getAllServers.mockReturnValue([server, second] as never);
        servers.getServer.mockImplementation((id) => (id === server.id ? server : second) as never);
        controller.init();
        await flush();
        expect(save).toHaveBeenCalledTimes(2);
        ServerManager.emit(SERVER_LOGGED_IN_CHANGED, second.id, true);
        await flush();
        expect(save).toHaveBeenCalledTimes(3);
    });
});
