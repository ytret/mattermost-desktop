// Copyright (c) 2016-present Mattermost, Inc. All Rights Reserved.
// See LICENSE.txt for license information.

import {createConnection} from 'net';

import * as dbus from '@homebridge/dbus-native';
import {EventEmitter} from 'events';

export type SystemTheme = 'light' | 'dark' | undefined;
type Message = {type?: number; sender?: string; path?: string; interface?: string; member?: string; signature?: string; destination?: string; body?: unknown[]};
type Reply = (error?: {name: string}, value?: unknown) => void;
export type ThemeBus = {
    connection: EventEmitter & {stream: EventEmitter & {destroy: () => void}};
    invoke: (message: Message, callback: Reply) => void;
};

const service = 'org.freedesktop.portal.Desktop';
const path = '/org/freedesktop/portal/desktop';
const settings = 'org.freedesktop.portal.Settings';
const namespace = 'org.freedesktop.appearance';
const key = 'color-scheme';
const daemon = 'org.freedesktop.DBus';
export const lookupTimeout = 2000;

// dbus-native decodes variants as [signature tree, [value]]. Read adds
// another variant around the value; ReadOne and SettingChanged do not.
export function decodePreference(encoded: unknown): SystemTheme {
    let value = encoded;
    for (let depth = 0; depth < 4 && Array.isArray(value) && value.length === 2; depth++) {
        const [signature, contents] = value;
        const type = typeof signature === 'string' ? signature : signature?.[0]?.type;
        if (type !== 'v' && type !== 'u') {
            return undefined;
        }
        value = Array.isArray(contents) && contents.length === 1 ? contents[0] : contents;
    }
    if (value === 1) {
        return 'dark';
    }
    return value === 2 ? 'light' : undefined;
}

function sessionBus(): ThemeBus {
    // Electron's Node supports abstract Unix sockets directly. Avoid the client's
    // optional native abstract-socket dependency so the client is fully bundled.
    const address = process.env.DBUS_SESSION_BUS_ADDRESS;
    const params = address?.startsWith('unix:') ? new URLSearchParams(address.slice(5).split(';')[0].replaceAll(',', '&')) : undefined;
    const abstract = params?.get('abstract');
    const client = dbus as unknown as {sessionBus: (options?: {stream: ReturnType<typeof createConnection>}) => ThemeBus};
    return client.sessionBus(abstract ? {stream: createConnection({path: `\0${abstract}`})} : undefined);
}

export class LinuxSystemTheme extends EventEmitter {
    preference: SystemTheme;
    private initialized?: Promise<void>;
    private finishInitial?: () => void;
    private bus?: ThemeBus;
    private cleanup?: () => void;
    private timer?: NodeJS.Timeout;
    private retry?: NodeJS.Timeout;
    private attempt = 0;
    private epoch = 0;
    private revision = 0;
    private stopped = true;

    constructor(private connect: () => ThemeBus = sessionBus) {
        super();
    }

    init = (): Promise<void> => {
        if (this.initialized) {
            return this.initialized;
        }
        this.stopped = false;
        this.initialized = new Promise((resolve) => {
            this.finishInitial = resolve;
        });
        this.open();
        return this.initialized;
    };

    private settle = () => {
        this.finishInitial?.();
        this.finishInitial = undefined;
    };

    private setPreference = (value: SystemTheme) => {
        if (value !== this.preference) {
            this.preference = value;
            this.emit('changed', value);
        }
    };

    private open = () => {
        if (this.stopped) {
            return;
        }
        const epoch = ++this.epoch;
        const current = () => !this.stopped && epoch === this.epoch;
        this.timer = setTimeout(() => {
            if (current()) {
                this.failed();
            }
        }, lookupTimeout);
        try {
            const bus = this.connect();
            this.bus = bus;
            let owner: string | undefined;
            const read = () => {
                const revision = this.revision;
                const invoke = (member: string) => bus.invoke({destination: service, path, interface: settings, member, signature: 'ss', body: [namespace, key]}, (error, value) => {
                    if (!current() || revision !== this.revision) {
                        return;
                    }
                    if (error?.name === 'org.freedesktop.DBus.Error.UnknownMethod' && member === 'ReadOne') {
                        invoke('Read');
                        return;
                    }
                    if (error) {
                        this.failed();
                        return;
                    }
                    clearTimeout(this.timer);
                    this.timer = undefined;
                    this.attempt = 0;
                    this.setPreference(decodePreference(value));
                    this.settle();
                });
                invoke('ReadOne');
            };
            const message = (msg: Message) => {
                if (!current() || msg.type !== 4) {
                    return;
                }
                if (msg.sender === daemon && msg.interface === daemon && msg.member === 'NameOwnerChanged' && msg.body?.[0] === service) {
                    // Rebuild subscriptions and invalidate reads from the former owner.
                    this.failed();
                } else if (owner && msg.sender === owner && msg.path === path && msg.interface === settings && msg.member === 'SettingChanged' && msg.body?.[0] === namespace && msg.body?.[1] === key) {
                    this.revision++;
                    clearTimeout(this.timer);
                    this.timer = undefined;
                    this.attempt = 0;
                    this.setPreference(decodePreference(msg.body[2]));
                    this.settle();
                }
            };
            const failed = () => {
                if (current()) {
                    this.failed();
                }
            };
            bus.connection.on('message', message);
            bus.connection.on('error', failed);
            bus.connection.on('end', failed);
            bus.connection.stream.on('close', failed);
            this.cleanup = () => {
                bus.connection.removeListener('message', message);
                bus.connection.removeListener('error', failed);
                bus.connection.removeListener('end', failed);
                bus.connection.stream.removeListener('close', failed);
            };
            const match = (rule: string, next: () => void) => bus.invoke({destination: daemon, path: '/org/freedesktop/DBus', interface: daemon, member: 'AddMatch', signature: 's', body: [rule]}, (error) => {
                if (current()) {
                    if (error) {
                        this.failed();
                    } else {
                        next();
                    }
                }
            });
            match(`type='signal',sender='${daemon}',interface='${daemon}',member='NameOwnerChanged',arg0='${service}'`, () => {
                match(`type='signal',sender='${service}',path='${path}',interface='${settings}',member='SettingChanged'`, () => {
                    bus.invoke({destination: daemon, path: '/org/freedesktop/DBus', interface: daemon, member: 'GetNameOwner', signature: 's', body: [service]}, (error, value) => {
                        if (!current()) {
                            return;
                        }
                        if (!error && typeof value === 'string') {
                            owner = value;
                        }

                        // Read can activate an installed portal which has not started yet.
                        read();
                    });
                });
            });
        } catch {
            this.failed();
        }
    };

    private close = () => {
        this.epoch++;
        clearTimeout(this.timer);
        this.timer = undefined;

        // Destroy the private connection, releasing all bus match rules as well.
        this.bus?.connection.stream.destroy();
        this.cleanup?.();
        this.cleanup = undefined;
        this.bus = undefined;
    };

    private failed = () => {
        this.close();
        this.setPreference(undefined);
        this.settle();
        clearTimeout(this.retry);
        if (!this.stopped) {
            this.retry = setTimeout(this.open, Math.min(1000 * (2 ** Math.min(this.attempt++, 5)), 30000));
        }
    };

    dispose = () => {
        this.stopped = true;
        clearTimeout(this.retry);
        this.retry = undefined;
        this.close();
        this.settle();
        this.initialized = undefined;
        this.attempt = 0;
        this.setPreference(undefined);
    };
}

const linuxSystemTheme = new LinuxSystemTheme();
export default linuxSystemTheme;
