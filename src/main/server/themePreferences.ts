// Copyright (c) 2016-present Mattermost, Inc. All Rights Reserved.
// See LICENSE.txt for license information.

import {net, session} from 'electron';

import {COOKIE_NAME_CSRF} from 'common/constants';

export type ThemePreference = {user_id: string; category: string; name: string; value: string};

export class PreferenceRequestError extends Error {
    constructor(public status?: number) {
        super(status ? `Preference request failed (${status})` : 'Preference network request failed');
    }

    get retryable() {
        return this.status === undefined || this.status >= 500;
    }
}

// Resolve relative to the configured workspace path, including installations under a subpath.
export function preferenceURL(serverURL: URL, endpoint: string) {
    const base = new URL(serverURL.toString());
    base.pathname = `${base.pathname.replace(/\/$/, '')}/api/v4/`;
    base.search = '';
    base.hash = '';
    return new URL(endpoint, base);
}

export async function requestPreferences<T>(url: URL, preferences?: ThemePreference[]): Promise<T> {
    const cookies = await session.defaultSession.cookies.get({url: url.toString()});
    const csrf = cookies.find((cookie) => cookie.name === COOKIE_NAME_CSRF);
    return new Promise((resolve, reject) => {
        const req = net.request({url: url.toString(), method: preferences ? 'PUT' : 'GET', session: session.defaultSession, useSessionCookies: true});
        const timer = setTimeout(() => {
            reject(new PreferenceRequestError());
            req.abort();
        }, 30000);
        const fail = (status?: number) => {
            clearTimeout(timer);
            reject(new PreferenceRequestError(status));
        };
        req.on('error', () => fail());
        req.on('response', (response) => {
            let raw = '';
            response.on('error', () => fail());
            response.on('data', (chunk) => {
                raw += chunk.toString();
            });
            response.on('end', () => {
                clearTimeout(timer);
                if (response.statusCode < 200 || response.statusCode >= 300) {
                    fail(response.statusCode);
                    return;
                }
                try {
                    resolve(JSON.parse(raw));
                } catch {
                    fail(400);
                }
            });
        });
        if (csrf) {
            req.setHeader('X-CSRF-Token', csrf.value);
        }
        if (preferences) {
            req.setHeader('Content-Type', 'application/json');
            req.write(JSON.stringify(preferences));
        }
        req.end();
    });
}

export function saveThemePreferences(url: URL, preferences: ThemePreference[]) {
    return requestPreferences(url, preferences);
}
