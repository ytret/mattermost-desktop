// Copyright (c) 2016-present Mattermost, Inc. All Rights Reserved.
// See LICENSE.txt for license information.

import {EventEmitter} from 'events';

import {net, session} from 'electron';

import {COOKIE_NAME_CSRF} from 'common/constants';

import {preferenceURL, PreferenceRequestError, requestPreferences, saveThemePreferences} from './themePreferences';

jest.mock('electron', () => ({
    net: {request: jest.fn()},
    session: {defaultSession: {cookies: {get: jest.fn()}}},
}));

describe('theme preference requests', () => {
    let req: EventEmitter & {setHeader: jest.Mock; write: jest.Mock; end: jest.Mock; abort: jest.Mock};
    const url = new URL('https://example.com/subpath/api/v4/users/user/preferences');
    beforeEach(() => {
        jest.useFakeTimers();
        jest.clearAllMocks();
        req = Object.assign(new EventEmitter(), {setHeader: jest.fn(), write: jest.fn(), end: jest.fn(), abort: jest.fn()});
        jest.mocked(net.request).mockReturnValue(req as never);
        jest.mocked(session.defaultSession.cookies.get).mockResolvedValue([{name: COOKIE_NAME_CSRF, value: 'csrf'} as never]);
    });
    afterEach(() => jest.useRealTimers());

    const respond = (statusCode: number, body: string) => {
        const response = Object.assign(new EventEmitter(), {statusCode});
        req.emit('response', response);
        response.emit('data', Buffer.from(body));
        response.emit('end');
    };

    it('preserves subpaths and discards queries and fragments', () => {
        expect(preferenceURL(new URL('https://example.com/subpath?query=true#hash'), 'users/me').toString()).toBe('https://example.com/subpath/api/v4/users/me');
    });

    it('saves using URL-scoped cookies, the Electron session and CSRF header', async () => {
        const preferences = [{user_id: 'user', category: 'theme', name: '', value: '{}'}];
        const result = saveThemePreferences(url, preferences);
        await Promise.resolve();
        expect(session.defaultSession.cookies.get).toHaveBeenCalledWith({url: url.toString()});
        expect(net.request).toHaveBeenCalledWith({url: url.toString(), method: 'PUT', session: session.defaultSession, useSessionCookies: true});
        expect(req.setHeader).toHaveBeenCalledWith('X-CSRF-Token', 'csrf');
        expect(req.write).toHaveBeenCalledWith(JSON.stringify(preferences));
        respond(200, '{"status":"OK"}');
        await expect(result).resolves.toEqual({status: 'OK'});
        expect(jest.getTimerCount()).toBe(0);
    });

    it('reads preferences without a request body', async () => {
        const result = requestPreferences(url);
        await Promise.resolve();
        expect(req.write).not.toHaveBeenCalled();
        respond(200, '[]');
        await expect(result).resolves.toEqual([]);
    });

    it.each([400, 401, 403, 500, 503])('classifies HTTP %s without exposing response data', async (status) => {
        const result = requestPreferences(url);
        const check = expect(result).rejects.toMatchObject({status, retryable: status >= 500});
        await Promise.resolve();
        respond(status, 'sensitive response');
        await check;
        expect(jest.getTimerCount()).toBe(0);
    });

    it('aborts stalled requests and returns a retryable error', async () => {
        const result = requestPreferences(url);
        const check = expect(result).rejects.toBeInstanceOf(PreferenceRequestError);
        await Promise.resolve();
        jest.advanceTimersByTime(30000);
        await check;
        expect(req.abort).toHaveBeenCalled();
    });
});
