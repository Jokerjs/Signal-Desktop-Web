// Copyright 2026 Signal Messenger, LLC
// SPDX-License-Identifier: AGPL-3.0-only

type Listener = (...args: ReadonlyArray<unknown>) => void;

export class EventEmitter {
  #listeners = new Map<string | symbol, Set<Listener>>();

  on(eventName: string | symbol, listener: Listener): this {
    this.#get(eventName).add(listener);
    return this;
  }

  off(eventName: string | symbol, listener: Listener): this {
    this.#get(eventName).delete(listener);
    return this;
  }

  once(eventName: string | symbol, listener: Listener): this {
    const wrapped: Listener = (...args) => {
      this.off(eventName, wrapped);
      listener(...args);
    };
    return this.on(eventName, wrapped);
  }

  emit(eventName: string | symbol, ...args: ReadonlyArray<unknown>): boolean {
    const eventListeners = this.#listeners.get(eventName);
    if (!eventListeners?.size) {
      return false;
    }
    for (const listener of [...eventListeners]) {
      listener(...args);
    }
    return true;
  }

  removeListener(eventName: string | symbol, listener: Listener): this {
    return this.off(eventName, listener);
  }

  removeAllListeners(eventName?: string | symbol): this {
    if (eventName == null) {
      this.#listeners.clear();
    } else {
      this.#listeners.delete(eventName);
    }
    return this;
  }

  #get(eventName: string | symbol): Set<Listener> {
    let eventListeners = this.#listeners.get(eventName);
    if (!eventListeners) {
      eventListeners = new Set();
      this.#listeners.set(eventName, eventListeners);
    }
    return eventListeners;
  }
}

export { EventEmitter as default };
