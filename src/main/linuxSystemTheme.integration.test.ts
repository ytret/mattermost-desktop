// Copyright (c) 2016-present Mattermost, Inc. All Rights Reserved.
// See LICENSE.txt for license information.

import {spawn, spawnSync} from 'child_process';
import {once} from 'events';
import {createConnection} from 'net';

import * as dbus from '@homebridge/dbus-native';

import {LinuxSystemTheme} from './linuxSystemTheme';
import type {ThemeBus} from './linuxSystemTheme';

// Linux CI needs dbus-daemon; other platforms do not initialize this provider.
const supported = process.platform === 'linux' && spawnSync('dbus-daemon', ['--version']).status === 0;
const integration = supported ? describe : describe.skip;
type PortalBus = ThemeBus & {
    requestName: (name: string, flags: number, callback: (error?: Error) => void) => void;
    releaseName: (name: string, callback: (error?: Error) => void) => void;
    exportInterface: (implementation: unknown, path: string, definition: unknown) => void;
    sendSignal: (path: string, iface: string, member: string, signature: string, args: unknown[]) => void;
};

integration('Settings portal on a private D-Bus session', () => {
    it.each([{method: 'ReadOne', abstract: false}, {method: 'Read', abstract: false}, {method: 'ReadOne', abstract: true}])('reads $method (abstract=$abstract), receives signals and recovers from a portal restart', async ({method, abstract}) => {
        const args = ['--session', '--nofork', '--print-address=1'];
        const socketName = `mattermost-theme-${process.pid}-${Date.now()}`;
        if (abstract) {
            args.push(`--address=unix:abstract=${socketName}`);
        }
        const daemon = spawn('dbus-daemon', args, {stdio: ['ignore', 'pipe', 'pipe']});
        const previousAddress = process.env.DBUS_SESSION_BUS_ADDRESS;
        let server: PortalBus | undefined;
        const provider = new LinuxSystemTheme();
        try {
            const [chunk] = await once(daemon.stdout!, 'data');
            const address = chunk.toString().trim();
            process.env.DBUS_SESSION_BUS_ADDRESS = address;
            server = (dbus as unknown as {sessionBus: (options: {busAddress: string; stream?: ReturnType<typeof createConnection>}) => PortalBus}).sessionBus({busAddress: address, stream: abstract ? createConnection({path: `\0${socketName}`}) : undefined});
            server.connection.on('error', () => {});
            let value = 1;
            server.exportInterface({[method]: () => (method === 'Read' ? ['v', ['u', value]] : ['u', value])}, '/org/freedesktop/portal/desktop', {
                name: 'org.freedesktop.portal.Settings',
                methods: {[method]: ['ss', 'v', ['namespace', 'key'], ['value']]},
                signals: {SettingChanged: ['ssv', ['namespace', 'key', 'value']]},
            });
            const claim = () => new Promise<void>((resolve, reject) => server!.requestName('org.freedesktop.portal.Desktop', 0, (error) => (error ? reject(error) : resolve())));
            await claim();
            await provider.init();
            expect(provider.preference).toBe('dark');
            for (const next of [2, 1, 2, 1, 2]) {
                const changed = once(provider, 'changed');
                value = next;
                server.sendSignal('/org/freedesktop/portal/desktop', 'org.freedesktop.portal.Settings', 'SettingChanged', 'ssv', ['org.freedesktop.appearance', 'color-scheme', ['u', value]]);
                await changed;
                expect(provider.preference).toBe(value === 1 ? 'dark' : 'light');
            }
            const lost = once(provider, 'changed');
            await new Promise<void>((resolve, reject) => server!.releaseName('org.freedesktop.portal.Desktop', (error) => (error ? reject(error) : resolve())));
            await lost;
            expect(provider.preference).toBeUndefined();
            value = 1;
            const recovered = once(provider, 'changed');
            await claim();
            await recovered;
            expect(provider.preference).toBe('dark');
        } finally {
            provider.dispose();
            server?.connection.stream.destroy();
            if (previousAddress === undefined) {
                delete process.env.DBUS_SESSION_BUS_ADDRESS;
            } else {
                process.env.DBUS_SESSION_BUS_ADDRESS = previousAddress;
            }
            const exited = once(daemon, 'exit');
            daemon.kill();
            await exited;
        }
    }, 15000);
});
