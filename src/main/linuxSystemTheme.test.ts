// Copyright (c) 2016-present Mattermost, Inc. All Rights Reserved.
// See LICENSE.txt for license information.

import {EventEmitter} from 'events';

import {decodePreference, LinuxSystemTheme, lookupTimeout} from './linuxSystemTheme';
import type {ThemeBus} from './linuxSystemTheme';

const variant = (value: unknown, type = 'u'): unknown => [[{type, child: []}], [value]];
const signal = (value: unknown, overrides = {}) => ({
    type: 4,
    sender: ':1.5',
    path: '/org/freedesktop/portal/desktop',
    interface: 'org.freedesktop.portal.Settings',
    member: 'SettingChanged',
    body: ['org.freedesktop.appearance', 'color-scheme', variant(value)],
    ...overrides,
});

describe('LinuxSystemTheme', () => {
    let provider: LinuxSystemTheme;
    let connection: ThemeBus['connection'];
    let invoke: jest.Mock;
    let connect: jest.Mock;
    let reply: (error?: {name: string}, value?: unknown) => void;
    let changes: jest.Mock;

    beforeEach(() => {
        jest.useFakeTimers();
        connection = Object.assign(new EventEmitter(), {stream: Object.assign(new EventEmitter(), {destroy: jest.fn()})});
        invoke = jest.fn((message, callback) => {
            if (message.member === 'AddMatch') {
                callback();
            } else if (message.member === 'GetNameOwner') {
                callback(undefined, ':1.5');
            } else {
                reply = callback;
            }
        });
        connect = jest.fn(() => ({connection, invoke}));
        provider = new LinuxSystemTheme(connect);
        changes = jest.fn();
        provider.on('changed', changes);
    });
    afterEach(() => {
        provider.dispose();
        expect(jest.getTimerCount()).toBe(0);
        expect(connection.listenerCount('message')).toBe(0);
        expect(connection.listenerCount('error')).toBe(0);
        expect(connection.listenerCount('end')).toBe(0);
        expect(connection.stream.listenerCount('close')).toBe(0);
        jest.useRealTimers();
    });

    it.each([1, 2, 0, 99])('decodes %s in both old and new variant representations', (value) => {
        const expected = new Map([[1, 'dark'], [2, 'light']]).get(value);
        for (const encoded of [value, ['u', value], variant(value), variant(variant(value), 'v')]) {
            expect(decodePreference(encoded)).toBe(expected);
        }
    });

    it.each([null, {}, '1', ['s', 1], [[{type: 's'}], [1]], ['u', [1, 2]]])('rejects malformed values %p', (value) => {
        expect(decodePreference(value)).toBeUndefined();
    });

    it('subscribes before ReadOne, ignores unrelated signals and suppresses duplicates', async () => {
        const initial = provider.init();
        expect(provider.init()).toBe(initial);
        expect(invoke.mock.calls.map((call) => call[0].member)).toEqual(['AddMatch', 'AddMatch', 'GetNameOwner', 'ReadOne']);
        reply(undefined, variant(2));
        await initial;
        connection.emit('message', signal(1, {body: ['other', 'color-scheme', variant(1)]}));
        connection.emit('message', signal(1, {sender: ':1.6'}));
        connection.emit('message', signal(1, {body: ['org.freedesktop.appearance', 'other', variant(1)]}));
        expect(provider.preference).toBe('light');
        connection.emit('message', signal(2));
        expect(changes).toHaveBeenCalledTimes(1);
        connection.emit('message', signal(1));
        connection.emit('message', signal(1));
        expect(provider.preference).toBe('dark');
        expect(changes).toHaveBeenCalledTimes(2);
    });

    it.each([0, 99, null])('clears an explicit preference on signal %p', async (value) => {
        const initial = provider.init();
        reply(undefined, variant(1));
        await initial;
        connection.emit('message', signal(value));
        expect(provider.preference).toBeUndefined();
        connection.emit('message', signal(value));
        expect(changes).toHaveBeenCalledTimes(2);
    });

    it('falls back from ReadOne to Read with the extra variant', async () => {
        const initial = provider.init();
        reply({name: 'org.freedesktop.DBus.Error.UnknownMethod'});
        expect(invoke.mock.calls.at(-1)[0].member).toBe('Read');
        reply(undefined, variant(variant(1), 'v'));
        await initial;
        expect(provider.preference).toBe('dark');
    });

    it('a signal during the initial read wins over the delayed reply', async () => {
        const initial = provider.init();
        connection.emit('message', signal(1));
        await initial;
        reply(undefined, variant(2));
        expect(provider.preference).toBe('dark');
        expect(jest.getTimerCount()).toBe(0);
    });

    it('times out, discards a late read, then recovers', async () => {
        const initial = provider.init();
        const late = reply;
        jest.advanceTimersByTime(lookupTimeout);
        await initial;
        expect(provider.preference).toBeUndefined();
        late(undefined, variant(1));
        expect(provider.preference).toBeUndefined();
        jest.advanceTimersByTime(1000);
        reply(undefined, variant(2));
        expect(provider.preference).toBe('light');
    });

    it.each(['org.freedesktop.DBus.Error.ServiceUnknown', 'org.freedesktop.portal.Error.NotFound'])('recovers from %s', async (name) => {
        const initial = provider.init();
        reply({name});
        await initial;
        expect(provider.preference).toBeUndefined();
        jest.advanceTimersByTime(1000);
        reply(undefined, variant(1));
        expect(provider.preference).toBe('dark');
    });

    it.each([null, {}, ['s', [1]]])('falls back on a malformed read %p and accepts subsequent valid signals', async (value) => {
        const initial = provider.init();
        reply(undefined, value);
        await initial;
        expect(provider.preference).toBeUndefined();
        connection.emit('message', signal(1));
        expect(provider.preference).toBe('dark');
    });

    it('survives a missing bus and caps reconnect backoff', async () => {
        connect.mockImplementation(() => {
            throw new Error('no session bus');
        });
        await provider.init();
        for (const delay of [1000, 2000, 4000, 8000, 16000, 30000, 30000]) {
            const count = connect.mock.calls.length;
            jest.advanceTimersByTime(delay - 1);
            expect(connect).toHaveBeenCalledTimes(count);
            jest.advanceTimersByTime(1);
            expect(connect).toHaveBeenCalledTimes(count + 1);
        }
    });

    it.each(['end', 'error', 'restart'])('clears obsolete state on %s and rereads after recovery', async (event) => {
        const initial = provider.init();
        reply(undefined, variant(1));
        await initial;
        if (event === 'restart') {
            connection.emit('message', {type: 4, sender: 'org.freedesktop.DBus', interface: 'org.freedesktop.DBus', member: 'NameOwnerChanged', body: ['org.freedesktop.portal.Desktop', ':1.5', ':1.6']});
        } else {
            connection.emit(event);
        }
        expect(provider.preference).toBeUndefined();
        jest.advanceTimersByTime(1000);
        reply(undefined, variant(2));
        expect(provider.preference).toBe('light');
    });

    it('disposes during pending lookup, settles initialization and ignores late responses', async () => {
        const initial = provider.init();
        provider.dispose();
        provider.dispose();
        await initial;
        reply(undefined, variant(1));
        expect(provider.preference).toBeUndefined();
        expect(connection.stream.destroy).toHaveBeenCalledTimes(1);
        const next = provider.init();
        reply(undefined, variant(2));
        await next;
        expect(provider.preference).toBe('light');
    });
});
