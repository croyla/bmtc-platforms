import { writable } from 'svelte/store';

export const currentSource = writable<string | null>(null);
export const sources = writable<Record<string, string>>({});