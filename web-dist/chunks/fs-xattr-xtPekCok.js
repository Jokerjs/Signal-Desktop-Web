globalThis.process || (globalThis.process = {
	arch: "x64",
	argv: [],
	browser: true,
	config: { variables: {} },
	cwd: function() {
		return "/";
	},
	env: { NODE_ENV: "development" },
	nextTick: function(callback) {
		Promise.resolve().then(callback);
	},
	platform: "browser",
	version: "v22.0.0",
	versions: {
		modules: "0",
		node: "22.0.0",
		uv: "0"
	}
});
if (globalThis.window) {
	globalThis.window.SignalContext = globalThis.window.SignalContext || {};
	globalThis.window.SignalContext.config = globalThis.window.SignalContext.config || {};
	globalThis.window.SignalContext.getPath = globalThis.window.SignalContext.getPath || function() {
		return "/signal-web";
	};
	globalThis.window.SignalContext.i18n = globalThis.window.SignalContext.i18n || function(key) {
		return key;
	};
}
if (!globalThis.Buffer) {
	class BrowserBuffer extends Uint8Array {
		static from(input, encoding) {
			if (typeof input === "string") {
				if (encoding === "base64") return new BrowserBuffer(Uint8Array.from(atob(input), (char) => char.charCodeAt(0)));
				if (encoding === "hex") {
					const bytes = new Uint8Array(input.length / 2);
					for (let index = 0; index < bytes.length; index += 1) bytes[index] = Number.parseInt(input.slice(index * 2, index * 2 + 2), 16);
					return new BrowserBuffer(bytes);
				}
				return new BrowserBuffer(new TextEncoder().encode(input));
			}
			return new BrowserBuffer(input);
		}
		static concat(chunks) {
			const result = new BrowserBuffer(chunks.reduce((total, chunk) => total + chunk.byteLength, 0));
			let offset = 0;
			for (const chunk of chunks) {
				result.set(chunk, offset);
				offset += chunk.byteLength;
			}
			return result;
		}
		static alloc(size, fill) {
			const result = new BrowserBuffer(size);
			if (fill !== void 0) result.fill(fill);
			return result;
		}
		static allocUnsafe(size) {
			return new BrowserBuffer(size);
		}
		static isBuffer(value) {
			return value instanceof Uint8Array;
		}
		toString(encoding) {
			if (encoding === "base64") {
				let binary = "";
				for (const byte of this) binary += String.fromCharCode(byte);
				return btoa(binary);
			}
			if (encoding === "hex") return Array.from(this, (byte) => byte.toString(16).padStart(2, "0")).join("");
			return new TextDecoder().decode(this);
		}
	}
	globalThis.Buffer = BrowserBuffer;
}
import { i as init_nodeGenericShim_dom, r as createRequire } from "../render.bundle.js";
//#region node_modules/.pnpm/fs-xattr@0.4.0_patch_hash=325d1e5f73cce8e15671dbd2394e091aadb71600f41d97d1a8cb63960c188112/node_modules/fs-xattr/index.js
init_nodeGenericShim_dom();
const addon = createRequire(import.meta.url)("./build/Release/xattr");
function validateArgument(key, val) {
	switch (key) {
		case "path":
			if (typeof val === "string") return val;
			throw new TypeError("`path` must be a string");
		case "attr":
			if (typeof val === "string") return val;
			throw new TypeError("`attr` must be a string");
		case "value":
			if (typeof val === "string") return Buffer.from(val);
			if (Buffer.isBuffer(val)) return val;
			throw new TypeError("`value` must be a string or buffer");
		default: throw new Error(`Unknown argument: ${key}`);
	}
}
function setAttribute(path, attr, value) {
	path = validateArgument("path", path);
	attr = validateArgument("attr", attr);
	value = validateArgument("value", value);
	return addon.set(path, attr, value);
}
//#endregion
export { setAttribute };

//# sourceMappingURL=fs-xattr-xtPekCok.js.map