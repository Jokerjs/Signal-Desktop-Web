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
import { n as File, t as FormData } from "../render.bundle.js";
//#region node_modules/.pnpm/node-fetch@3.3.2_patch_hash=1dc57b3827aeb8d0a7f3f6c39c51df08119ff45aff99d9a03db2360e99d3a826/node_modules/node-fetch/src/utils/multipart-parser.js
let s = 0;
const S = {
	START_BOUNDARY: s++,
	HEADER_FIELD_START: s++,
	HEADER_FIELD: s++,
	HEADER_VALUE_START: s++,
	HEADER_VALUE: s++,
	HEADER_VALUE_ALMOST_DONE: s++,
	HEADERS_ALMOST_DONE: s++,
	PART_DATA_START: s++,
	PART_DATA: s++,
	END: s++
};
let f = 1;
const F = {
	PART_BOUNDARY: f,
	LAST_BOUNDARY: f *= 2
};
const LF = 10;
const CR = 13;
const SPACE = 32;
const HYPHEN = 45;
const COLON = 58;
const A = 97;
const Z = 122;
const lower = (c) => c | 32;
const noop = () => {};
var MultipartParser = class {
	/**
	* @param {string} boundary
	*/
	constructor(boundary) {
		this.index = 0;
		this.flags = 0;
		this.onHeaderEnd = noop;
		this.onHeaderField = noop;
		this.onHeadersEnd = noop;
		this.onHeaderValue = noop;
		this.onPartBegin = noop;
		this.onPartData = noop;
		this.onPartEnd = noop;
		this.boundaryChars = {};
		boundary = "\r\n--" + boundary;
		const ui8a = new Uint8Array(boundary.length);
		for (let i = 0; i < boundary.length; i++) {
			ui8a[i] = boundary.charCodeAt(i);
			this.boundaryChars[ui8a[i]] = true;
		}
		this.boundary = ui8a;
		this.lookbehind = new Uint8Array(this.boundary.length + 8);
		this.state = S.START_BOUNDARY;
	}
	/**
	* @param {Uint8Array} data
	*/
	write(data) {
		let i = 0;
		const length_ = data.length;
		let previousIndex = this.index;
		let { lookbehind, boundary, boundaryChars, index, state, flags } = this;
		const boundaryLength = this.boundary.length;
		const boundaryEnd = boundaryLength - 1;
		const bufferLength = data.length;
		let c;
		let cl;
		const mark = (name) => {
			this[name + "Mark"] = i;
		};
		const clear = (name) => {
			delete this[name + "Mark"];
		};
		const callback = (callbackSymbol, start, end, ui8a) => {
			if (start === void 0 || start !== end) this[callbackSymbol](ui8a && ui8a.subarray(start, end));
		};
		const dataCallback = (name, clear) => {
			const markSymbol = name + "Mark";
			if (!(markSymbol in this)) return;
			if (clear) {
				callback(name, this[markSymbol], i, data);
				delete this[markSymbol];
			} else {
				callback(name, this[markSymbol], data.length, data);
				this[markSymbol] = 0;
			}
		};
		for (i = 0; i < length_; i++) {
			c = data[i];
			switch (state) {
				case S.START_BOUNDARY:
					if (index === boundary.length - 2) {
						if (c === HYPHEN) flags |= F.LAST_BOUNDARY;
						else if (c !== CR) return;
						index++;
						break;
					} else if (index - 1 === boundary.length - 2) {
						if (flags & F.LAST_BOUNDARY && c === HYPHEN) {
							state = S.END;
							flags = 0;
						} else if (!(flags & F.LAST_BOUNDARY) && c === LF) {
							index = 0;
							callback("onPartBegin");
							state = S.HEADER_FIELD_START;
						} else return;
						break;
					}
					if (c !== boundary[index + 2]) index = -2;
					if (c === boundary[index + 2]) index++;
					break;
				case S.HEADER_FIELD_START:
					state = S.HEADER_FIELD;
					mark("onHeaderField");
					index = 0;
				case S.HEADER_FIELD:
					if (c === CR) {
						clear("onHeaderField");
						state = S.HEADERS_ALMOST_DONE;
						break;
					}
					index++;
					if (c === HYPHEN) break;
					if (c === COLON) {
						if (index === 1) return;
						dataCallback("onHeaderField", true);
						state = S.HEADER_VALUE_START;
						break;
					}
					cl = lower(c);
					if (cl < A || cl > Z) return;
					break;
				case S.HEADER_VALUE_START:
					if (c === SPACE) break;
					mark("onHeaderValue");
					state = S.HEADER_VALUE;
				case S.HEADER_VALUE:
					if (c === CR) {
						dataCallback("onHeaderValue", true);
						callback("onHeaderEnd");
						state = S.HEADER_VALUE_ALMOST_DONE;
					}
					break;
				case S.HEADER_VALUE_ALMOST_DONE:
					if (c !== LF) return;
					state = S.HEADER_FIELD_START;
					break;
				case S.HEADERS_ALMOST_DONE:
					if (c !== LF) return;
					callback("onHeadersEnd");
					state = S.PART_DATA_START;
					break;
				case S.PART_DATA_START:
					state = S.PART_DATA;
					mark("onPartData");
				case S.PART_DATA:
					previousIndex = index;
					if (index === 0) {
						i += boundaryEnd;
						while (i < bufferLength && !(data[i] in boundaryChars)) i += boundaryLength;
						i -= boundaryEnd;
						c = data[i];
					}
					if (index < boundary.length) if (boundary[index] === c) {
						if (index === 0) dataCallback("onPartData", true);
						index++;
					} else index = 0;
					else if (index === boundary.length) {
						index++;
						if (c === CR) flags |= F.PART_BOUNDARY;
						else if (c === HYPHEN) flags |= F.LAST_BOUNDARY;
						else index = 0;
					} else if (index - 1 === boundary.length) if (flags & F.PART_BOUNDARY) {
						index = 0;
						if (c === LF) {
							flags &= ~F.PART_BOUNDARY;
							callback("onPartEnd");
							callback("onPartBegin");
							state = S.HEADER_FIELD_START;
							break;
						}
					} else if (flags & F.LAST_BOUNDARY) if (c === HYPHEN) {
						callback("onPartEnd");
						state = S.END;
						flags = 0;
					} else index = 0;
					else index = 0;
					if (index > 0) lookbehind[index - 1] = c;
					else if (previousIndex > 0) {
						const _lookbehind = new Uint8Array(lookbehind.buffer, lookbehind.byteOffset, lookbehind.byteLength);
						callback("onPartData", 0, previousIndex, _lookbehind);
						previousIndex = 0;
						mark("onPartData");
						i--;
					}
					break;
				case S.END: break;
				default: throw new Error(`Unexpected state entered: ${state}`);
			}
		}
		dataCallback("onHeaderField");
		dataCallback("onHeaderValue");
		dataCallback("onPartData");
		this.index = index;
		this.state = state;
		this.flags = flags;
	}
	end() {
		if (this.state === S.HEADER_FIELD_START && this.index === 0 || this.state === S.PART_DATA && this.index === this.boundary.length) this.onPartEnd();
		else if (this.state !== S.END) throw new Error("MultipartParser.end(): stream ended unexpectedly");
	}
};
function _fileName(headerValue) {
	const m = headerValue.match(/\bfilename=("(.*?)"|([^()<>@,;:\\"/[\]?={}\s\t]+))($|;\s)/i);
	if (!m) return;
	const match = m[2] || m[3] || "";
	let filename = match.slice(match.lastIndexOf("\\") + 1);
	filename = filename.replace(/%22/g, "\"");
	filename = filename.replace(/&#(\d{4});/g, (m, code) => {
		return String.fromCharCode(code);
	});
	return filename;
}
async function toFormData(Body, ct) {
	if (!/multipart/i.test(ct)) throw new TypeError("Failed to fetch");
	const m = ct.match(/boundary=(?:"([^"]+)"|([^;]+))/i);
	if (!m) throw new TypeError("no or bad content-type header, no multipart boundary");
	const parser = new MultipartParser(m[1] || m[2]);
	let headerField;
	let headerValue;
	let entryValue;
	let entryName;
	let contentType;
	let filename;
	const entryChunks = [];
	const formData = new FormData();
	const onPartData = (ui8a) => {
		entryValue += decoder.decode(ui8a, { stream: true });
	};
	const appendToFile = (ui8a) => {
		entryChunks.push(ui8a);
	};
	const appendFileToFormData = () => {
		const file = new File(entryChunks, filename, { type: contentType });
		formData.append(entryName, file);
	};
	const appendEntryToFormData = () => {
		formData.append(entryName, entryValue);
	};
	const decoder = new TextDecoder("utf-8");
	decoder.decode();
	parser.onPartBegin = function() {
		parser.onPartData = onPartData;
		parser.onPartEnd = appendEntryToFormData;
		headerField = "";
		headerValue = "";
		entryValue = "";
		entryName = "";
		contentType = "";
		filename = null;
		entryChunks.length = 0;
	};
	parser.onHeaderField = function(ui8a) {
		headerField += decoder.decode(ui8a, { stream: true });
	};
	parser.onHeaderValue = function(ui8a) {
		headerValue += decoder.decode(ui8a, { stream: true });
	};
	parser.onHeaderEnd = function() {
		headerValue += decoder.decode();
		headerField = headerField.toLowerCase();
		if (headerField === "content-disposition") {
			const m = headerValue.match(/\bname=("([^"]*)"|([^()<>@,;:\\"/[\]?={}\s\t]+))/i);
			if (m) entryName = m[2] || m[3] || "";
			filename = _fileName(headerValue);
			if (filename) {
				parser.onPartData = appendToFile;
				parser.onPartEnd = appendFileToFormData;
			}
		} else if (headerField === "content-type") contentType = headerValue;
		headerValue = "";
		headerField = "";
	};
	for await (const chunk of Body) parser.write(chunk);
	parser.end();
	return formData;
}
//#endregion
export { toFormData };

//# sourceMappingURL=multipart-parser-0QJ3X1J9.js.map